/**
 * WHY: an extension reaches its session through the action set its host passes to
 * `ExtensionRunner.initialize`, and every host assembled that set by hand. Three members drifted
 * between hosts:
 *
 * - `obfuscateProviderText` was optional, and print, RPC and ACP never passed it. The runner fell
 *   back to the identity transform, so in those modes every extension tool, hook and command sent
 *   provider-bound text unredacted, while the same extension redacted it in the terminal.
 * - The runner read `getContextUsage` and `compact` from the command actions only. A spawned agent
 *   passes none, so its extensions read no context usage and `ctx.compact()` resolved without
 *   compacting.
 * - Print, RPC and a spawned agent wired `abort` as an expression arrow that returned the session's
 *   promise into a `() => void` slot. A rejecting abort reached the process-level
 *   unhandled-rejection hook, which exits.
 *
 * The class is a host whose action set diverges from its session. Each host below is started
 * through its own entry point against a real `ExtensionRunner`, and each case reads the context an
 * extension tool or hook receives from that runner.
 *
 * Not caught: a host added later. Hosts are entry points rather than members of a registry, so the
 * list is written by hand. `obfuscateProviderText` is required on `ExtensionContextActions`, so a
 * new host that omits it fails the type check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Model } from "@veyyon/ai";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import type {
	CompactOptions,
	ContextUsage,
	ExtensionRuntime,
	ExtensionUIContext,
} from "@veyyon/coding-agent/extensibility/extensions/types";
import { AcpAgent } from "@veyyon/coding-agent/modes/acp/acp-agent";
import { initializeExtensions } from "@veyyon/coding-agent/modes/runtime-init";
import { ExtensionUiController } from "@veyyon/coding-agent/modes/terminal/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const CWD = "/tmp/veyyon-extension-host-probe";
const SECRET = "EXTENSION_HOST_SECRET_7731";
const REDACTED = "#EXTENSION_HOST_SECRET#";
const USAGE: ContextUsage = { tokens: 4242, contextWindow: 200_000, percent: 2.121 };
const ABORT_FAILURE = "teardown failed";

/**
 * The session members every host's action set reads, plus the ones ACP's session setup reads.
 * `compactions` records each compaction an extension requested; `failAbort` makes `abort` reject.
 */
class ProbeSession {
	readonly sessionManager = SessionManager.inMemory(CWD);
	readonly sessionId = this.sessionManager.getSessionId();
	readonly extensionRunner = new ExtensionRunner(
		[],
		{} as ExtensionRuntime,
		CWD,
		this.sessionManager,
		{} as ModelRegistry,
	);
	readonly agent = { waitForIdle: async () => {} };
	readonly settings = Settings.isolated({});
	readonly customCommands = [];
	readonly model: Model | undefined = undefined;
	readonly thinkingLevel: string | undefined = undefined;
	readonly isStreaming = false;
	readonly queuedMessageCount = 0;
	readonly systemPrompt = ["system"];
	readonly compactions: Array<string | undefined> = [];
	failAbort = false;

	obfuscateProviderText(text: string): string {
		return text.replaceAll(SECRET, REDACTED);
	}
	getContextUsage(): ContextUsage {
		return USAGE;
	}
	async compact(instructions?: string): Promise<void> {
		this.compactions.push(instructions);
	}
	async abort(): Promise<void> {
		if (this.failAbort) throw new Error(ABORT_FAILURE);
	}

	getAvailableModels(): Model[] {
		return [];
	}
	getPlanModeState(): undefined {
		return undefined;
	}
	setClientBridge(): void {}
	async refreshMCPTools(): Promise<void> {}
	subscribe(): () => void {
		return () => {};
	}
}

/** Called after each case: closes what a host left running. */
const teardowns: Array<() => void> = [];

interface Host {
	/** Starts the host against a fresh probe and returns the probe whose runner it initialized. */
	start(): Promise<ProbeSession>;
	/** Whether the host passes command actions, so its extension commands receive a command context. */
	commands: boolean;
}

const HOSTS: Record<string, Host> = {
	"print and RPC": {
		commands: true,
		async start() {
			const probe = new ProbeSession();
			await initializeExtensions(probe as unknown as AgentSession, {
				reportSendError: () => {},
				reportRuntimeError: () => {},
			});
			return probe;
		},
	},
	ACP: {
		commands: true,
		async start() {
			const probe = new ProbeSession();
			const closed = new AbortController();
			teardowns.push(() => closed.abort());
			const connection = {
				sessionUpdate: async () => {},
				signal: closed.signal,
				closed: Promise.withResolvers<void>().promise,
			} as unknown as AgentSideConnection;
			const agent = new AcpAgent(connection, async () => probe as unknown as AgentSession);
			await agent.newSession({ cwd: CWD, mcpServers: [] });
			return probe;
		},
	},
	"a spawned agent": {
		commands: false,
		async start() {
			const probe = new ProbeSession();
			const session = createMockSession(({ emit }) => {
				emit(yieldSuccessEvent({ ok: true }, "tool-yield"));
			});
			Object.assign(session, { extensionRunner: probe.extensionRunner });
			vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));
			const result = await runSubprocess({
				cwd: CWD,
				agent: { name: "task", description: "probe", systemPrompt: "probe", source: "bundled" },
				task: "probe",
				index: 0,
				id: "extension-host-probe",
				modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
				enableLsp: false,
				settings: Settings.isolated({}),
			});
			expect(result.aborted).toBe(false);
			// The run is over, so the members the extension reads are swapped in only now: the mock's own
			// `abort` and `compact` serve the run itself.
			Object.assign(session, {
				obfuscateProviderText: (text: string) => probe.obfuscateProviderText(text),
				getContextUsage: () => probe.getContextUsage(),
				compact: (instructions?: string) => probe.compact(instructions),
				abort: () => probe.abort(),
			});
			return probe;
		},
	},
	"the terminal": {
		commands: true,
		async start() {
			const probe = new ProbeSession();
			const ctx = {
				session: probe,
				sessionManager: probe.sessionManager,
				// The terminal compacts through its own screen path; recording here is what the session's
				// compaction records for every other host.
				executeCompaction: async (instructionsOrOptions?: string | CompactOptions) => {
					probe.compactions.push(typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined);
				},
			} as unknown as InteractiveModeContext;
			new ExtensionUiController(ctx).initializeHookRunner({} as ExtensionUIContext, true);
			return probe;
		},
	},
};

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	for (const teardown of teardowns.splice(0)) teardown();
	AgentRegistry.resetGlobalForTests();
	vi.restoreAllMocks();
});

describe.each(Object.entries(HOSTS))("an extension in %s", (_name, host) => {
	it("has its provider-bound text redacted by the session", async () => {
		const probe = await host.start();
		const ctx = probe.extensionRunner.createContext();
		expect(ctx.obfuscateProviderText?.(`token=${SECRET}`)).toBe(`token=${REDACTED}`);
		if (host.commands) {
			const commandCtx = probe.extensionRunner.createCommandContext();
			expect(commandCtx.obfuscateProviderText?.(`token=${SECRET}`)).toBe(`token=${REDACTED}`);
		}
	});

	it("reads the session's context usage and compacts the session", async () => {
		const probe = await host.start();
		const ctx = probe.extensionRunner.createContext();
		expect(ctx.getContextUsage()).toBe(USAGE);
		await ctx.compact("keep the plan");
		if (host.commands) await probe.extensionRunner.createCommandContext().compact("keep the tests");
		expect(probe.compactions).toEqual(host.commands ? ["keep the plan", "keep the tests"] : ["keep the plan"]);
	});

	it("logs a failed abort instead of leaving its rejection unhandled", async () => {
		const probe = await host.start();
		const warnings: string[] = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			probe.failAbort = true;
			probe.extensionRunner.createContext().abort();
			await delay(10);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
		expect(warnings).toContain("Detached session abort failed");
	});
});
