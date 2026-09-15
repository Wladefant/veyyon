/**
 * A refusal fence holds across every tool invocation path.
 *
 * WHY THIS SUITE EXISTS. Issue #37: An operation was refused by an extension
 * guard as shell_destructive_os, but equivalent work executed 38 seconds later
 * before operator approval. Subagents, eval environments, dynamic tools, and
 * worker IPC bypass paths bypassed the refusal because the refusal fence was
 * not anchored at a single executor choke point reading directly from session
 * config/settings.
 *
 * The suite drives the production execution registry with refusing and allowed
 * probes, pins raw execution delegates and wrapper installation sites using AST
 * search, and sends encrypted guest prompt frames through the real collab host.
 * Settings-fork checks are not full provider-backed child-agent runs. The
 * external Telegram harness is absent; its integration is not claimed here.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { importRoomKey } from "@veyyon/coding-agent/collab/crypto";
import { CollabHost } from "@veyyon/coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@veyyon/coding-agent/collab/protocol";
import { CollabSocket } from "@veyyon/coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { createSubagentSettings } from "@veyyon/coding-agent/task/executor";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/core/approval-modes";
import {
	RefusalFenceError,
	checkRefusalFence,
	isToolRefused,
	recordRefusal,
} from "@veyyon/coding-agent/tools/core/refusal-fence";
import { type } from "arktype";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";
import { TOOL_EXECUTION_ENTRIES } from "@veyyon/coding-agent/tools/core/execution-registry";
import * as path from "node:path";
import { astGrep } from "@veyyon/natives";

const PROBE_TOOL_NAME = "test_destructive_probe";
let probeExecuted = false;

function createProbeTool(name = PROBE_TOOL_NAME): AgentTool {
	return {
		name,
		label: name,
		summary: "Refusal probe tool that records whether it executed",
		description: "Refusal probe tool that records whether it executed",
		parameters: type({ cmd: "string" }),
		approval: () => ({ tier: "exec" as const }),
		execute: async () => {
			probeExecuted = true;
			return { content: [{ type: "text", text: "PROBE_RAN" }] };
		},
	} as unknown as AgentTool;
}

const mockRunner = {
	hasHandlers: (_event: string) => false,
	hasUI: () => false,
	getUIContext: () => undefined,
	getExtensionNameForHandler: () => undefined,
	emit: async () => undefined,
	emitToolCall: async () => undefined,
	emitToolResult: async () => undefined,
	createContext: () => ({}),
} as unknown as ExtensionRunner;

function createSessionApprovals(initial: Record<string, "allow" | "deny"> = {}): SessionToolApprovals {
	const map = new Map<string, "allow" | "deny">(Object.entries(initial));
	return {
		get: (toolName: string) => map.get(toolName),
		set: (toolName: string, decision: "allow" | "deny") => {
			map.set(toolName, decision);
		},
	};
}

function createMockToolSession(options: {
	settings?: Settings;
	sessionApprovals?: SessionToolApprovals;
	tool?: AgentTool;
	wrapTool?: boolean;
}): ToolSession {
	const tool = options.tool ?? createProbeTool();
	const wrapped = options.wrapTool !== false ? new ExtensionToolWrapper(tool, mockRunner) : tool;
	const settings = options.settings ?? Settings.isolated();
	const sessionApprovals = options.sessionApprovals ?? createSessionApprovals();

	const toolContext: AgentToolContext = {
		settings,
		sessionApprovals,
		autoApprove: false,
		sessionManager: {
			getSessionId: () => "mock-session-id",
			getCwd: () => "/mock/cwd",
		} as unknown as AgentToolContext["sessionManager"],
	} as unknown as AgentToolContext;

	return {
		cwd: "/mock/cwd",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		getToolByName: (name: string) => (name === tool.name ? (wrapped as AgentTool) : undefined),
		getToolContext: () => toolContext,
	};
}

describe("Universal Refusal Fence on Every Invocation Path", () => {
	beforeEach(() => {
		probeExecuted = false;
	});

	it("pins every production execute call structurally, including non-tool delegates", async () => {
		const root = path.resolve(import.meta.dirname, "../src");
		const result = await astGrep({
			path: root,
			glob: "**/*.ts",
			lang: "ts",
			patterns: ["$TOOL.execute($$$ARGS)", "new ExtensionToolWrapper($$$ARGS)"],
			includeMeta: true,
			limit: 1000,
			timeoutMs: 30_000,
		});
		expect(result.limitReached).toBe(false);
		const sites = result.matches
			.filter(match => !match.path.endsWith(".test.ts") && match.metaVariables?.TOOL !== undefined)
			.map(
				match =>
					`${(path.isAbsolute(match.path) ? path.relative(root, match.path) : match.path).split(path.sep).join("/")}:${match.metaVariables?.TOOL}`,
			)
			.sort();
		// These delegates either receive SDK-wrapped tools, adapt an already fenced
		// tool body, or execute something other than an AgentTool. New sites require
		// a registry route and an explicit classification, regardless of receiver name.
		expect(sites).toEqual(
			[
				"cursor.ts:tool",
				"cursor.ts:tool",
				"edit/index.ts:modeDefinition",
				"eval/executor-base.ts:kernel",
				"eval/kernel-base.ts:this",
				"extensibility/custom-tools/wrapper.ts:this.tool",
				"extensibility/extensions/wrapper.ts:this.registeredTool.definition",
				"modes/rpc/rpc-client.ts:tool",
				"modes/terminal/autocomplete/prompt-action-autocomplete.ts:item",
				"modes/terminal/autocomplete/prompt-action-autocomplete.ts:item",
				"sdk.ts:taskTool",
				"session/agent-session.ts:loaded.command",
				"session/agent-session.ts:target",
				"session/agent-session.ts:target",
				"session/agent-session.ts:target",
				"session/factory-tools.ts:tool",
				"task/executor.ts:source",
				"tools/core/execution-registry.ts:tool",
				"tools/fs/read.ts:this",
				"tools/shell/eval.ts:backend",
			].sort(),
		);
		const installations = result.matches
			.filter(match => !match.path.endsWith(".test.ts") && match.metaVariables?.TOOL === undefined)
			.map(match =>
				(path.isAbsolute(match.path) ? path.relative(root, match.path) : match.path).split(path.sep).join("/"),
			)
			.sort();
		expect(installations).toEqual(["sdk.ts", "sdk.ts", "sdk.ts", "sdk.ts", "sdk.ts", "session/agent-session.ts"]);
	}, 40_000);

	for (const [name, entry] of Object.entries(TOOL_EXECUTION_ENTRIES)) {
		it(`registered dispatch ${name} refuses before entering a tool body`, async () => {
			const context = {
				settings: Settings.isolated(),
				sessionApprovals: createSessionApprovals({ [PROBE_TOOL_NAME]: "deny" }),
				autoApprove: true,
				bypassAllApprovals: true,
			} as unknown as AgentToolContext;
			await entry
				.invoke(createProbeTool(), "registered-call", { cmd: "probe" }, undefined, undefined, context)
				.catch(() => {});
			expect(probeExecuted).toBe(false);
			const allowed = { ...context, sessionApprovals: createSessionApprovals() };
			await entry.invoke(createProbeTool(), "allowed-call", { cmd: "probe" }, undefined, undefined, allowed);
			expect(probeExecuted).toBe(true);
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Subagent settings inheritance (not a provider-backed spawn).
	// ─────────────────────────────────────────────────────────────────────────
	it("subagent settings retain parent refusal policy without session approvals", async () => {
		// Root session sets policy in settings
		const rootSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Subagent settings derived via production createSubagentSettings
		const subagentSettings = createSubagentSettings(rootSettings, {}, undefined);

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const subagentContext: AgentToolContext = {
			settings: subagentSettings,
			autoApprove: true, // yolo should NEVER bypass explicit refusal
			sessionApprovals: createSessionApprovals(), // stripped approvals
		} as unknown as AgentToolContext;
		await wrapped.execute("task-call-1", { cmd: "rm -rf /" }, undefined, undefined, subagentContext).catch(() => {});

		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Runtime override inheritance used by eval-spawned sessions.
	// ─────────────────────────────────────────────────────────────────────────
	it("forked runtime settings retain refusal policy", async () => {
		const parentSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Eval agent inherits via runtime fork
		const evalSpawnSettings = parentSettings.forkWithRuntimeOverrides();

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const evalContext: AgentToolContext = {
			settings: evalSpawnSettings,
			autoApprove: true,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await wrapped.execute("eval-agent-call-1", { cmd: "whoami" }, undefined, undefined, evalContext).catch(() => {});
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Eval's production tool bridge.
	// ─────────────────────────────────────────────────────────────────────────
	it("callSessionTool blocks refused tools", async () => {
		const settings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		const session = createMockToolSession({ settings });
		await callSessionTool(PROBE_TOOL_NAME, { cmd: "id" }, { session }).catch(() => {});
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Existing session policy does not depend on an extension runner.
	// ─────────────────────────────────────────────────────────────────────────
	it("a wrapper consults session settings on each call", async () => {
		const ircSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const ircContext: AgentToolContext = {
			settings: ircSettings,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await wrapped.execute("irc-wake-call-1", { cmd: "ping" }, undefined, undefined, ircContext).catch(() => {});
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Settings cloning used by revived sessions.
	// ─────────────────────────────────────────────────────────────────────────
	it("cloning settings for another cwd retains refusal policy", async () => {
		const baseSettings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Revived session clones settings
		const revivedSettings = await baseSettings.cloneForCwd("/mock/cwd");

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const revivedContext: AgentToolContext = {
			settings: revivedSettings,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await wrapped.execute("revive-call-1", { cmd: "restart" }, undefined, undefined, revivedContext).catch(() => {});
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Worker IPC's production bridge dispatch selection.
	// ─────────────────────────────────────────────────────────────────────────
	it("the worker dispatch branch blocks refused tools", async () => {
		const settings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		const session = createMockToolSession({ settings });

		// Worker calls callSessionTool with abort signal and IPC context
		const abortController = new AbortController();
		await callSessionTool(
			PROBE_TOOL_NAME,
			{ cmd: "ps" },
			{ session, signal: abortController.signal, entry: "cli.worker" },
		).catch(() => {});

		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// The dynamic-tool registry entry, with no extension runner.
	// ─────────────────────────────────────────────────────────────────────────
	it("dynamic-tool dispatch remains fenced without extensions", async () => {
		const settings = Settings.isolated({
			"tools.approval": { [PROBE_TOOL_NAME]: "deny" },
		});
		// Dynamic tool wrapped by the runtime tool wrapper
		const dynamicTool = createProbeTool();
		const wrappedDynamic = new ExtensionToolWrapper(dynamicTool, undefined, "session.dynamic-tools");

		const context: AgentToolContext = {
			settings,
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await wrappedDynamic.execute("dyn-call-1", { cmd: "ssh" }, undefined, undefined, context).catch(() => {});
		expect(probeExecuted).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Real collaboration guest frame transport.
	// ─────────────────────────────────────────────────────────────────────────
	it("a writable guest frame reaches the session without executing a refused tool", async () => {
		const settings = Settings.isolated({ "tools.refusals": [PROBE_TOOL_NAME] });
		const finished = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		let promptCount = 0;
		const wrapped = new ExtensionToolWrapper(createProbeTool(), undefined);
		const ctx = {
			settings,
			sessionManager: {
				getSessionId: () => "guest-fence-test",
				getCwd: () => "/repo",
				snapshotForReplication: () => ({
					header: { type: "session", id: "guest-fence-test", timestamp: new Date().toISOString(), cwd: "/repo" },
					entries: [],
				}),
			},
			session: {
				isStreaming: false,
				queuedMessageCount: 0,
				sessionName: "fence",
				subscribe: () => () => {},
				emitNotice: () => {},
				promptCustomMessage: async () => {
					promptCount++;
					await wrapped.execute("guest-tool", { cmd: "probe" }).catch(() => {});
					finished[promptCount - 1].resolve();
				},
			},
			statusLine: {
				setCollabStatus: () => {},
				invalidate: () => {},
				getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
			},
			ui: { requestRender: () => {} },
			showStatus: () => {},
			refreshComposerShortcuts: () => {},
			dismissWelcome: () => {},
		} as unknown as InteractiveModeContext;
		installInMemoryRelay();
		const host = new CollabHost(ctx);
		let guest: CollabSocket | undefined;
		try {
			await host.start("ws://localhost:8787");
			const link = parseCollabLink(host.link);
			if ("error" in link) throw new Error(link.error);
			guest = new CollabSocket({ wsUrl: link.wsUrl, role: "guest", key: await importRoomKey(link.key) });
			const welcomed = Promise.withResolvers<void>();
			guest.onFrame = frame => {
				if (frame.t === "welcome") welcomed.resolve();
			};
			const socket = guest;
			guest.onOpen = () =>
				socket.send({
					t: "hello",
					proto: COLLAB_PROTO,
					name: "writer",
					writeToken: link.writeToken ? Buffer.from(link.writeToken).toString("base64url") : undefined,
				});
			guest.connect();
			await welcomed.promise;
			guest.send({ t: "prompt", text: "run the probe" });
			await finished[0].promise;
			expect(promptCount).toBe(1);
			expect(probeExecuted).toBe(false);
			settings.override("tools.refusals", []);
			guest.send({ t: "prompt", text: "run the allowed probe" });
			await finished[1].promise;
			expect(promptCount).toBe(2);
			expect(probeExecuted).toBe(true);
		} finally {
			guest?.close();
			uninstallInMemoryRelay();
			await host.stop("test complete");
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Unscoped extension decisions retain their legacy tool-wide meaning.
	// ─────────────────────────────────────────────────────────────────────────
	it("unscoped refusal policy persists and is inherited by child settings", async () => {
		const settings = Settings.isolated();
		const sessionApprovals = createSessionApprovals();
		const context: AgentToolContext = {
			settings,
			sessionApprovals,
		} as unknown as AgentToolContext;

		// 1. Initial state: tool is not refused
		expect(isToolRefused(PROBE_TOOL_NAME, {}, context).refused).toBe(false);

		// 2. Extension hook (e.g. Telegram guard) refuses execution with a reason
		recordRefusal(PROBE_TOOL_NAME, "refused as shell_destructive_os", context);

		// 3. Status must now report refused
		const status = isToolRefused(PROBE_TOOL_NAME, {}, context);
		expect(status.refused).toBe(true);

		// 4. checkRefusalFence must throw RefusalFenceError
		expect(() => checkRefusalFence(PROBE_TOOL_NAME, {}, context)).toThrow(RefusalFenceError);

		// 5. Subsequent execution through ExtensionToolWrapper must be fenced
		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);
		await wrapped.execute("extension-call", { cmd: "probe" }, undefined, undefined, context).catch(() => {});
		expect(probeExecuted).toBe(false);

		// 6. Child session spawned after the refusal must inherit the refusal in settings
		const childSettings = createSubagentSettings(settings, {}, undefined);
		const childContext: AgentToolContext = {
			settings: childSettings,
			sessionApprovals: createSessionApprovals(), // fresh approvals
		} as unknown as AgentToolContext;

		await wrapped
			.execute("child-after-refusal-1", { cmd: "notepad.exe" }, undefined, undefined, childContext)
			.catch(() => {});
		expect(probeExecuted).toBe(false);
	});

	it("scopes an extension refusal to its path across tools, while unrelated writes execute", async () => {
		const settings = Settings.isolated();
		const context = {
			settings,
			autoApprove: true,
			bypassAllApprovals: true,
			sessionApprovals: createSessionApprovals(),
			sessionManager: { getCwd: () => "/repo" },
		} as unknown as AgentToolContext;
		const runner = {
			...mockRunner,
			hasHandlers: (event: string) => event === "tool_call",
			emitToolCall: async () => ({
				block: true,
				reason: "protected target",
				subject: { kind: "path", value: "/repo/protected" },
			}),
		} as unknown as ExtensionRunner;
		const write = Object.assign(createProbeTool("write"), {
			filesystemTargets: (args: { path: string }) => [args.path],
		});
		await new ExtensionToolWrapper(write, runner)
			.execute("refuse", { path: "/repo/protected" }, undefined, undefined, context)
			.catch(() => {});
		probeExecuted = false;
		await new ExtensionToolWrapper(write, undefined)
			.execute("unrelated", { path: "/repo/other" }, undefined, undefined, context)
			.catch(() => {});
		expect(probeExecuted).toBe(true);
	});

	for (const name of ["write", "edit", "bash", "eval"]) {
		it(`a path refusal prevents equivalent work through ${name}`, async () => {
			const context = {
				settings: Settings.isolated(),
				autoApprove: true,
				bypassAllApprovals: true,
				sessionApprovals: createSessionApprovals(),
				sessionManager: { getCwd: () => "/repo" },
			} as unknown as AgentToolContext;
			const runner = {
				...mockRunner,
				hasHandlers: (event: string) => event === "tool_call",
				emitToolCall: async () => ({
					block: true,
					reason: "protected target",
					subject: { kind: "path", value: "/repo/protected" },
				}),
			} as unknown as ExtensionRunner;
			await new ExtensionToolWrapper(createProbeTool("write"), runner)
				.execute("refuse", { path: "/repo/protected" }, undefined, undefined, context)
				.catch(() => {});
			const probe =
				name === "edit" || name === "write"
					? Object.assign(createProbeTool(name), { filesystemTargets: () => ["/repo/sub/../protected"] })
					: createProbeTool(name);
			probeExecuted = false;
			await new ExtensionToolWrapper(probe, undefined)
				.execute("reroute", { path: "/repo/protected", cmd: "opaque" }, undefined, undefined, context)
				.catch(() => {});
			expect(probeExecuted).toBe(false);
		});
	}

	it("legacy nested execution inherits policy rather than constructing an empty policy", async () => {
		const context = { settings: Settings.isolated({ "tools.refusals": [PROBE_TOOL_NAME] }) };
		const outer = {
			...createProbeTool("extension"),
			execute: () => TOOL_EXECUTION_ENTRIES["legacy.adapter"].invoke(createProbeTool(), "nested", { cmd: "probe" }),
		};
		await TOOL_EXECUTION_ENTRIES["session.tools"]
			.invoke(outer, "outer", {}, undefined, undefined, context)
			.catch(() => {});
		expect(probeExecuted).toBe(false);
		context.settings.override("tools.refusals", []);
		await TOOL_EXECUTION_ENTRIES["session.tools"].invoke(outer, "outer-allowed", {}, undefined, undefined, context);
		expect(probeExecuted).toBe(true);
	});

	it("scoped refusal survives a child settings fork and retains previous tool refusals", async () => {
		const settings = Settings.isolated({ "tools.refusals": [PROBE_TOOL_NAME] });
		recordRefusal("write", "protected path", undefined, settings, { kind: "path", value: "/repo/protected" });
		const child = createSubagentSettings(settings, {}, undefined);
		const context = { settings: child };
		const probe = Object.assign(createProbeTool("edit"), { filesystemTargets: () => ["/repo/protected"] });
		await TOOL_EXECUTION_ENTRIES["session.tools"]
			.invoke(probe, "child", {}, undefined, undefined, context)
			.catch(() => {});
		expect(probeExecuted).toBe(false);
		expect(isToolRefused(PROBE_TOOL_NAME, {}, context).refused).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Standing session denial under autoApprove / yolo (the standing denial bypass hole)
	// ─────────────────────────────────────────────────────────────────────────
	it("refusal fence blocks standing denials even under autoApprove / yolo bypass", async () => {
		const settings = Settings.isolated();
		const sessionApprovals = createSessionApprovals({ [PROBE_TOOL_NAME]: "deny" });

		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);

		const yoloContext: AgentToolContext = {
			settings,
			sessionApprovals,
			autoApprove: true, // autoApprove previously set standing = undefined!
			bypassAllApprovals: true,
		} as unknown as AgentToolContext;

		await wrapped.execute("standing-yolo-1", { cmd: "test" }, undefined, undefined, yoloContext).catch(() => {});
		expect(probeExecuted).toBe(false);
	});
});
