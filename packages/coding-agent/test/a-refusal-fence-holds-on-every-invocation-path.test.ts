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

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
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
import { BUILTIN_TOOLS, HIDDEN_TOOLS, type Tool } from "@veyyon/coding-agent/tools";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/core/approval-modes";
import { declaresEffectScope } from "@veyyon/coding-agent/tools/core/effect-scope";
import { TOOL_EXECUTION_ENTRIES } from "@veyyon/coding-agent/tools/core/execution-registry";
import {
	checkRefusalFence,
	isToolRefused,
	RefusalFenceError,
	recordRefusal,
} from "@veyyon/coding-agent/tools/core/refusal-fence";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
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

/**
 * Every tool this build ships, constructed through the production factory table
 * a session builds from, keyed by the name the model calls.
 *
 * A factory decides for itself whether it applies to a session, so the result is
 * a partition rather than a list: constructed, `absent` (the factory declined),
 * and `threw`. Absent is returned rather than skipped, because a tool that
 * quietly stops constructing would be a silent hole in every sweep built on it.
 */
async function constructEveryProductionTool(
	session: ToolSession,
): Promise<{ byName: Map<string, Tool>; absent: string[]; threw: string[] }> {
	const byName = new Map<string, Tool>();
	const absent: string[] = [];
	const threw: string[] = [];
	for (const [name, factory] of [...Object.entries(BUILTIN_TOOLS), ...Object.entries(HIDDEN_TOOLS)]) {
		try {
			const tool = await factory(session);
			if (tool) byName.set(name, tool);
			else absent.push(name);
		} catch (error) {
			threw.push(`${name}: ${(error as Error).message.split("\n")[0]}`);
		}
	}
	return { byName, absent, threw };
}

/** Directories `createSweepSession` made, removed after each test. */
const sweepDirs: string[] = [];

/**
 * A session whose discovery inputs are one empty directory.
 *
 * `ssh` reads `ssh.json` out of the profile, and the skill, agent and dictionary
 * factories read the cwd, so on a developer machine those factories answer
 * differently than on a runner. Pointing both at an empty directory makes the
 * partition above a function of the settings alone.
 */
function createSweepSession(settings: Settings): ToolSession {
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-effect-scope-"));
	sweepDirs.push(empty);
	spyOn(settings, "getAgentDir").mockReturnValue(empty);
	return createMockToolSession({ settings, cwd: empty });
}

/** What `tool` claims about the paths it can reach, with the undeclared case named. */
function declaredScope(tool: Tool): string {
	return declaresEffectScope(tool) ? tool.effectScope : "undeclared";
}

function toolsDeclaring(byName: Map<string, Tool>, scope: string): string[] {
	return [...byName]
		.filter(([, tool]) => declaredScope(tool) === scope)
		.map(([name]) => name)
		.sort();
}

/** The names in `pool` the production fence let through, given `settings`. */
function escapedTheFence(pool: Iterable<[string, Tool]>, settings: Settings): string[] {
	return [...pool]
		.filter(([, tool]) => {
			try {
				TOOL_EXECUTION_ENTRIES["session.tools"].assert(
					tool,
					{ command: "echo unrelated", path: "/tmp/elsewhere" },
					{ settings },
				);
				return true;
			} catch (error) {
				return !(error instanceof RefusalFenceError);
			}
		})
		.map(([name]) => name);
}

describe("Universal Refusal Fence on Every Invocation Path", () => {
	beforeEach(() => {
		probeExecuted = false;
	});

	afterEach(() => {
		for (const dir of sweepDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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
	it("pending approval blocks now without poisoning a later exact one-shot retry", async () => {
		const settings = Settings.isolated();
		const context = { settings, sessionApprovals: createSessionApprovals(), sessionManager: { getCwd: () => "/repo" } } as unknown as AgentToolContext;
		let approved = false;
		const runner = {
			...mockRunner,
			hasHandlers: (event: string) => event === "tool_call",
			emitToolCall: async (event: { input: { cmd?: string } }) => {
				if (approved && event.input.cmd === "probe") {
					approved = false;
					return undefined;
				}
				return { block: true, disposition: "approval-required", reason: "Await exact approval" };
			},
		} as unknown as ExtensionRunner;
		const wrapped = new ExtensionToolWrapper(createProbeTool(), runner);
		await expect(wrapped.execute("pending", { cmd: "probe" }, undefined, undefined, context)).rejects.toThrow("Await exact approval");
		expect(isToolRefused(PROBE_TOOL_NAME, {}, context).refused).toBe(false);
		approved = true;
		await expect(wrapped.execute("changed", { cmd: "different" }, undefined, undefined, context)).rejects.toThrow("Await exact approval");
		await wrapped.execute("approved", { cmd: "probe" }, undefined, undefined, context);
		expect(probeExecuted).toBe(true);
		await expect(wrapped.execute("replay", { cmd: "probe" }, undefined, undefined, context)).rejects.toThrow("Await exact approval");
	});

	it("explicit extension refusal remains persistent", async () => {
		const settings = Settings.isolated();
		const context = { settings, sessionApprovals: createSessionApprovals(), sessionManager: { getCwd: () => "/repo" } } as unknown as AgentToolContext;
		const runner = {
			...mockRunner,
			hasHandlers: (event: string) => event === "tool_call",
			emitToolCall: async () => ({ block: true, disposition: "refused", reason: "Operator denied" }),
		} as unknown as ExtensionRunner;
		const wrapped = new ExtensionToolWrapper(createProbeTool(), runner);
		await expect(wrapped.execute("denied", { cmd: "probe" }, undefined, undefined, context)).rejects.toThrow("Operator denied");
		expect(isToolRefused(PROBE_TOOL_NAME, {}, context).refused).toBe(true);
	});

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
		// Bounded like the real `write`: it declares its targets AND that the list
		// is the call's complete effect set, which is what earns a tool the
		// path-scoped treatment instead of the opaque default.
		const write = Object.assign(createProbeTool("write"), {
			filesystemTargets: (args: { path: string }) => [args.path],
			effectScope: "declared-targets" as const,
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

	for (const kind of ["path", "command"] as const) {
		it(`real BashTool cannot bypass a ${kind} refusal with credential-only targets`, () => {
			const settings = Settings.isolated();
			const session = createMockToolSession({ settings });
			const bash = new BashTool(session);
			const command = "echo x > /repo/protected";
			recordRefusal("write", "protected target", undefined, settings, {
				kind,
				value: kind === "path" ? "/repo/protected" : command,
			});
			expect(bash.filesystemTargets({ command })).toEqual([]);
			expect(() => TOOL_EXECUTION_ENTRIES["session.tools"].assert(bash, { command }, { settings })).toThrow(
				RefusalFenceError,
			);
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// The declaration table, swept from the production factories.
	//
	// WHY THESE EXIST. The cases above drive probe objects, and a probe declares
	// whatever the test says it declares — so they proved the fence's shape
	// without proving anything about the tools that ship. These construct every
	// shipped tool the way a session does, and judge it by what it claims.
	//
	// WHAT THEY DO NOT CATCH. A tool whose factory declines here is unexercised
	// (the `absent` set below names all of them), and a tool that declares
	// `declared-targets` truthfully while its `filesystemTargets` under-reports
	// its own writes is invisible to any check at this layer.
	// ─────────────────────────────────────────────────────────────────────────

	it("pins what every shipped tool declares about the paths it can reach", async () => {
		const { byName, absent, threw } = await constructEveryProductionTool(createSweepSession(Settings.isolated()));
		expect(threw).toEqual([]);
		// Exact equality, so a new tool — or a tool that changes its claim —
		// fails here until someone records the decision. `unbounded` is the set
		// that must never lose a member by accident: `bash` sits in it because
		// its `filesystemTargets` reports credential paths only, which is the
		// inversion issue #37 was reported for.
		expect(toolsDeclaring(byName, "declared-targets")).toEqual([
			"ast_edit",
			"edit",
			"inspect_image",
			"read",
			"search",
			"set_cwd",
			"write",
		]);
		expect(toolsDeclaring(byName, "unbounded")).toEqual(["bash", "browser", "debug", "eval", "launch", "task"]);
		// `github` constructs only where the `gh` CLI is installed
		// (`GithubTool.createIf` consults `git.github.available()`), so which
		// partition it lands in is a fact about the host rather than about the
		// fence: present on a developer machine, absent in the test sandbox. Its
		// claim is pinned separately below, which is the part that matters.
		const hostDependent = new Set(["github"]);
		const stable = (names: string[]) => names.filter(name => !hostDependent.has(name));
		// The fail-closed floor, with its cost stated rather than hidden: while a
		// path refusal stands these are fenced too, session-state tools among
		// them. Nothing becomes bounded by forgetting to declare, which is the
		// direction to be wrong in.
		expect(stable(toolsDeclaring(byName, "undeclared"))).toEqual([
			"checkpoint",
			"goal",
			"job",
			"report_finding",
			"report_tool_issue",
			"resolve",
			"rewind",
			"todo",
			"web_search",
			"yield",
		]);
		// Wherever it constructed, `github` drives the `gh` CLI, so it can reach
		// any path and must never claim to be bounded.
		const github = byName.get("github");
		if (github) expect(declaredScope(github)).toBe("undeclared");
		// Every tool this sweep could not build, named rather than left to be
		// discovered by the next person who trusts the sweep.
		expect(stable(absent.sort())).toEqual([
			"argot_load",
			"argot_unload",
			"ask",
			"irc",
			"learn",
			"lsp",
			"manage_skill",
			"memory_edit",
			"recall",
			"reflect",
			"retain",
			"search_tool_bm25",
			"ssh",
		]);
	}, 30_000);

	for (const kind of ["path", "command"] as const) {
		it(`a standing ${kind} refusal fences every shipped tool that cannot bound itself`, async () => {
			const settings = Settings.isolated();
			const { byName } = await constructEveryProductionTool(createSweepSession(settings));
			recordRefusal("write", "protected target", undefined, settings, {
				kind,
				value: kind === "path" ? "/repo/protected" : "echo x > /repo/protected",
			});
			// Arguments naming neither the refused path nor the refused command:
			// an unbounded tool is fenced for every call while the refusal
			// stands, because nothing in its arguments bounds it.
			const unbounded = [...byName].filter(([, tool]) => declaredScope(tool) === "unbounded");
			expect(unbounded.length).toBeGreaterThanOrEqual(6);
			expect(escapedTheFence(unbounded, settings)).toEqual([]);
			const undeclared = [...byName].filter(([, tool]) => declaredScope(tool) === "undeclared");
			expect(undeclared.length).toBeGreaterThanOrEqual(6);
			expect(escapedTheFence(undeclared, settings)).toEqual([]);
		}, 30_000);
	}

	it("keeps path scoping for a shipped tool whose declared targets are its whole effect set", async () => {
		const settings = Settings.isolated();
		const { byName } = await constructEveryProductionTool(createSweepSession(settings));
		recordRefusal("write", "protected target", undefined, settings, { kind: "path", value: "/repo/protected" });
		const cases = [
			{ tool: "write", args: { path: "/repo/protected" }, refused: true },
			// Non-normalized, and it must still land on the refused path.
			{ tool: "write", args: { path: "/repo/sub/../protected" }, refused: true },
			{ tool: "write", args: { path: "/repo/other" }, refused: false },
			{ tool: "read", args: { path: "/repo/protected/inner.txt" }, refused: true },
			{ tool: "read", args: { path: "/repo/elsewhere.txt" }, refused: false },
			{ tool: "search", args: { type: "text", input: "x", path: "/repo/protected" }, refused: true },
			{ tool: "search", args: { type: "text", input: "x", path: "/repo/other" }, refused: false },
			// The candidate is a DIRECTORY holding the refused path. Containment
			// has to run both ways, or a sweep rooted at `/repo` reads it.
			{ tool: "search", args: { type: "text", input: "x", path: "/repo" }, refused: true },
		];
		const observed = cases.map(item => ({
			...item,
			refused: isToolRefused(item.tool, item.args, { settings }, undefined, byName.get(item.tool)).refused,
		}));
		expect(observed).toEqual(cases);
	}, 30_000);

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
			// `write`/`edit` declare a complete target set, so they are fenced by
			// the path OVERLAP check rather than by the opaque default — the
			// non-normalized `/repo/sub/../protected` must still resolve onto the
			// refused path. `bash`/`eval` stay opaque and are fenced as such.
			const probe =
				name === "edit" || name === "write"
					? Object.assign(createProbeTool(name), {
							filesystemTargets: () => ["/repo/sub/../protected"],
							effectScope: "declared-targets" as const,
						})
					: createProbeTool(name);
			probeExecuted = false;
			await new ExtensionToolWrapper(probe, undefined)
				.execute("reroute", { path: "/repo/protected", cmd: "opaque" }, undefined, undefined, context)
				.catch(() => {});
			expect(probeExecuted).toBe(false);
		});
	}

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
		const settings = Settings.isolated({ "tools.refusals": [PROBE_TOOL_NAME] });
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

		settings.override("tools.refusals", []);
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
