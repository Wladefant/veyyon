/**
 * A refusal fence holds across every tool invocation path.
 *
 * WHY THIS SUITE EXISTS. Issue #37: an operation the operator had denied ran
 * anyway through a subagent, an eval environment, a dynamic tool or the worker
 * IPC bridge, because the fence was not anchored at a single executor choke
 * point reading directly from session config/settings.
 *
 * The suite drives the production execution registry with refusing and allowed
 * probes, pins raw execution delegates and wrapper installation sites using AST
 * search, and sends encrypted guest prompt frames through the real collab host.
 *
 * It also pins the other direction: an extension that blocks a call blocks that
 * call only. Recording such a block as a standing denial wrote
 * `tools.approval.<tool>: deny` into the profile config, so an approval guard
 * that was merely waiting for the operator locked `read`, `bash` and `eval` in
 * every later session. Settings-fork checks are not full provider-backed
 * child-agent runs, and the external Telegram harness is absent here.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import { importRoomKey } from "@veyyon/coding-agent/collab/crypto";
import { CollabHost } from "@veyyon/coding-agent/collab/host";
import { COLLAB_PROTO, parseCollabLink } from "@veyyon/coding-agent/collab/protocol";
import { CollabSocket } from "@veyyon/coding-agent/collab/relay-client";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { createSubagentSettings } from "@veyyon/coding-agent/task/executor";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/core/approval-modes";
import { TOOL_EXECUTION_ENTRIES } from "@veyyon/coding-agent/tools/core/execution-registry";
import { RefusalFenceError } from "@veyyon/coding-agent/tools/core/refusal-fence";
import { astGrep } from "@veyyon/natives";
import { type } from "arktype";
import { typeScriptMembersOf } from "../../../scripts/workspace-layout";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";

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
	cwd?: string;
}): ToolSession {
	const tool = options.tool ?? createProbeTool();
	const wrapped = options.wrapTool !== false ? new ExtensionToolWrapper(tool, mockRunner) : tool;
	const settings = options.settings ?? Settings.isolated();
	const sessionApprovals = options.sessionApprovals ?? createSessionApprovals();
	const cwd = options.cwd ?? "/mock/cwd";

	const toolContext: AgentToolContext = {
		settings,
		sessionApprovals,
		autoApprove: false,
		sessionManager: {
			getSessionId: () => "mock-session-id",
			getCwd: () => cwd,
		} as unknown as AgentToolContext["sessionManager"],
	} as unknown as AgentToolContext;

	return {
		cwd,
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
		const root = path.resolve(import.meta.dirname, "../../..");
		const members = typeScriptMembersOf(root);
		expect(members.length).toBeGreaterThan(0);
		const matches = [];
		for (const member of members) {
			const directory = path.join(root, member);
			const result = await astGrep({
				path: directory,
				glob: "**/*.ts",
				lang: "ts",
				patterns: ["$TOOL.execute($$$ARGS)", "new ExtensionToolWrapper($$$ARGS)"],
				includeMeta: true,
				// Test files are collected here and filtered out below, so the cap has
				// to clear every `execute` call in the tree, suites included.
				limit: 20_000,
				// The scan walks every workspace member, so the deadline has to cover
				// the whole tree rather than a single package's worth of files.
				timeoutMs: 120_000,
			});
			expect(result.limitReached).toBe(false);
			for (const match of result.matches) {
				const filename = path.isAbsolute(match.path) ? match.path : path.join(directory, match.path);
				const relative = path.relative(root, filename).split(path.sep).join("/");
				if (relative.endsWith(".test.ts") || /(^|\/)(test|tests|__tests__)\//.test(relative)) continue;
				matches.push({ ...match, path: relative });
			}
		}
		const sites = matches
			.filter(match => match.metaVariables?.TOOL !== undefined)
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
				"gui-host/actions/agents.ts:taskTool",
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
			]
				.map(site => `packages/coding-agent/src/${site}`)
				.concat([
					"packages/agent/src/agent-loop.ts:tool",
					"packages/coding-agent/bench/rendering.ts:rt",
					"packages/coding-agent/bench/rendering.ts:rt",
					"packages/coding-agent/bench/rendering.ts:new ReadTool(mkSession())",
				])
				.sort(),
		);
		const installations = matches
			.filter(match => match.metaVariables?.TOOL === undefined)
			.map(match =>
				(path.isAbsolute(match.path) ? path.relative(root, match.path) : match.path).split(path.sep).join("/"),
			)
			.sort();
		expect(installations).toEqual(
			["sdk.ts", "sdk.ts", "sdk.ts", "sdk.ts", "sdk.ts", "session/agent-session.ts"].map(
				site => `packages/coding-agent/src/${site}`,
			),
		);
	}, 300_000);

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
		const settings = Settings.isolated({ "tools.approval": { [PROBE_TOOL_NAME]: "deny" } });
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
			settings.override("tools.approval", {});
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
	// An extension block answers one call and records nothing.
	// ─────────────────────────────────────────────────────────────────────────
	it("an extension block stops that call only and is never recorded as a denial", async () => {
		const settings = Settings.isolated();
		const sessionApprovals = createSessionApprovals();
		// A session manager makes this a full tool context, which is what the wrapper
		// hands on to the tool body once the call is allowed.
		const context = {
			settings,
			sessionApprovals,
			sessionManager: { getSessionId: () => "block-once", getCwd: () => "/repo" },
		} as unknown as AgentToolContext;
		let blocking = true;
		const runner = {
			...mockRunner,
			hasHandlers: (event: string) => event === "tool_call",
			emitToolCall: async () => (blocking ? { block: true, reason: "waiting for operator approval" } : undefined),
		} as unknown as ExtensionRunner;
		const wrapped = new ExtensionToolWrapper(createProbeTool(), runner);

		await expect(wrapped.execute("blocked", { cmd: "probe" }, undefined, undefined, context)).rejects.toThrow(
			"waiting for operator approval",
		);
		expect(probeExecuted).toBe(false);

		// Nothing standing: no config entry in any layer, no session denial.
		expect((settings.get("tools.approval") as Record<string, unknown>)[PROBE_TOOL_NAME]).toBeUndefined();
		expect(settings.getSource("tools.approval")).toBe("default");
		expect(sessionApprovals.get(PROBE_TOOL_NAME)).toBeUndefined();

		// Once the extension allows it, the very next call runs, in this session
		// and in a child forked from it.
		blocking = false;
		await wrapped.execute("allowed", { cmd: "probe" }, undefined, undefined, context);
		expect(probeExecuted).toBe(true);
		probeExecuted = false;
		const childContext = {
			...context,
			settings: createSubagentSettings(settings, {}, undefined),
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await wrapped.execute("child-allowed", { cmd: "probe" }, undefined, undefined, childContext);
		expect(probeExecuted).toBe(true);
	});

	it("legacy dispatch reports a typed refusal when session policy context is missing", async () => {
		await expect(
			TOOL_EXECUTION_ENTRIES["legacy.adapter"].invoke(createProbeTool(), "missing-context", {}),
		).rejects.toBeInstanceOf(RefusalFenceError);
		await expect(
			TOOL_EXECUTION_ENTRIES["legacy.adapter"].invoke(createProbeTool(), "missing-context", {}),
		).rejects.toThrow("missing session policy context");
		expect(probeExecuted).toBe(false);
	});

	// WHY: a tool taken off a session registry is invoked with no context of its
	// own (`session.getToolByName("eval").execute(...)`, the cursor bridge, an
	// eval snippet). Refusing those for want of a policy breaks live work, and
	// reading the session's policy is what keeps the fence honest — so this pins
	// both directions plus the bound: the frame decides the verdict and is never
	// promoted to a tool context. It does not cover a boundary that owns no
	// session policy at all; that case is the typed refusal above.
	it("a session tool reached with no context is fenced against the session's own policy", async () => {
		const settings = Settings.isolated({ "tools.approval": { [PROBE_TOOL_NAME]: "deny" } });
		let handedContext: unknown = "never executed";
		const probe = {
			...createProbeTool(),
			execute: async (_id: string, _params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown) => {
				probeExecuted = true;
				handedContext = ctx;
				return { content: [{ type: "text", text: "PROBE_RAN" }] };
			},
		} as unknown as AgentTool;
		const wrapped = new ExtensionToolWrapper(probe, mockRunner, "session.tools", () => ({
			settings,
			sessionApprovals: createSessionApprovals(),
		}));

		await expect(wrapped.execute("no-context-refused", { cmd: "probe" })).rejects.toBeInstanceOf(RefusalFenceError);
		expect(probeExecuted).toBe(false);

		settings.override("tools.approval", {});
		await wrapped.execute("no-context-allowed", { cmd: "probe" });
		expect(probeExecuted).toBe(true);
		// Fencing only. Promoting the session frame to a tool context would hand a
		// contextless caller an approval surface and a session manager it never
		// established, which is a different change from enforcing a refusal.
		expect(handedContext).toBeUndefined();
	});

	it("a standing session denial reaches a session tool called with no context", async () => {
		const wrapped = new ExtensionToolWrapper(createProbeTool(), mockRunner, "session.tools", () => ({
			settings: Settings.isolated(),
			sessionApprovals: createSessionApprovals({ [PROBE_TOOL_NAME]: "deny" }),
		}));
		await expect(wrapped.execute("standing-no-context", { cmd: "probe" })).rejects.toBeInstanceOf(RefusalFenceError);
		expect(probeExecuted).toBe(false);
	});

	it("legacy nested execution inherits policy rather than constructing an empty policy", async () => {
		const context = { settings: Settings.isolated({ "tools.approval": { [PROBE_TOOL_NAME]: "deny" } }) };
		const outer = {
			...createProbeTool("extension"),
			execute: () => TOOL_EXECUTION_ENTRIES["legacy.adapter"].invoke(createProbeTool(), "nested", { cmd: "probe" }),
		};
		await TOOL_EXECUTION_ENTRIES["session.tools"]
			.invoke(outer, "outer", {}, undefined, undefined, context)
			.catch(() => {});
		expect(probeExecuted).toBe(false);
		context.settings.override("tools.approval", {});
		await TOOL_EXECUTION_ENTRIES["session.tools"].invoke(outer, "outer-allowed", {}, undefined, undefined, context);
		expect(probeExecuted).toBe(true);
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

	it("ambient execution context provides toolContext to tool and policy to approval gate when caller passes no context", async () => {
		let handedContext: unknown = "never executed";
		const probe = {
			...createProbeTool(),
			execute: async (_id: string, _params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown) => {
				probeExecuted = true;
				handedContext = ctx;
				return { content: [{ type: "text", text: "PROBE_RAN" }] };
			},
		} as unknown as AgentTool;
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);
		const ambientContext = {
			settings: Settings.isolated({ "tools.approvalMode": "ask" }),
			sessionManager: {
				getSessionId: () => "ambient-session-123",
				getCwd: () => "",
			} as unknown as AgentToolContext["sessionManager"],
			sessionApprovals: createSessionApprovals(),
		};
		await TOOL_EXECUTION_ENTRIES["session.tools"].forward(ambientContext, async () => {
			await expect(wrapped.execute("ambient-call-refused", { cmd: "probe" })).rejects.toThrow(
				"no interactive UI available",
			);
		});
		expect(probeExecuted).toBe(false);

		ambientContext.settings.override("tools.approvalMode", "auto");
		await TOOL_EXECUTION_ENTRIES["session.tools"].forward(ambientContext, async () => {
			await wrapped.execute("ambient-call-allowed", { cmd: "probe" });
		});
		expect(probeExecuted).toBe(true);
		expect(handedContext).toBe(ambientContext);
	});

	it("a policy-only frame provides settings to approval gate but is not handed to tool as toolContext", async () => {
		let handedContext: unknown = "never executed";
		const probe = {
			...createProbeTool(),
			execute: async (_id: string, _params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown) => {
				probeExecuted = true;
				handedContext = ctx;
				return { content: [{ type: "text", text: "PROBE_RAN" }] };
			},
		} as unknown as AgentTool;
		const wrapped = new ExtensionToolWrapper(probe, mockRunner);
		const settings = Settings.isolated({ "tools.approvalMode": "ask" });
		const policyOnlyFrame = {
			settings,
			sessionApprovals: createSessionApprovals(),
			sessionManager: undefined,
		} as unknown as AgentToolContext;

		// 1. Policy-only frame reaches approval gate: 'ask' mode refuses when headless
		await expect(
			wrapped.execute("policy-only-refused", { cmd: "probe" }, undefined, undefined, policyOnlyFrame),
		).rejects.toThrow("no interactive UI available");
		expect(probeExecuted).toBe(false);

		// 2. Policy-only frame in 'auto' allows execution, but toolContext is stripped to undefined
		settings.override("tools.approvalMode", "auto");
		await wrapped.execute("policy-only-call", { cmd: "probe" }, undefined, undefined, policyOnlyFrame);
		expect(probeExecuted).toBe(true);
		expect(handedContext).toBeUndefined();

		// 3. Positive control: a frame with sessionManager is a real toolContext and reaches the tool
		const fullContext = {
			settings: Settings.isolated({ "tools.approvalMode": "auto" }),
			sessionManager: {
				getSessionId: () => "session-789",
				getCwd: () => "",
			} as unknown as AgentToolContext["sessionManager"],
			sessionApprovals: createSessionApprovals(),
		} as unknown as AgentToolContext;
		await wrapped.execute("full-context-call", { cmd: "probe" }, undefined, undefined, fullContext);
		expect(handedContext).toBe(fullContext);
	});

	it("approval event carries ambient sessionManager sessionId when caller passes no context", async () => {
		let requestedSessionId: string | undefined;
		const runnerWithHandler = {
			...mockRunner,
			hasHandlers: (event: string) => event === "tool_approval_requested",
			emit: async (event: { type?: string; sessionId?: string }) => {
				if (event.type === "tool_approval_requested") {
					requestedSessionId = event.sessionId;
				}
			},
		} as unknown as ExtensionRunner;
		const probe = createProbeTool();
		const wrapped = new ExtensionToolWrapper(probe, runnerWithHandler);
		const ambientContext = {
			settings: Settings.isolated({ "tools.approvalMode": "ask" }),
			sessionManager: {
				getSessionId: () => "ambient-session-456",
				getCwd: () => "",
			} as unknown as AgentToolContext["sessionManager"],
			sessionApprovals: createSessionApprovals(),
		};
		await TOOL_EXECUTION_ENTRIES["session.tools"].forward(ambientContext, async () => {
			await wrapped.execute("ambient-session-id-call", { cmd: "probe" }).catch(() => {});
		});
		expect(requestedSessionId).toBe("ambient-session-456");
	});
});
