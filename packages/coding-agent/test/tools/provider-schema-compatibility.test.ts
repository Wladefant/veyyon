import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertTools } from "@veyyon/ai/providers/google-shared";
import {
	adaptSchemaForStrict,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	type SchemaCompatibilityProvider,
	type SchemaCompatibilityResult,
	toolWireSchema,
	validateSchemaCompatibility,
	validateStrictSchemaEnforcement,
} from "@veyyon/ai/utils/schema";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, HIDDEN_TOOLS, type Tool, type ToolSession } from "@veyyon/coding-agent/tools";
import { createVibeTools } from "@veyyon/coding-agent/tools/agent/vibe";
import { isRecord } from "@veyyon/utils";
import { SecretRequestTool } from "../../src/tools/agent/secret-request";
import { GithubTool } from "../../src/tools/web/gh";
import { visitEveryFirstPartyTool } from "../helpers/every-first-party-tool";

interface ToolSchemaEntry {
	name: string;
	schema: Record<string, unknown>;
}

function createTestSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		// `browser` and `lsp` ship off, so the default settings would drop them from
		// `createTools` and silently shrink the surface this suite checks. Provider
		// schema compatibility is a property of the tool, not of whether it is on by
		// default, so the fixture turns both on to keep them covered.
		settings: Settings.isolated({ "browser.enabled": true, "lsp.enabled": true }),
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function assertCanonicalSearchSchema(schema: Record<string, unknown>, provider: string): void {
	expect(schema.type, provider).toBe("object");
	const required = schema.required as string[] | undefined;
	expect(required?.slice(0, 2), provider).toEqual(["type", "input"]);
	const properties = schema.properties as Record<string, Record<string, unknown>>;
	expect(Object.keys(properties).slice(0, 2), provider).toEqual(["type", "input"]);
	// ArkType emits an enum's members sorted, whatever order `SEARCH_TYPES` lists them in.
	expect(properties.type?.enum, provider).toEqual(["files", "structure", "text"]);
	expect(properties.input?.type, provider).toBe("string");
}

async function collectToolSchemas(): Promise<ToolSchemaEntry[]> {
	const session = createTestSession();
	const byToolName = new Map<string, Record<string, unknown>>();

	for (const tool of await createTools(session)) {
		const schema = toolWireSchema(tool);
		if (!asSchemaObject(schema)) {
			continue;
		}
		byToolName.set(tool.name, schema);
	}

	for (const [name, factory] of Object.entries(HIDDEN_TOOLS)) {
		const tool = await factory(session);
		if (!tool) {
			continue;
		}
		const schema = toolWireSchema(tool);
		if (!asSchemaObject(schema)) {
			continue;
		}
		byToolName.set(name, schema);
	}

	for (const tool of createVibeTools(session)) {
		const schema = toolWireSchema(tool);
		if (!asSchemaObject(schema)) {
			continue;
		}
		byToolName.set(tool.name, schema);
	}

	return [...byToolName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, schema]) => ({ name, schema }));
}

function formatCompatibilityIssues(
	toolName: string,
	provider: SchemaCompatibilityProvider,
	result: SchemaCompatibilityResult,
): string {
	if (result.compatible) {
		return "";
	}
	const details = result.violations
		.map(violation => `  - ${violation.rule} at ${violation.path}: ${violation.message}`)
		.join("\n");
	return `${toolName} (${provider}):\n${details}`;
}

function findUnsupportedGeminiArrayKeywords(value: unknown, at: string, failures: string[]): void {
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			findUnsupportedGeminiArrayKeywords(item, `${at}/${index}`, failures);
		}
		return;
	}
	if (!isRecord(value)) return;
	for (const key of ["uniqueItems", "contains", "minContains", "maxContains"]) {
		if (Object.hasOwn(value, key)) failures.push(`${at}/${key}`);
	}
	for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
		const map = value[key];
		if (!isRecord(map)) continue;
		for (const [name, schema] of Object.entries(map)) {
			findUnsupportedGeminiArrayKeywords(schema, `${at}/${key}/${name}`, failures);
		}
	}
	for (const key of ["items", "prefixItems", "anyOf", "oneOf", "allOf", "not", "if", "then", "else"]) {
		findUnsupportedGeminiArrayKeywords(value[key], `${at}/${key}`, failures);
	}
}

describe("builtin tool schemas provider compatibility", () => {
	it("keeps unsupported array keywords out of every first-party Gemini declaration", async () => {
		const model = buildModel({
			id: "gemini-4-hydrogen",
			name: "Gemini 4 Hydrogen",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		});
		const failures: string[] = [];
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-tool-schema-"));
		try {
			const check = (tool: Tool) => {
				const declaration = convertTools([tool], model)?.[0]?.functionDeclarations[0];
				if (!isRecord(declaration?.parametersJsonSchema)) {
					failures.push(`${tool.name}: missing parametersJsonSchema`);
					return;
				}
				findUnsupportedGeminiArrayKeywords(declaration.parametersJsonSchema, tool.name, failures);
			};
			const unbuilt = await visitEveryFirstPartyTool(dir, check);
			// These factories require local capabilities the test runner may not have.
			// Their real constructors provide the same schemas without invoking the tools.
			for (const name of unbuilt) {
				if (name === "github") check(new GithubTool(createTestSession()));
				else if (name === "secret_request") check(new SecretRequestTool(createTestSession()));
				else failures.push(`${name}: factory returned no tool`);
			}
			expect(failures).toEqual([]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps task and todo strict-compatible for OpenAI-style providers", async () => {
		const toolSchemas = await collectToolSchemas();
		for (const toolName of ["task", "todo"]) {
			const entry = toolSchemas.find(tool => tool.name === toolName);
			expect(entry).toBeDefined();
			if (!entry) {
				continue;
			}
			const strictResult = adaptSchemaForStrict(entry.schema, true);
			expect(strictResult.strict).toBe(true);
		}
	});

	it("keeps all builtin and hidden tool schemas valid after provider enforcement", async () => {
		const toolSchemas = await collectToolSchemas();
		const failures: string[] = [];

		for (const { name, schema } of toolSchemas) {
			const strictResult = adaptSchemaForStrict(schema, true);
			const strictCompatibility = validateStrictSchemaEnforcement(schema, strictResult);
			if (!strictCompatibility.compatible) {
				failures.push(formatCompatibilityIssues(name, "openai-strict", strictCompatibility));
			}

			try {
				const googleSchema = normalizeSchemaForGoogle(schema);
				const googleCompatibility = validateSchemaCompatibility(googleSchema, "google");
				if (!googleCompatibility.compatible) {
					failures.push(formatCompatibilityIssues(name, "google", googleCompatibility));
				}
			} catch (error) {
				failures.push(`${name} (google): normalizeSchemaForGoogle threw: ${String(error)}`);
			}

			const cloudCodeAssistSchema = normalizeSchemaForCCA(schema);
			const cloudCodeAssistCompatibility = validateSchemaCompatibility(
				cloudCodeAssistSchema,
				"cloud-code-assist-claude",
			);
			if (!cloudCodeAssistCompatibility.compatible) {
				failures.push(formatCompatibilityIssues(name, "cloud-code-assist-claude", cloudCodeAssistCompatibility));
			}
		}

		if (failures.length > 0) {
			throw new Error(`Provider compatibility failures:\n\n${failures.join("\n\n")}`);
		}

		expect(failures).toEqual([]);
	});

	it("preserves the yield result schema for Cloud Code Assist", async () => {
		const toolSchemas = await collectToolSchemas();
		const yieldEntry = toolSchemas.find(tool => tool.name === "yield");
		expect(yieldEntry).toBeDefined();
		if (!yieldEntry) return;

		const normalized = asSchemaObject(normalizeSchemaForCCA(yieldEntry.schema));
		const properties = asSchemaObject(normalized?.properties);
		const typeSchema = asSchemaObject(properties?.type);

		expect(normalized?.type).toBe("object");
		expect(properties?.result).toBeDefined();
		expect(typeSchema?.type).toBe("string");
		expect(typeSchema?.anyOf).toBeUndefined();
	});

	it("asserts that browser tool schema root has 'type: \"object\"' for Codex and OpenAI Responses compatibility", async () => {
		const toolSchemas = await collectToolSchemas();
		const browserEntry = toolSchemas.find(tool => tool.name === "browser");
		expect(browserEntry).toBeDefined();
		expect(browserEntry?.schema.type).toBe("object");
	});

	it("preserves canonical search order and discriminator through every provider normalization", async () => {
		const toolSchemas = await collectToolSchemas();
		const searchEntry = toolSchemas.find(tool => tool.name === "search");
		expect(searchEntry).toBeDefined();
		if (!searchEntry) return;

		const googleSchema = normalizeSchemaForGoogle(searchEntry.schema);
		const cloudCodeAssistSchema = normalizeSchemaForCCA(searchEntry.schema);
		if (!isRecord(googleSchema) || !isRecord(cloudCodeAssistSchema)) {
			throw new Error("Search schema normalization must produce object schemas");
		}

		const variants: Array<[string, Record<string, unknown>]> = [
			["wire", searchEntry.schema],
			["openai-strict", adaptSchemaForStrict(searchEntry.schema, true).schema],
			["google", googleSchema],
			["cloud-code-assist", cloudCodeAssistSchema],
		];
		for (const [provider, schema] of variants) {
			assertCanonicalSearchSchema(schema, provider);
		}
	});
});
