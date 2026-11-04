/**
 * The active tool set and the system prompt rendered for it follow every change to either.
 *
 * Subject: `session/runtime/tool-activation.ts`, driven through `AgentSession`.
 *
 * WHY THIS SUITE EXISTS. Moving the active-tool and base-prompt state out of `agent-session.ts`
 * into its own collaborator ran a mutation pass over every branch of it, and fifteen branches
 * could be deleted with the whole session suite still green. Each is a promise the session makes
 * to a caller that nothing held it to: a tool set change that drops a fork's inherited cache key,
 * a prompt change that leaves a record in the transcript, an explicit rebuild that a following
 * no-op tool change does not repeat, a model key that a tool-set rebuild already rendered, the
 * allowlist an SSH reload honours, the RPC and vibe tool sets that refuse duplicate and colliding
 * names and hide hidden tools, the session-default MCP selection a resumed transcript falls back
 * to, a navigation that leaves MCP tools alone with discovery off, a failed switch that puts the
 * base prompt back, a dropped tool name that leaves a log line, the auto-QA tool that outlives a
 * tool change, and the idle state an MCP tool reads in the middle of a turn.
 *
 * THE CLASS. A tool-set or prompt transition whose effect is visible only to a later request, a
 * later transcript reader, or a later session switch. Every case drives the public session
 * surface and asserts what that later reader receives: the request a provider gets, the active
 * tool names, the transcript entries, the discard record, or the rejection.
 *
 * WHAT IT DOES NOT CATCH. The SSH allowlist is proven in `agent-session-ssh-refresh.test.ts`,
 * where its fixture now starts without an `ssh` tool so the allowlist is what keeps it inactive.
 * The digest inputs (descriptions, server instructions, the calendar date) are proven in
 * `agent-session-tool-rebuild-skip.test.ts`. A failed switch whose MCP restoration succeeds
 * rebuilds the base prompt again on its own, so only the failed-restoration case below depends
 * on the captured prompt being put back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolResult } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import type { CustomTool } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionConfig } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const DOCS = "mcp__docs_search";
const SLACK = "mcp__slack_send_message";

function basicTool(name: string, extra: Partial<AgentTool> = {}): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute(): Promise<AgentToolResult> {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
		...extra,
	};
}

function mcpTool(name: string, serverName: string, mcpToolName: string): AgentTool {
	return {
		...basicTool(name),
		label: `${serverName}/${mcpToolName}`,
		mcpServerName: serverName,
		mcpToolName,
	} as AgentTool;
}

function mcpCustomTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	execute: CustomTool["execute"] = async () => ({ content: [{ type: "text", text: `${name} executed` }] }),
): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `${name} tool`,
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		execute,
	} as CustomTool;
}

interface Built {
	session: AgentSession;
	mock: MockModel;
	sessionManager: SessionManager;
	/** The tool names of every `rebuildSystemPrompt` call, in order. */
	rebuilds: string[][];
}

interface BuildOptions {
	registry: AgentTool[];
	/** Names from `registry` the agent starts with. */
	active: string[];
	settings?: Record<string, unknown>;
	sessionManager?: SessionManager;
	/** Renders the prompt for a tool set; throwing fails the rebuild. */
	render?: (toolNames: string[], session: AgentSession) => string;
	promptCacheKey?: string;
	config?: Partial<AgentSessionConfig>;
}

describe("the active tool set and its prompt follow every change", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("veyyon-tool-activation-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function build(options: BuildOptions): Built {
		const mock = createMockModel({ handler: { content: ["ok"], stopReason: "stop" } });
		const byName = new Map(options.registry.map(tool => [tool.name, tool]));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: mock,
				systemPrompt: ["origin"],
				tools: options.active.map(name => {
					const tool = byName.get(name);
					if (!tool) throw new Error(`no registry tool named ${name}`);
					return tool;
				}),
				messages: [],
			},
			streamFn: mock.stream,
			promptCacheKey: options.promptCacheKey,
		});
		const sessionManager = options.sessionManager ?? SessionManager.inMemory(tempDir.path());
		const rebuilds: string[][] = [];
		const render = options.render ?? (toolNames => `tools:${toolNames.join(",")}`);
		let session: AgentSession | undefined;
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false, ...options.settings }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: byName,
			rebuildSystemPrompt: async toolNames => {
				if (!session) throw new Error("rebuilt before the session existed");
				const prompt = render(toolNames, session);
				rebuilds.push([...toolNames]);
				return { systemPrompt: [prompt] };
			},
			...options.config,
		});
		sessions.push(session);
		return { session, mock, sessionManager, rebuilds };
	}

	/** A persisted transcript in the temp directory, returned by its file. */
	async function persistedTranscript(prepare?: (manager: SessionManager) => void): Promise<string> {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "earlier", timestamp: 1 });
		manager.appendMessage(createAssistantMessage("answered"));
		prepare?.(manager);
		await manager.flush();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("expected a persisted transcript file");
		return file;
	}

	/** The system prompt the provider received on the most recent request. */
	function lastRequestPrompt(mock: MockModel): string {
		const call = mock.calls.at(-1);
		if (!call) throw new Error("the provider received no request");
		return call.context.systemPrompt?.join("\n") ?? "";
	}

	describe("rebuilds and their records", () => {
		it("discards a fork's inherited cache key when a later tool set change rebuilds the prompt", async () => {
			const { session, rebuilds } = build({
				registry: [basicTool("read"), basicTool("lookup")],
				active: ["read"],
				promptCacheKey: "parent-shard",
				config: { providerPromptCacheKeySource: "fork" },
			});

			// The first build replaces the constructor's prompt; the fork's key still describes the
			// prefix the parent sent, so it is kept.
			await session.setActiveToolsByName(["read"]);
			expect(rebuilds).toHaveLength(1);
			expect(session.providerCacheKeyDiscards()).toEqual([]);
			expect(session.agent.promptCacheKey).toBe("parent-shard");

			await session.setActiveToolsByName(["read", "lookup"]);

			expect(rebuilds).toHaveLength(2);
			expect(session.providerCacheKeyDiscards()).toEqual(["tool-signature-change"]);
			expect(session.agent.promptCacheKey).toBeUndefined();
		});

		it("writes every changed prompt into the transcript with the reason it changed", async () => {
			let version = 1;
			const { session, sessionManager } = build({
				registry: [basicTool("read")],
				active: ["read"],
				render: () => `prompt-v${version}`,
			});

			await session.refreshBaseSystemPrompt("cwd-change");
			version = 2;
			await session.refreshBaseSystemPrompt("memory-clear");
			// Same bytes again: not an invalidation, so no entry.
			await session.refreshBaseSystemPrompt("secrets-refresh");

			const recorded = sessionManager
				.getEntries()
				.filter(entry => entry.type === "custom_message" && entry.customType === "prompt_cache_invalidated")
				.map(entry => (entry.type === "custom_message" ? entry.details : undefined));
			expect(recorded).toEqual([
				{ reason: "cwd-change", index: 1, previousChars: "origin".length, nextChars: "prompt-v1".length },
				{ reason: "memory-clear", index: 2, previousChars: "prompt-v1".length, nextChars: "prompt-v2".length },
			]);
		});

		it("does not rebuild again for an unchanged tool set after an explicit rebuild", async () => {
			const { session, rebuilds } = build({ registry: [basicTool("read")], active: ["read"] });

			await session.refreshBaseSystemPrompt("argot-arm");
			await session.setActiveToolsByName(["read"]);

			expect(rebuilds).toEqual([["read"]]);
		});

		it("does not rebuild on a model switch the last tool set rebuild already rendered", async () => {
			const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models-switch.yml"));
			const target = registry.getAll().find(model => model.provider !== "mock");
			if (!target) throw new Error("expected a bundled model");
			authStorage.setRuntimeApiKey(target.provider, "key-b");
			const { session, rebuilds } = build({
				registry: [basicTool("read"), basicTool("lookup")],
				active: ["read"],
				settings: { includeModelInPrompt: true },
				render: (toolNames, current) => `model:${current.model?.id} tools:${toolNames.join(",")}`,
				config: { modelRegistry: registry },
			});

			// The agent moves without the session's model-change sync, as a transcript restore does,
			// and the next tool change renders the prompt for the model now in force.
			session.agent.setModel(target);
			await session.setActiveToolsByName(["read", "lookup"]);
			expect(session.systemPrompt).toEqual([`model:${target.id} tools:read,lookup`]);

			await session.setModel(target);

			expect(rebuilds).toHaveLength(1);
			expect(session.systemPromptInvalidations()).toEqual([]);
		});

		it("logs every requested tool name the registry does not hold", async () => {
			const warn = vi.spyOn(logger, "warn");
			const { session } = build({ registry: [basicTool("read")], active: ["read"] });

			await session.setActiveToolsByName(["read", "retired_tool", "other_retired"]);

			expect(session.getActiveToolNames()).toEqual(["read"]);
			const dropped = warn.mock.calls.filter(
				([message]) => message === "requested tools are not in the session registry and were dropped",
			);
			expect(dropped.map(([, fields]) => (fields as { dropped: string[] }).dropped)).toEqual([
				["retired_tool", "other_retired"],
			]);
		});

		it("keeps the auto-QA tool active across a tool set change only while auto-QA is on", async () => {
			const registry = [basicTool("read"), basicTool("lookup"), basicTool("report_tool_issue")];
			const on = build({ registry, active: ["read", "report_tool_issue"], settings: { "dev.autoqa": true } });
			const off = build({ registry, active: ["read", "report_tool_issue"], settings: { "dev.autoqa": false } });

			await on.session.setActiveToolsByName(["lookup"]);
			await off.session.setActiveToolsByName(["lookup"]);

			expect(on.session.getActiveToolNames()).toEqual(["lookup", "report_tool_issue"]);
			expect(off.session.getActiveToolNames()).toEqual(["lookup"]);
		});
	});

	describe("runtime tool sets", () => {
		it("rejects RPC host tools that share a name", async () => {
			const { session } = build({ registry: [basicTool("read")], active: ["read"] });

			await expect(session.refreshRpcHostTools([basicTool("host_open"), basicTool("host_open")])).rejects.toThrow(
				"RPC host tool names must be unique",
			);
			expect(session.getAllToolNames()).not.toContain("host_open");
		});

		it("rejects an RPC host tool named like a tool the session already has, but not its own", async () => {
			const { session } = build({ registry: [basicTool("read")], active: ["read"] });

			await expect(session.refreshRpcHostTools([basicTool("read")])).rejects.toThrow(
				'RPC host tool "read" conflicts with an existing tool',
			);

			await session.refreshRpcHostTools([basicTool("host_open")]);
			await session.refreshRpcHostTools([basicTool("host_open", { description: "replaced" })]);
			expect(session.getToolByName("host_open")?.description).toBe("replaced");
		});

		it("activates new visible RPC host tools and leaves hidden ones registered but inactive", async () => {
			const { session } = build({ registry: [basicTool("read")], active: ["read"] });

			await session.refreshRpcHostTools([basicTool("host_open"), basicTool("host_secret", { hidden: true })]);

			expect(session.getAllToolNames()).toContain("host_secret");
			expect(session.getActiveToolNames()).toEqual(["read", "host_open"]);
		});

		it("rejects vibe tools that share a name and installs none of them", async () => {
			const { session } = build({
				registry: [basicTool("read")],
				active: ["read"],
				config: { createVibeTools: () => [basicTool("vibe_go"), basicTool("vibe_go")] },
			});

			await expect(session.activateVibeTools(["read"])).rejects.toThrow("Vibe tool names must be unique.");
			expect(session.getAllToolNames()).not.toContain("vibe_go");
			expect(session.getActiveToolNames()).toEqual(["read"]);
		});
	});

	describe("MCP selections across transcripts", () => {
		it("leaves active MCP tools alone on a tree navigation while discovery is off", async () => {
			const sessionManager = SessionManager.inMemory(tempDir.path());
			const firstUser = sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
			sessionManager.appendMessage(createAssistantMessage("answered"));
			const { session } = build({
				registry: [basicTool("read"), mcpTool(DOCS, "docs", "search")],
				active: ["read", DOCS],
				sessionManager,
			});

			await session.navigateTree(firstUser);

			expect(session.getActiveToolNames()).toEqual(["read", DOCS]);
		});

		it("resumes a transcript with no recorded MCP selection on the defaults its servers offered", async () => {
			const origin = SessionManager.create(tempDir.path(), tempDir.path());
			origin.appendMessage({ role: "user", content: "origin", timestamp: 1 });
			origin.appendMessage(createAssistantMessage("origin answered"));
			await origin.flush();
			const originFile = origin.getSessionFile();
			if (!originFile) throw new Error("expected the origin transcript to have a file");
			const other = await persistedTranscript();
			const { session } = build({
				registry: [basicTool("read")],
				active: ["read"],
				sessionManager: origin,
				config: { defaultSelectedMCPServerNames: ["slack"] },
			});

			// The servers connect while discovery is still off, so nothing is selected or recorded in
			// the transcript; discovery turns on once the tool count is known.
			await session.refreshMCPTools([mcpCustomTool(DOCS, "docs", "search"), mcpCustomTool(SLACK, "slack", "send")]);
			expect(session.getActiveToolNames()).toEqual(["read"]);
			session.enableMCPDiscovery();

			await session.switchSession(other);
			await session.switchSession(originFile);

			expect(session.getActiveToolNames()).toEqual(["read", SLACK]);
		});

		it("sends the original prompt after a failed switch whose MCP restoration also failed", async () => {
			const target = await persistedTranscript(manager => manager.appendMCPToolSelection([DOCS]));
			let failNextRestore = false;
			const { session, mock, rebuilds } = build({
				registry: [basicTool("read"), mcpTool(DOCS, "docs", "search")],
				active: ["read"],
				sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
				config: { mcpDiscoveryEnabled: true },
				render: toolNames => {
					if (failNextRestore && !toolNames.includes(DOCS)) {
						failNextRestore = false;
						throw new Error("the restored tool set could not be rendered");
					}
					return `tools:${toolNames.join(",")}`;
				},
			});
			const readSetting = session.settings.get.bind(session.settings);
			let failThinkingRead = false;
			vi.spyOn(session.settings, "get").mockImplementation(((key: SettingPath) => {
				if (failThinkingRead && key === "defaultThinkingLevel") {
					failThinkingRead = false;
					throw new Error("the target transcript could not be adopted");
				}
				return readSetting(key);
			}) as Settings["get"]);

			failNextRestore = true;
			failThinkingRead = true;
			await expect(session.switchSession(target)).rejects.toThrow(
				"Failed to switch sessions and fully restore the previous runtime.",
			);
			// The switch rendered the target's tool set before it failed, so the base prompt moved.
			expect(rebuilds).toEqual([["read", DOCS]]);
			expect(session.getActiveToolNames()).toEqual(["read"]);

			await session.prompt("after the failed switch");
			await session.waitForIdle();

			expect(lastRequestPrompt(mock)).toContain("origin");
			expect(lastRequestPrompt(mock)).not.toContain(DOCS);
		});
	});

	it("tells an MCP tool running inside a turn that the session is busy", async () => {
		const idleSeen: boolean[] = [];
		const { session, mock } = build({ registry: [basicTool("read")], active: ["read"] });
		await session.refreshMCPTools(
			[
				mcpCustomTool(DOCS, "docs", "search", async (_id, _params, _onUpdate, ctx) => {
					idleSeen.push(ctx.isIdle());
					return { content: [{ type: "text", text: "found" }] };
				}),
			],
			{ activateAll: true },
		);
		mock.push({ content: [{ type: "toolCall", name: DOCS, arguments: { q: "x" } }] });
		mock.push({ content: ["done"] });

		await session.prompt("search the docs");
		await session.waitForIdle();

		expect(idleSeen).toEqual([false]);
		expect(session.isStreaming).toBe(false);
	});
});
