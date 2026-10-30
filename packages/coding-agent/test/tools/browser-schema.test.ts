import { describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { normalizeTools } from "@veyyon/agent-core/tool-normalization";
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
import * as browserRegistry from "@veyyon/coding-agent/tools/web/browser/registry";
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

	it("serves only supported browser actions and app fields", () => {
		const tool = new BrowserTool(makeSession());
		const wire = toolWireSchema(tool);
		const app = (wire.properties as Record<string, { properties?: Record<string, unknown> }>).app;
		expect(Object.keys(app.properties ?? {}).sort()).toEqual(["args", "cdp_url", "path", "target"]);
		expect(validateJsonSchemaValue(wire, { action: "unsupported" }).success).toBe(false);
		expect(() =>
			validateToolCall([tool], {
				type: "toolCall",
				id: "browser-obsolete-only-app",
				name: "browser",
				arguments: { action: "open", name: "obsolete-only", app: { obsolete: true } },
			}),
		).toThrow();
		expect(
			validateToolCall([tool], {
				type: "toolCall",
				id: "browser-valid-path-with-unknown-field",
				name: "browser",
				arguments: {
					action: "open",
					name: "known-route",
					app: { path: "/valid/app", unexpected: true },
				},
			}),
		).toEqual({
			action: "open",
			name: "known-route",
			app: { path: "/valid/app" },
		});
		expect(validateJsonSchemaValue(wire, { action: "open", name: "headless", app: { path: "/usr/bin/chromium" } }).success).toBe(true);
		expect(validateJsonSchemaValue(wire, { action: "open", name: "cdp", app: { cdp_url: "http://127.0.0.1:9222" } }).success).toBe(true);
	});

	it("rejects a direct open call without a supported app route before launching", async () => {
		const tool = new BrowserTool(makeSession());
		const args: BrowserParams = { action: "open", name: "missing-app-route", app: {} };

		await expect(tool.execute("browser-open-missing-route", args)).rejects.toThrow(/app requires.*path.*cdp_url/i);
		expect(getTab("missing-app-route")).toBeUndefined();
	});

	it("routes a validated path open to the named app without headless fallback", async () => {
		const tool = new BrowserTool(makeSession());
		const args = validateToolCall([tool], {
			type: "toolCall",
			id: "browser-valid-path-with-unknown-fields",
			name: "browser",
			arguments: {
				action: "open",
				name: "known-route",
				app: { path: "/valid/app", extension: true, unexpected: true },
			},
		});
		expect(args).toEqual({
			action: "open",
			name: "known-route",
			app: { path: "/valid/app" },
		});
		const acquireBrowser = spyOn(browserRegistry, "acquireBrowser").mockImplementation(async kind => {
			throw new Error(`Cannot launch ${kind.kind} browser ${kind.kind === "spawned" ? kind.path : ""}`);
		});
		try {
			await expect(tool.execute("browser-valid-path", args as BrowserParams)).rejects.toThrow(
				`Cannot launch spawned browser ${path.resolve("/valid/app")}`,
			);
		} finally {
			acquireBrowser.mockRestore();
		}
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
				profile: null,
				visible: null,
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
