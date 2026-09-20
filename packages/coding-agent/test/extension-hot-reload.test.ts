import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadCodingAgentApi } from "../src/extensibility/coding-agent-api";
import { ExtensionRuntime, loadExtension } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { LoadedExtension } from "../src/extensibility/extensions/types";
import type { TurnEndEvent } from "../src/extensibility/shared-events";
import type { AgentSession } from "../src/session/agent-session";
import { executeAcpBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../src/slash-commands/types";
import { EventBus } from "../src/utils/event-bus";

declare global {
	var __testHookMarker: string | undefined;
}

const dummyTurnEnd: TurnEndEvent = {
	type: "turn_end",
	turnIndex: 0,
	message: {
		role: "assistant",
		api: "openai",
		provider: "openai",
		model: "gpt-4o",
		timestamp: 0,
		content: [{ type: "text", text: "" }],
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	},
	toolResults: [],
};

describe("Extension hot reload", () => {
	let sharedTempDir: TempDir;
	let tempDir: TempDir;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@ext-reload-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		await loadCodingAgentApi();
	}, 60000);

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@ext-reload-test-");
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("replaces old hooks with new hooks on reload and counts hooks", async () => {
		const extFile = path.join(tempDir.path(), "my-ext.ts");
		await fs.writeFile(
			extFile,
			`
			export default function(api: { on: (event: string, handler: () => void) => void }) {
				api.on("turn_end", () => {
					globalThis.__testHookMarker = "v1";
				});
			}
			`,
		);

		const eventBus = new EventBus();
		const runtime = new ExtensionRuntime();
		const loaded = await loadExtension(extFile, tempDir.path(), eventBus, runtime);
		expect(loaded.extension).not.toBeNull();

		const runner = new ExtensionRunner(
			[loaded.extension!],
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			undefined,
			undefined,
			undefined,
			eventBus,
		);

		// Emit turn_end and verify v1 hook fired
		globalThis.__testHookMarker = "unset";
		await runner.emit(dummyTurnEnd);
		expect(globalThis.__testHookMarker).toBe("v1");

		// Write v2 of extension with turn_end and turn_start hooks
		await fs.writeFile(
			extFile,
			`
			export default function(api: { on: (event: string, handler: () => void) => void }) {
				api.on("turn_end", () => {
					globalThis.__testHookMarker = "v2";
				});
				api.on("turn_start", () => {});
			}
			`,
		);

		const reloadResults = await runner.reloadExtensions();
		expect(reloadResults).toEqual([
			{
				path: extFile,
				status: "reloaded",
				hookCount: 2,
			},
		]);

		// Emit turn_end and verify v2 hook fired (v1 hook is replaced, not duplicated)
		globalThis.__testHookMarker = "unset";
		await runner.emit(dummyTurnEnd);
		expect(globalThis.__testHookMarker).toBe("v2");
	}, 60000);

	it("keeps old hooks if re-import fails and does not crash", async () => {
		const extFile = path.join(tempDir.path(), "failing-ext.ts");
		await fs.writeFile(
			extFile,
			`
			export default function(api: { on: (event: string, handler: () => void) => void }) {
				api.on("turn_end", () => {
					globalThis.__testHookMarker = "v1-active";
				});
			}
			`,
		);

		const eventBus = new EventBus();
		const runtime = new ExtensionRuntime();
		const loaded = await loadExtension(extFile, tempDir.path(), eventBus, runtime);
		expect(loaded.extension).not.toBeNull();

		const runner = new ExtensionRunner(
			[loaded.extension!],
			runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			undefined,
			undefined,
			undefined,
			eventBus,
		);

		// Corrupt file with syntax error
		await fs.writeFile(extFile, `export default function(api: unknown) { SYNTAX ERROR HERE !!! }`);

		const reloadResults = await runner.reloadExtensions();
		expect(reloadResults.length).toBe(1);
		expect(reloadResults[0].status).toBe("failed");
		expect(reloadResults[0].path).toBe(extFile);
		expect(reloadResults[0].error).toBeDefined();

		// Old v1 hook must still be active and callable
		globalThis.__testHookMarker = "unset";
		await runner.emit(dummyTurnEnd);
		expect(globalThis.__testHookMarker).toBe("v1-active");
	}, 60000);

	it("calls session_shutdown before re-import and session_start after re-import", async () => {
		const order: string[] = [];

		const mockOldExtension: LoadedExtension = {
			path: "/test/order-ext.ts",
			resolvedPath: "/test/order-ext.ts",
			handlers: new Map([
				[
					"session_shutdown",
					[
						async () => {
							order.push("shutdown");
						},
					],
				],
			]),
			tools: new Map(),
			assistantThinkingRenderers: [],
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		const mockNewExtension: LoadedExtension = {
			path: "/test/order-ext.ts",
			resolvedPath: "/test/order-ext.ts",
			handlers: new Map([
				[
					"session_start",
					[
						async () => {
							order.push("start");
						},
					],
				],
			]),
			tools: new Map(),
			assistantThinkingRenderers: [],
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		const runner = new ExtensionRunner(
			[mockOldExtension],
			new ExtensionRuntime(),
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const reloadResults = await runner.reloadExtensions(async () => {
			order.push("re-import");
			return { extension: mockNewExtension, error: null };
		});

		expect(reloadResults).toEqual([
			{
				path: "/test/order-ext.ts",
				status: "reloaded",
				hookCount: 1,
			},
		]);

		// Verify strict sequence: shutdown -> re-import -> session_start
		expect(order).toEqual(["shutdown", "re-import", "start"]);
	}, 60000);

	it("formats output correctly for no extensions, reloaded extensions, and failed extensions", async () => {
		const configDir = path.join(tempDir.path(), "config");
		await fs.mkdir(configDir, { recursive: true });
		await fs.writeFile(path.join(configDir, "config.yml"), "agent:\n  model: openai/test\n");
		const settings = await Settings.loadReadOnly({ agentDir: configDir });

		// 1. No extensions loaded
		const outputNoExt: string[] = [];
		const runtimeNoExt: SlashCommandRuntime = {
			settings,
			cwd: tempDir.path(),
			session: { extensionRunner: undefined } as unknown as AgentSession,
			sessionManager,
			output: text => {
				outputNoExt.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		const resNoExt = await executeAcpBuiltinSlashCommand("/reload-config", runtimeNoExt);
		expect(resNoExt).toEqual({ consumed: true });
		expect(outputNoExt[0]).toContain("config: unchanged");
		expect(outputNoExt[0]).toContain("extensions: none");

		// 2. Extensions reloaded successfully
		const outputSuccess: string[] = [];
		const runtimeSuccess: SlashCommandRuntime = {
			settings,
			cwd: tempDir.path(),
			session: {
				extensionRunner: {
					reloadExtensions: async () => [{ path: "/path/to/my-ext.ts", status: "reloaded", hookCount: 3 }],
				},
			} as unknown as AgentSession,
			sessionManager,
			output: text => {
				outputSuccess.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		const resSuccess = await executeAcpBuiltinSlashCommand("/reload-config", runtimeSuccess);
		expect(resSuccess).toEqual({ consumed: true });
		expect(outputSuccess[0]).toContain("config: unchanged");
		expect(outputSuccess[0]).toContain("extension /path/to/my-ext.ts: reloaded (3 hooks)");

		// 3. Extension reload failed
		const outputFail: string[] = [];
		const runtimeFail: SlashCommandRuntime = {
			settings,
			cwd: tempDir.path(),
			session: {
				extensionRunner: {
					reloadExtensions: async () => [
						{ path: "/path/to/bad-ext.ts", status: "failed", error: "Unexpected token" },
					],
				},
			} as unknown as AgentSession,
			sessionManager,
			output: text => {
				outputFail.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		const resFail = await executeAcpBuiltinSlashCommand("/reload-config", runtimeFail);
		expect(resFail).toEqual({ consumed: true });
		expect(outputFail[0]).toContain("config: unchanged");
		expect(outputFail[0]).toContain("extension /path/to/bad-ext.ts: reload failed: Unexpected token");

		// 4. Slash command alias /reload
		const outputAlias: string[] = [];
		const runtimeAlias: SlashCommandRuntime = {
			settings,
			cwd: tempDir.path(),
			session: { extensionRunner: undefined } as unknown as AgentSession,
			sessionManager,
			output: text => {
				outputAlias.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};

		const aliasResult = await executeAcpBuiltinSlashCommand("/reload", runtimeAlias);
		expect(aliasResult).toEqual({ consumed: true });
		expect(outputAlias[0]).toContain("config: unchanged");
		expect(outputAlias[0]).toContain("extensions: none");
	}, 60000);
});
