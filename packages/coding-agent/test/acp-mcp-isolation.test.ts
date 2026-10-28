/**
 * Regression test for issue #1234.
 *
 * `veyyon acp` must not auto-discover host `.mcp.json` servers when creating a
 * session for an ACP client. MCP server ownership belongs entirely to the ACP
 * client (`session/new.mcpServers` → `AcpAgent#configureMcpServers`); letting
 * `createAgentSession` run on-disk discovery in parallel registers host MCP
 * tools that shadow the client-supplied ones in the session tool registry.
 *
 * The contract enforced here is narrow on purpose: every call routed through
 * the ACP session factory must reach `createAgentSession` with
 * `enableMCP: false`, regardless of what `baseOptions` carries.
 */

import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAcpSessionFactory } from "@veyyon/coding-agent/main";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@veyyon/coding-agent/session/factory-options";
import { TempDir } from "@veyyon/utils";
import { CONFIG_DIR_NAME } from "@veyyon/utils/config-root";

describe("createAcpSessionFactory MCP isolation (issue #1234)", () => {
	it("forces enableMCP=false even when baseOptions opts in", async () => {
		const tempDir = TempDir.createSync("@pi-acp-mcp-isolation-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});
			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					setToolNotifier: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions deliberately sets enableMCP=true to prove the factory ignores it.
			const factory = createAcpSessionFactory({
				baseOptions: { enableMCP: true } as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession,
			});

			const result = await factory(tempDir.path());
			expect(result).toBe(fakeSession);
			expect(captured).toHaveLength(1);
			expect(captured[0].enableMCP).toBe(false);
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});
});

describe("createAcpSessionFactory TITLE_SYSTEM.md per-cwd resolution (PR #3736)", () => {
	it("re-resolves the title prompt for the per-session cwd instead of inheriting the launch cwd's override", async () => {
		const tempDir = TempDir.createSync("@pi-acp-title-prompt-");
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage);
			const settings = Settings.isolated({});

			const projectDir = tempDir.join("project");
			await Bun.write(`${projectDir}/${CONFIG_DIR_NAME}/TITLE_SYSTEM.md`, "Project-specific title policy.");

			const fakeSession = {} as AgentSession;
			const captured: CreateAgentSessionOptions[] = [];
			const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
				captured.push(options);
				return {
					session: fakeSession,
					extensionsResult: {
						extensions: [],
						errors: [],
						runner: undefined,
					} as unknown as CreateAgentSessionResult["extensionsResult"],
					setToolUIContext: () => {},
					setToolNotifier: () => {},
					eventBus: {
						emit: () => {},
						on: () => () => {},
						off: () => {},
					} as unknown as CreateAgentSessionResult["eventBus"],
				};
			};

			// baseOptions carries the LAUNCH cwd's prompt; the factory must
			// override it with the per-session cwd's `TITLE_SYSTEM.md`.
			const factory = createAcpSessionFactory({
				baseOptions: {
					titleSystemPrompt: "Launch-cwd policy that must not leak.",
				} as CreateAgentSessionOptions,
				settings,
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry,
				parsedArgs: {},
				rawArgs: [],
				createSession,
			});

			await factory(projectDir);

			expect(captured).toHaveLength(1);
			expect(captured[0].titleSystemPrompt).toBe("Project-specific title policy.");
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	});
});

/**
 * `veyyon acp` runs the launch parser over its argv, and that parser keeps a flag it does not know for
 * the check a launch makes once its extensions load. ACP never made that check, so `acp --aproval-mode
 * yolo` started a server that ran every session on the default approval mode at exit 0, the typo
 * reported nowhere. Extension flags are registered per session, so the check runs at `session/new`:
 * a flag neither the parser nor the session's extensions recognize fails the session with the reason,
 * and the session it built is disposed rather than left registered.
 *
 * NOT CAUGHT: a client that ignores the `session/new` error text.
 */
describe("createAcpSessionFactory refuses a flag nobody recognizes", () => {
	async function withFactory(
		rawArgs: string[],
		extensionFlags: Map<string, { type: "boolean" | "string" }> | undefined,
		run: (factory: (cwd: string) => Promise<AgentSession>, disposed: () => number, cwd: string) => Promise<void>,
	): Promise<void> {
		const tempDir = TempDir.createSync("@pi-acp-unknown-flag-");
		let authStorage: AuthStorage | undefined;
		let disposeCount = 0;
		const flagValues = new Map<string, boolean | string>();
		try {
			authStorage = await AuthStorage.create(tempDir.join("auth.db"));
			const session = {
				extensionRunner: extensionFlags
					? {
							getFlags: () => extensionFlags,
							setFlagValue: (name: string, value: boolean | string) => flagValues.set(name, value),
						}
					: undefined,
				dispose: async () => {
					disposeCount++;
				},
			} as unknown as AgentSession;
			const createSession = async (): Promise<CreateAgentSessionResult> =>
				({ session }) as unknown as CreateAgentSessionResult;
			const factory = createAcpSessionFactory({
				baseOptions: {} as CreateAgentSessionOptions,
				settings: Settings.isolated({}),
				sessionDir: tempDir.join("sessions"),
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				parsedArgs: {},
				rawArgs,
				createSession,
			});
			await run(factory, () => disposeCount, tempDir.path());
		} finally {
			try {
				authStorage?.close();
			} finally {
				await Bun.sleep(0);
				await tempDir.remove();
			}
		}
	}

	it("fails session/new on a mistyped flag, naming it and the flag it resembles, and disposes the session", async () => {
		await withFactory(["--aproval-mode", "yolo"], undefined, async (factory, disposed, cwd) => {
			const error = await factory(cwd).then(
				() => undefined,
				(caught: unknown) => caught,
			);

			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain("unknown flag: --aproval-mode");
			expect((error as Error).message).toContain("--approval-mode");
			expect((error as Error).message).not.toContain("\x1b[");
			expect(disposed()).toBe(1);
		});
	});

	it("creates the session when every flag is one the launch parser knows", async () => {
		await withFactory(["--approval-mode", "yolo"], undefined, async (factory, disposed, cwd) => {
			await factory(cwd);

			expect(disposed()).toBe(0);
		});
	});

	it("creates the session when the unknown flag is one this session's extensions register", async () => {
		await withFactory(
			["--spawn-peer", "reviewer"],
			new Map([["spawn-peer", { type: "string" }]]),
			async (factory, disposed, cwd) => {
				await factory(cwd);

				expect(disposed()).toBe(0);
			},
		);
	});
});
