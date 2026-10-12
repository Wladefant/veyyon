import { describe, expect, it } from "bun:test";
import { normalizeTools } from "@veyyon/agent-core/agent-loop";
import type { ToolCall, TSchema } from "@veyyon/ai";
import {
	adaptSchemaForStrict,
	jsonSchemaToTypeScript,
	toolWireSchema,
	validateJsonSchemaValue,
	validateStrictSchemaEnforcement,
} from "@veyyon/ai/utils/schema";
import { validateToolCall } from "@veyyon/ai/utils/validation";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { type BrowserParams, BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { getTab } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import { INTENT_FIELD } from "@veyyon/wire";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}
describe("browser tool schema", () => {
	it("rejects run calls without code during execution", async () => {
		const tool = new BrowserTool(makeSession());
		const args: BrowserParams = { action: "run", name: "x" };
		const call: ToolCall = {
			type: "toolCall",
			id: "browser-run-without-code",
			name: "browser",
			arguments: args,
		};

		expect(validateJsonSchemaValue(toolWireSchema(tool), call.arguments).success).toBe(true);
		expect(validateToolCall([tool], call)).toEqual(call.arguments);
		await expect(tool.execute("browser-run-without-code", args)).rejects.toThrow(
			/Missing required parameter 'code' for action 'run'/,
		);
	});

	it("accepts run calls with code at schema validation", () => {
		const tool = new BrowserTool(makeSession());
		const call: ToolCall = {
			type: "toolCall",
			id: "browser-run-with-code",
			name: "browser",
			arguments: { action: "run", name: "x", code: "return document.title;" },
		};

		expect(validateJsonSchemaValue(toolWireSchema(tool), call.arguments).success).toBe(true);
		expect(validateToolCall([tool], call)).toEqual(call.arguments);
	});

	it("accepts save_state and context parameters at schema validation", () => {
		const tool = new BrowserTool(makeSession());
		const openCall: ToolCall = {
			type: "toolCall",
			id: "browser-open-context",
			name: "browser",
			arguments: { action: "open", name: "user-a", context: "tenant-a", storage_state: "./auth.json" },
		};
		expect(validateJsonSchemaValue(toolWireSchema(tool), openCall.arguments).success).toBe(true);
		expect(validateToolCall([tool], openCall)).toEqual(openCall.arguments);

		const saveCall: ToolCall = {
			type: "toolCall",
			id: "browser-save-state",
			name: "browser",
			arguments: { action: "save_state", name: "user-a", storage_state: "./auth.json" },
		};
		expect(validateJsonSchemaValue(toolWireSchema(tool), saveCall.arguments).success).toBe(true);
		expect(validateToolCall([tool], saveCall)).toEqual(saveCall.arguments);
	});

	it("exposes extension, instance, instance_id, and profile in served model schema", () => {
		const tool = new BrowserTool(makeSession());
		const wire = toolWireSchema(tool);
		const appProps = (wire.properties as Record<string, any>)?.app?.properties;
		expect(appProps?.extension?.type).toBe("boolean");
		expect(appProps?.instance?.type).toBe("string");
		expect(appProps?.instance_id?.type).toBe("string");
		expect(appProps?.profile?.type).toBe("string");

		const tsSignature = jsonSchemaToTypeScript(wire);
		expect(tsSignature).toContain("extension?: boolean;");
		expect(tsSignature).toContain("instance?: string;");
		expect(tsSignature).toContain("instance_id?: string;");
		expect(tsSignature).toContain("profile?: string;");

		const extCall: ToolCall = {
			type: "toolCall",
			id: "browser-open-extension",
			name: "browser",
			arguments: {
				action: "open",
				name: "operator-chrome",
				app: { extension: true, instance: "work", profile: "Default" },
			},
		};
		expect(validateJsonSchemaValue(wire, extCall.arguments).success).toBe(true);
		expect(validateToolCall([tool], extCall)).toEqual(extCall.arguments);
	});

	it("fails fast with setup instructions when extension requested without a token and never launches headless", async () => {
		const tool = new BrowserTool(makeSession());
		const args: BrowserParams = {
			action: "open",
			name: "ext-probe",
			app: { extension: true },
			url: "https://example.com",
		};
		const call: ToolCall = {
			type: "toolCall",
			id: "browser-open-ext-no-token",
			name: "browser",
			arguments: args,
		};
		expect(validateToolCall([tool], call)).toEqual(args);

		await expect(tool.execute("browser-open-ext-no-token", args)).rejects.toThrow(
			/No extension token is stored.*Install the Playwright Extension/,
		);
		// Proof: no tab was opened or registered on any headless browser
		expect(getTab("ext-probe")).toBeUndefined();
	});

	it("rejects unsupported extension parameters when extension is not enabled rather than falling back to headless", async () => {
		const tool = new BrowserTool(makeSession());
		const args: BrowserParams = {
			action: "open",
			name: "unsupported-ext-probe",
			app: { instance: "work" },
			url: "https://example.com",
		};

		await expect(tool.execute("browser-open-unsupported-ext", args)).rejects.toThrow(
			/app\.instance, app\.instance_id, and app\.profile require app\.extension: true\./,
		);
		expect(getTab("unsupported-ext-probe")).toBeUndefined();
	});

	it("rejects app.extension combined with path or cdp_url", async () => {
		const tool = new BrowserTool(makeSession());
		const argsWithCdp: BrowserParams = {
			action: "open",
			name: "ext-cdp-conflict",
			app: { extension: true, cdp_url: "http://127.0.0.1:9222" },
		};
		await expect(tool.execute("browser-open-cdp-conflict", argsWithCdp)).rejects.toThrow(
			/app\.extension cannot be combined with app\.cdp_url or app\.path\./,
		);

		const argsWithPath: BrowserParams = {
			action: "open",
			name: "ext-path-conflict",
			app: { extension: true, path: "/usr/bin/google-chrome" },
		};
		await expect(tool.execute("browser-open-path-conflict", argsWithPath)).rejects.toThrow(
			/app\.extension cannot be combined with app\.cdp_url or app\.path\./,
		);
	});

	// Reproduces the regression the Codex review flagged on #3647: with default
	// `tools.intentTracing`, normalizeTools must keep the closed action variants
	// satisfiable for inputs that carry the injected `i` field. The earlier
	// version of injectIntentIntoSchema appended a root sibling
	// `properties: { i }, required: [i]` next to the closed `anyOf` branches,
	// which collided with each branch's `additionalProperties: false` and made
	// every input fail validation.
	it("keeps intent tracing satisfiable across action variants", () => {
		const normalized = normalizeTools([new BrowserTool(makeSession())], true)?.[0];
		const schema = normalized?.parameters as TSchema;

		expect(validateJsonSchemaValue(schema, { action: "run", name: "x" }).success).toBe(false);
		expect(
			validateJsonSchemaValue(schema, {
				[INTENT_FIELD]: "Inspecting page state",
				action: "run",
				name: "x",
				code: "return document.title;",
			}).success,
		).toBe(true);
		expect(
			validateJsonSchemaValue(schema, {
				[INTENT_FIELD]: "Opening docs tab",
				action: "open",
				name: "docs",
				url: "https://example.com",
			}).success,
		).toBe(true);
	});

	// Each branch is closed (`additionalProperties: false`) and intent
	// injection now lands inside every branch's `properties`/`required`, so
	// `enforceStrictSchema` keeps strict mode on and the result remains free of
	// strict-mode violations. Without the union-aware injection fix, the
	// post-injection schema would either lose strict (no satisfiable input) or
	// trip the additionalProperties / properties-coverage strict rules.
	it("survives OpenAI strict-mode enforcement after intent injection", () => {
		const normalized = normalizeTools([new BrowserTool(makeSession())], true)?.[0];
		const schema = normalized?.parameters as Record<string, unknown>;
		const strict = adaptSchemaForStrict(schema, true);

		expect(strict.strict).toBe(true);
		const enforcement = validateStrictSchemaEnforcement(schema, strict);
		expect(enforcement.compatible).toBe(true);
		expect(enforcement.violations).toEqual([]);

		// And the post-strict schema is still satisfiable for a real run call.
		expect(
			validateJsonSchemaValue(strict.schema, {
				[INTENT_FIELD]: "Reading page DOM",
				action: "run",
				name: "docs",
				url: null,
				context: null,
				storage_state: null,
				app: null,
				viewport: null,
				wait_until: null,
				dialogs: null,
				code: "return 1;",
				timeout: null,
				all: null,
				kill: null,
			}).success,
		).toBe(true);
	});
});
