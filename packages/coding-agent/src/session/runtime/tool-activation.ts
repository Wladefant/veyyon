/**
 * The active tool set and the base system prompt rendered for it: which registered tools go on
 * the wire and in what order, the rebuild that follows a change to them, the digest that skips a
 * rebuild when nothing the prompt reads moved, the record of every mid-session prompt change, and
 * the registry refreshes (MCP, RPC host, SSH, vibe) that each end in a new active set.
 *
 * This is a session collaborator. Its state is the base system prompt, its invalidation record,
 * the applied-tool digest, the model key the prompt was rendered for, and the names of the RPC host
 * and vibe tools it installed. It reaches the session only through {@link ToolActivationSession}
 * and {@link ToolActivationHost}.
 */
import { createHash } from "node:crypto";
import type { Agent, AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";
import { localCalendarDate } from "@veyyon/utils/local-time";
import { formatModelString } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { loadCapability, reset as resetCapabilities } from "../../discovery/capability";
import { isMCPToolName } from "../../discovery/tool-index";
import type { CustomTool, CustomToolContext } from "../../extensibility/custom-tools/types";
import { CustomToolAdapter } from "../../extensibility/custom-tools/wrapper";
import { ExtensionToolWrapper } from "../../extensibility/extensions/wrapper";
import { invalidateHostMetadata } from "../../ssh/connection-manager";
import { usesCodexTaskPrompt } from "../../task/prompt-policy";
import { isAutoQaEnabled } from "../../tools/agent/report-tool-issue";
import { normalizeToolNames, TOOL } from "../../tools/core/builtin-names";
import { wrapToolWithMetaNotice } from "../../tools/core/output-meta";
import { isToolOrderPermutation } from "../agent-session-provider-request";
import type { AgentSessionConfig } from "../agent-session-types";
import type { ToolDiscovery } from "./tool-discovery";

/**
 * Cache key for model-dependent prompt content: the displayed id or the hidden-policy cohort, marked
 * when the prompt teaches Argot shorthand. The cohort alone is not enough: two models in one cohort,
 * one on the encode allowlist and one off it, render different prompts, and a switch between them
 * must rebuild or the handle table stays with the model it was not meant for.
 */
function promptModelKeyFor(
	settings: Settings,
	model: Model | undefined,
	argotTeaches: ((model: Model) => boolean) | undefined,
): string | undefined {
	if (!model) return undefined;
	const id = formatModelString(model);
	const key = settings.get("includeModelInPrompt")
		? id
		: usesCodexTaskPrompt(id)
			? "task-policy:gpt-5.6"
			: "task-policy:default";
	return argotTeaches?.(model) ? `${key}+argot` : key;
}

/** What {@link ToolActivation} reads from the session's public surface. */
export interface ToolActivationSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly model: Model | undefined;
	readonly sessionFile: string | undefined;
	getActiveToolNames(): string[];
	getSelectedMCPToolNames(): string[];
}

/** What {@link ToolActivation} needs from the session beyond its public surface. */
export interface ToolActivationHost {
	/** The session's tool registry, every tool the session can activate, keyed by name. */
	readonly registry: Map<string, AgentTool>;
	readonly discovery: ToolDiscovery;
	readonly approvals: { wrapForClient<T extends AgentTool>(tool: T): T };
	readonly providerSessions: { clearInheritedCacheKey(reason: string): void };
	readonly config: Pick<
		AgentSessionConfig,
		| "createVibeTools"
		| "extensionRunner"
		| "getLocalCalendarDate"
		| "getMcpServerInstructions"
		| "argotTeaches"
		| "rebuildSystemPrompt"
		| "reloadSshTool"
		| "requestedToolNames"
		| "setActiveToolNames"
	>;
	/** The context an MCP custom tool runs against. */
	customToolContext(): CustomToolContext;
}

export class ToolActivation {
	readonly #session: ToolActivationSession;
	readonly #host: ToolActivationHost;
	#baseSystemPrompt: string[];
	/**
	 * Every mid-session system-prompt change, in order, by the reason its caller
	 * gave. Each entry is one full prefix-cache invalidation, so this doubles as
	 * the running count of "turns that had to re-read the whole context as fresh
	 * input". Exposed through {@link systemPromptInvalidations} so a bench or a
	 * cost report can attribute cache misses to the subsystem that caused them.
	 */
	readonly #baseSystemPromptInvalidations: string[] = [];
	/**
	 * Signature of the (toolNames, tool descriptions) tuple passed to the most
	 * recent successful `rebuildSystemPrompt` call. Used to skip redundant rebuilds
	 * when MCP servers reconnect without changing their tool definitions, which is
	 * the dominant cause of prompt-cache invalidation in long sessions.
	 */
	#lastAppliedToolSignature: string | undefined;
	/**
	 * Model identifier (`provider/id`) currently rendered into `#baseSystemPrompt`.
	 * The prompt surfaces the active model to the agent, so a model switch must
	 * trigger a rebuild. Compared against the live model after every model change
	 * to decide whether the cached prompt is stale.
	 */
	#promptModelKey: string | undefined;
	#rpcHostToolNames = new Set<string>();
	#installedVibeToolNames = new Set<string>();

	constructor(session: ToolActivationSession, host: ToolActivationHost) {
		this.#session = session;
		this.#host = host;
		this.#baseSystemPrompt = session.agent.state.systemPrompt;
		this.#promptModelKey = this.#livePromptModelKey();
	}

	/** The base system prompt, without any per-turn `before_agent_start` override. */
	get baseSystemPrompt(): string[] {
		return this.#baseSystemPrompt;
	}

	/** Restores the prompt a failed session switch captured; the agent is restored separately. */
	set baseSystemPrompt(prompt: string[]) {
		this.#baseSystemPrompt = prompt;
	}

	/** Whether the live model renders a different prompt from the one in force. */
	promptModelMoved(): boolean {
		return this.#livePromptModelKey() !== this.#promptModelKey;
	}

	#livePromptModelKey(): string | undefined {
		return promptModelKeyFor(this.#session.settings, this.#session.model, this.#host.config.argotTeaches);
	}

	#wrapRuntimeTool(tool: AgentTool): AgentTool {
		const wrapped = wrapToolWithMetaNotice(tool);
		return this.#host.config.extensionRunner
			? new ExtensionToolWrapper(wrapped, this.#host.config.extensionRunner)
			: wrapped;
	}

	/**
	 * Registers the ephemeral vibe tools and activates them alongside `baseToolNames`.
	 *
	 * @throws When this session cannot create vibe tools or the factory returns duplicate names.
	 */
	async activateVibeTools(baseToolNames: string[]): Promise<void> {
		const createVibeTools = this.#host.config.createVibeTools;
		if (!createVibeTools) {
			throw new Error("Vibe tools are unavailable in this session.");
		}

		const tools = await createVibeTools();
		const vibeToolNames = tools.map(tool => tool.name);
		if (new Set(vibeToolNames).size !== vibeToolNames.length) {
			throw new Error("Vibe tool names must be unique.");
		}

		for (const tool of tools) {
			if (this.#host.registry.has(tool.name)) continue;
			this.#host.registry.set(tool.name, this.#wrapRuntimeTool(tool));
			this.#host.discovery.addBuiltIn(tool.name);
			this.#installedVibeToolNames.add(tool.name);
		}

		await this.apply(Array.from(new Set(baseToolNames.concat(vibeToolNames))));
	}

	/** Removes tools installed by {@link activateVibeTools} and activates `nextToolNames`. */
	async deactivateVibeTools(nextToolNames: string[]): Promise<void> {
		for (const name of this.#installedVibeToolNames) {
			this.#host.registry.delete(name);
			this.#host.discovery.removeBuiltIn(name);
			this.#host.discovery.deselect(name);
		}
		this.#installedVibeToolNames.clear();
		await this.apply(nextToolNames);
	}

	/**
	 * Makes `toolNames` the active tool set and rebuilds the base system prompt when the digest of
	 * what the prompt reads moved. Names the registry does not hold are dropped and logged, the
	 * auto-QA tool is kept while auto-QA is on, and a permutation of the set on the wire keeps the
	 * wire's order. The MCP selection is recorded in the transcript when it changed from
	 * `previousSelectedMCPToolNames`, unless `persistMCPSelection` is false.
	 */
	async apply(
		toolNames: string[],
		options?: { persistMCPSelection?: boolean; previousSelectedMCPToolNames?: string[] },
	): Promise<void> {
		toolNames = normalizeToolNames(toolNames);
		const previousSelectedMCPToolNames =
			options?.previousSelectedMCPToolNames ?? this.#session.getSelectedMCPToolNames();
		const tools: AgentTool[] = [];
		let validToolNames: string[] = [];
		// A requested name the registry does not hold is dropped, because a stale
		// selection naming a tool this build no longer ships must not fail a whole
		// session. It is LOGGED because dropping it silently is how a tool goes
		// missing for weeks: the session advertised 22 tools and sent 21, the model
		// simply never called the absent one, and nothing anywhere said a name had
		// been asked for and not found. Any future wiring defect that removes a tool
		// from the registry now leaves a record naming it.
		const droppedToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this.#host.registry.get(name);
			if (tool) {
				tools.push(this.#host.approvals.wrapForClient(tool));
				validToolNames.push(name);
			} else {
				droppedToolNames.push(name);
			}
		}
		if (droppedToolNames.length > 0) {
			logger.warn("requested tools are not in the session registry and were dropped", {
				sessionId: this.#session.sessionManager.getSessionId(),
				dropped: droppedToolNames,
				model: this.#session.model ? `${this.#session.model.provider}/${this.#session.model.id}` : undefined,
			});
		}
		// Auto-QA tool must survive any runtime tool-set mutation.
		if (isAutoQaEnabled(this.#session.settings) && !validToolNames.includes(TOOL.report_tool_issue)) {
			const qaTool = this.#host.registry.get(TOOL.report_tool_issue);
			if (qaTool) {
				tools.push(this.#host.approvals.wrapForClient(qaTool));
				validToolNames.push(TOOL.report_tool_issue);
			}
		}
		// A permutation of the tool set already on the wire keeps the order it is
		// replacing. The provider-bound `tools` array is part of the cached prompt
		// prefix, and tools are addressed by name, so their order means nothing to the
		// model and everything to the cache: reordering the same set re-serializes the
		// prefix from the tools block onward and the next request pays full input rate
		// for it. Several callers hand over a different order for an unchanged set --
		// `refreshSshTool` filters `ssh` out and re-pushes it at the tail,
		// `restoreMCPSelections` emits every non-MCP tool ahead of
		// every MCP one, and plan/goal-mode exit replays a list saved before later
		// activations moved it. None of them intends a change, and the token count does
		// not move, which is why the cost was invisible: the provider simply served
		// fewer cached tokens than the system+tools prefix is long.
		const currentToolNames = this.#session.agent.state.tools.map(tool => tool.name);
		if (isToolOrderPermutation(currentToolNames, validToolNames)) {
			const byName = new Map(validToolNames.map((name, index) => [name, tools[index]]));
			validToolNames = [...currentToolNames];
			tools.length = 0;
			for (const name of currentToolNames) {
				const tool = byName.get(name);
				if (tool) tools.push(tool);
			}
		}
		this.#host.discovery.followActiveMCP(validToolNames);
		this.#host.config.setActiveToolNames?.(validToolNames);
		this.#session.agent.setTools(tools);
		// Active tool set changed → discoverable tool list (which excludes already-active tools)
		// is now stale. Settle before any prompt-template hook reads the discovery list.
		this.#host.discovery.settleActive(validToolNames);

		// Rebuild base system prompt with new tool set, but only when the tool set
		// actually changed. MCP servers can reconnect at arbitrary times and call
		// `refreshMCPTools` -> `apply` even though the resulting
		// tool list is byte-identical. Skipping the rebuild keeps the system prompt
		// stable, which is required for Anthropic prompt caching to keep hitting.
		const rebuildSystemPrompt = this.#host.config.rebuildSystemPrompt;
		if (rebuildSystemPrompt) {
			const signature = this.#signature(validToolNames, tools);
			if (signature !== this.#lastAppliedToolSignature) {
				if (this.#lastAppliedToolSignature !== undefined) {
					this.#host.providerSessions.clearInheritedCacheKey("tool-signature-change");
				}
				const built = await rebuildSystemPrompt(validToolNames, this.#host.registry);
				this.#baseSystemPrompt = built.systemPrompt;
				this.#session.agent.setSystemPrompt(this.#baseSystemPrompt);
				this.#lastAppliedToolSignature = signature;
				this.#promptModelKey = this.#livePromptModelKey();
			}
		}
		if (options?.persistMCPSelection !== false) {
			const nextSelectedMCPToolNames = this.#host.discovery.selectedMCPChangedFrom(previousSelectedMCPToolNames);
			if (nextSelectedMCPToolNames) this.#session.sessionManager.appendMCPToolSelection(nextSelectedMCPToolNames);
		}
	}

	/**
	 * Reload the SSH tool from disk-backed capability discovery and make the
	 * refreshed definition visible to the next model call without restarting.
	 */
	async refreshSshTool(options?: { activateIfAvailable?: boolean }): Promise<void> {
		resetCapabilities();
		const reloadSshTool = this.#host.config.reloadSshTool;
		if (!reloadSshTool) return;
		const previousSshTool = this.#host.registry.get(TOOL.ssh);
		const previousActiveToolNames = this.#session.getActiveToolNames();
		const hadSshTool = previousSshTool !== undefined;
		const wasActive = previousActiveToolNames.includes(TOOL.ssh);
		const previousHostNames =
			previousSshTool && "hostNames" in previousSshTool && Array.isArray(previousSshTool.hostNames)
				? [...previousSshTool.hostNames]
				: [];
		const candidateHostNames = new Set(previousHostNames);
		const capability = await loadCapability<{ name: string }>(TOOL.ssh, {
			cwd: this.#session.sessionManager.getCwd(),
		});
		for (const host of capability.items) {
			if (typeof host?.name === "string") {
				candidateHostNames.add(host.name);
			}
		}
		await invalidateHostMetadata(candidateHostNames);
		const requestedToolNames = this.#host.config.requestedToolNames;
		const sshAllowed = requestedToolNames === undefined || requestedToolNames.has(TOOL.ssh);
		const refreshedTool = await reloadSshTool();
		if (refreshedTool) {
			this.#host.registry.set(refreshedTool.name, refreshedTool);
		} else {
			this.#host.registry.delete(TOOL.ssh);
			this.#host.discovery.deselect(TOOL.ssh);
		}

		const nextActive = previousActiveToolNames.filter(name => name !== TOOL.ssh && this.#host.registry.has(name));
		if (refreshedTool && sshAllowed && (wasActive || (options?.activateIfAvailable && !hadSshTool))) {
			nextActive.push(refreshedTool.name);
		}
		await this.apply(nextActive);
	}

	async restoreMCPSelections(
		sessionContext: SessionContext,
		options?: { fallbackSelectedMCPToolNames?: Iterable<string> },
	): Promise<void> {
		if (!this.#host.discovery.mcpEnabled) return;
		const nextActiveNonMCPToolNames = this.#host.discovery.activeNonMCP();
		const fallbackSelectedMCPToolNames =
			options?.fallbackSelectedMCPToolNames ?? this.#host.discovery.configuredDefaultMCP();
		const restoredMCPToolNames = this.#host.discovery.selectableMCP(
			sessionContext.hasPersistedMCPToolSelection
				? sessionContext.selectedMCPToolNames
				: fallbackSelectedMCPToolNames,
		);
		this.#host.discovery.rememberSessionDefaults(this.#session.sessionFile);
		await this.apply([...nextActiveNonMCPToolNames, ...restoredMCPToolNames], {
			persistMCPSelection: false,
		});
	}

	/**
	 * Reasons for every prefix-cache invalidation this session has caused, in
	 * order. Empty means the system prompt never changed after startup, which is
	 * the cheap case: the provider served the whole prompt from cache all session.
	 */
	systemPromptInvalidations(): readonly string[] {
		// A copy, and frozen. `readonly string[]` is a compile-time claim only:
		// returning the live array hands a caller the session's own cost evidence
		// to mutate, and a reader that trimmed or appended to it would silently
		// misreport how many times the cache was invalidated.
		return Object.freeze([...this.#baseSystemPromptInvalidations]);
	}

	/**
	 * Rebuild the base system prompt, recording `reason` when the bytes change.
	 *
	 * The return value exists so a caller can VERIFY what the rebuild produced.
	 * The argot arm is the motivating case: it refreshes the prompt to teach the
	 * handle table, and until this returned something there was no way for the
	 * caller, a test, or an eval to confirm the table actually landed. The
	 * transcript could not answer it either, because `session_init` snapshots the
	 * prompt before the background arm ever completes.
	 *
	 * Returns the unchanged current prompt when no rebuild hook is installed.
	 *
	 * `reason` is REQUIRED, and that is the point. It used to default to
	 * "unspecified", and the three callers that omitted it were the frequent ones:
	 * a cwd re-root, a secrets refresh, and a memory clear. A session that
	 * re-rooted four times recorded four invalidations all reading
	 * `reason='unspecified'`, each one rewriting a ~32k-char prompt, so the
	 * recording could prove the cache had been thrown away but never which change
	 * threw it. The whole value of this evidence is attribution; a default made
	 * the unattributed case the easy one to write.
	 */
	async refreshBaseSystemPrompt(reason: string): Promise<string[]> {
		const rebuildSystemPrompt = this.#host.config.rebuildSystemPrompt;
		if (!rebuildSystemPrompt) return this.#baseSystemPrompt;
		const activeToolNames = this.#session.getActiveToolNames();
		this.#host.config.setActiveToolNames?.(activeToolNames);
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		const built = await rebuildSystemPrompt(activeToolNames, this.#host.registry);
		this.#baseSystemPrompt = built.systemPrompt;
		if (
			previousBaseSystemPrompt.length !== this.#baseSystemPrompt.length ||
			previousBaseSystemPrompt.some((part, index) => part !== this.#baseSystemPrompt[index])
		) {
			this.#host.providerSessions.clearInheritedCacheKey("system-prompt-change");
			// Changing the system prompt mid-session invalidates the provider's
			// prefix cache, and the next request re-reads the ENTIRE context as
			// fresh input. That is the most expensive thing a session can do
			// silently: on a measured 66-turn trace, five turns came back with
			// `cacheRead: 0` while resending 46-72k tokens each, about 8% of the
			// session bill, and nothing in the transcript said why. The
			// invalidation was already detected right here and simply never
			// recorded, so every attempt to explain the misses was guesswork.
			//
			// Recorded loudly rather than at debug, because a caller that refreshes
			// the prompt on a hot path is a cost bug, and the reason is the only
			// thing that identifies which caller it was.
			this.#baseSystemPromptInvalidations.push(reason);
			const previousChars = previousBaseSystemPrompt.join("\n\n").length;
			const nextChars = this.#baseSystemPrompt.join("\n\n").length;
			logger.warn("system prompt changed mid-session; provider prompt cache invalidated", {
				reason,
				invalidationsThisSession: this.#baseSystemPromptInvalidations.length,
				previousChars,
				nextChars,
			});
			// Also written to the transcript, not just the log. An in-memory counter
			// and a log line are invisible to anything reading a finished run, and a
			// finished run is exactly where the cost question gets asked. Without
			// this entry the bench sees `cacheRead: 0` turns and still cannot say
			// which subsystem caused them, which is the state that made these misses
			// unexplainable in the first place.
			this.#session.sessionManager.appendCustomMessageEntry(
				"prompt_cache_invalidated",
				`system prompt changed (${reason}); provider prefix cache invalidated`,
				false,
				{ reason, index: this.#baseSystemPromptInvalidations.length, previousChars, nextChars },
				"agent",
			);
		}
		this.#session.agent.setSystemPrompt(this.#baseSystemPrompt);
		this.#promptModelKey = this.#livePromptModelKey();
		// Refresh the cached signature so a subsequent `apply` with
		// the same tool set does not re-rebuild on top of the explicit refresh we
		// just performed (and conversely, a different set forces a fresh rebuild).
		const activeTools = activeToolNames
			.map(name => this.#host.registry.get(name))
			.filter((tool): tool is AgentTool => tool != null);
		this.#lastAppliedToolSignature = this.#signature(activeToolNames, activeTools);
		return this.#baseSystemPrompt;
	}

	/**
	 * Compose a SHA-256 digest of the inputs that `rebuildSystemPrompt` reads.
	 * Two calls producing the same digest produce identical system prompt bytes,
	 * so the rebuild can be skipped.
	 *
	 * The session holds the digest, not the text it was computed from: the inputs
	 * include every active tool's description, so the text is the size of the
	 * whole tool catalog and a held copy of it would stay on the heap for the life
	 * of every session and every live subagent. Each input is fed to the hash in
	 * order, separators included, so the digest is that of the joined text without
	 * the joined text being built.
	 *
	 * The signature covers:
	 *   1. Active tool names in order (the prompt renders them in this order).
	 *   2. Active tool labels, descriptions, and wire-visible names — all are
	 *      rendered into the prompt body (see `system-prompt.md` `{{label}}: \`{{name}}\``
	 *      and `toolPromptNames` in `buildSystemPrompt`). The wire name comes from
	 *      `tool.customWireName` and overrides the internal name on the model wire
	 *      (e.g. `edit` exposes itself as `apply_patch` to GPT-5 in apply_patch mode);
	 *      a stale wire name would desync prompt guidance from actual tool routing.
	 *   3. When MCP discovery is on, every registry tool's name+label+description+
	 *      customWireName, since `rebuildSystemPrompt` summarizes discoverable MCP
	 *      tools that are not in the active set.
	 *   4. MCP server instructions text (per server), since `rebuildSystemPrompt`
	 *      embeds these in the appended prompt under "## MCP Server Instructions".
	 *      A server upgrade can change instructions while keeping tools identical.
	 *
	 * Settings-driven tool metadata is covered automatically: built-in tools that
	 * depend on settings expose `description`/`label` via getters (see `TaskTool`,
	 * `SearchToolBm25Tool`, `EditTool`), and the signature reads them live on every
	 * call - so a settings flip that mutates the rendered string differs the signature
	 * the next time `apply` runs. Do not refactor `describeTool` to
	 * cache per-tool strings without preserving this property.
	 *
	 * Inputs NOT covered: tool input schemas; memory instructions read from disk;
	 * and SDK-init-time closure constants in `sdk.ts` (`inlineToolDescriptors`,
	 * `eagerTasks`, `intentField`, `mcpDiscoveryEnabled`). The closure-captured
	 * ones cannot change at runtime regardless of skip behavior. Secret guidance
	 * is read from the live runtime and `refreshSecrets()` explicitly rebuilds it.
	 * For everything else, callers must explicitly call `refreshBaseSystemPrompt()`
	 * after side-effecting changes; see e.g. the memory hooks and
	 * `#syncAfterModelChange`.
	 *
	 * The current calendar date IS covered (appended as a segment) because
	 * `buildSystemPrompt` injects it into the prompt body (`Today is '{{date}}'`).
	 * Without this, a session spanning midnight with only tool-stable MCP
	 * reconnects would keep yesterday's date indefinitely.
	 */
	#signature(toolNames: string[], tools: AgentTool[]): string {
		const hash = createHash("sha256");
		const feedJoined = (parts: readonly string[], separator: string): void => {
			for (let index = 0; index < parts.length; index++) {
				if (index > 0) hash.update(separator);
				hash.update(parts[index]);
			}
		};
		const describeTool = (tool: AgentTool): string =>
			`${tool.name}=${tool.label ?? ""}|${tool.description ?? ""}|${tool.customWireName ?? ""}`;
		// Order-preserving: any reorder must produce a different digest so the
		// rebuild fires and the new tool list reaches the API.
		feedJoined(toolNames, "\u0001");
		hash.update("\u0003");
		feedJoined(tools.map(describeTool), "\u0002");
		hash.update("\u0005");
		if (this.#host.discovery.mcpEnabled) {
			// Registry iteration order is not load-bearing for the prompt content, so we
			// sort to keep the digest insensitive to incidental insertion order.
			const entries: string[] = [];
			for (const tool of this.#host.registry.values()) {
				entries.push(describeTool(tool));
			}
			feedJoined(entries.sort(), "\u0004");
		}
		hash.update("\u0007");
		const serverInstructions = this.#host.config.getMcpServerInstructions?.();
		if (serverInstructions && serverInstructions.size > 0) {
			// Sort by server name so transport flap order does not perturb the digest.
			const entries: string[] = [];
			for (const [server, instructions] of serverInstructions) {
				entries.push(`${server}=${instructions}`);
			}
			feedJoined(entries.sort(), "\u0006");
		}
		hash.update(`|${this.#host.config.getLocalCalendarDate?.() ?? localCalendarDate(Date.now())}`);
		return hash.digest("base64");
	}

	/**
	 * Replace MCP tools in the registry and recompute the visible MCP tool set immediately.
	 * This allows /mcp add/remove/reauth to take effect without restarting the session.
	 *
	 * @param mcpTools The new MCP tools to register.
	 * @param options.activateAll When true, force-activates every newly registered MCP tool
	 *   regardless of prior selection state. Used when MCP discovery is disabled and tools
	 *   arrive after initial session activation.
	 */
	async refreshMCPTools(mcpTools: CustomTool[], options?: { activateAll?: boolean }): Promise<void> {
		const previousSelectedMCPToolNames = this.#session.getSelectedMCPToolNames();
		const existingNames = Array.from(this.#host.registry.keys());
		for (const name of existingNames) {
			if (isMCPToolName(name)) {
				this.#host.registry.delete(name);
			}
		}

		const getCustomToolContext = (): CustomToolContext => this.#host.customToolContext();
		for (const customTool of mcpTools) {
			const finalTool = this.#wrapRuntimeTool(CustomToolAdapter.wrap(customTool, getCustomToolContext) as AgentTool);
			this.#host.registry.set(finalTool.name, finalTool);
		}

		this.#host.discovery.reindexMCPTools();
		this.#host.discovery.pruneSelectedMCP();
		if (this.#session.sessionManager.getMCPToolSelection() === undefined) {
			this.#host.discovery.addConfiguredDefaultMCP();
		}
		this.#host.discovery.rememberSessionDefaults(this.#session.sessionFile);

		if (options?.activateAll) {
			// Force-activate every newly registered MCP tool. This path is used
			// when MCP discovery is disabled and tools arrive after initial
			// activation — without it, getSelectedMCPToolNames() returns only
			// already-active tools (circular deadlock: tools can only become
			// active if they're already active).
			const newMcpNames = mcpTools.map(t => t.name);
			const nextActive = [...new Set([...this.#host.discovery.activeNonMCP(), ...newMcpNames])];
			await this.apply(nextActive, { previousSelectedMCPToolNames });
			return;
		}

		const nextActive = [...this.#host.discovery.activeNonMCP(), ...this.#session.getSelectedMCPToolNames()];
		await this.apply(nextActive, { previousSelectedMCPToolNames });
	}

	/**
	 * Replace RPC host-owned tools and refresh the active tool set before the next model call.
	 */
	async refreshRpcHostTools(rpcTools: AgentTool[]): Promise<void> {
		const nextToolNames = rpcTools.map(tool => tool.name);
		const uniqueToolNames = new Set(nextToolNames);
		if (uniqueToolNames.size !== nextToolNames.length) {
			throw new Error("RPC host tool names must be unique");
		}

		for (const name of uniqueToolNames) {
			if (this.#host.registry.has(name) && !this.#rpcHostToolNames.has(name)) {
				throw new Error(`RPC host tool "${name}" conflicts with an existing tool`);
			}
		}

		const previousRpcHostToolNames = new Set(this.#rpcHostToolNames);
		const previousActiveToolNames = this.#session.getActiveToolNames();
		for (const name of previousRpcHostToolNames) {
			this.#host.registry.delete(name);
		}
		this.#rpcHostToolNames.clear();

		for (const tool of rpcTools) {
			const finalTool = this.#wrapRuntimeTool(tool);
			this.#host.registry.set(finalTool.name, finalTool);
			this.#rpcHostToolNames.add(finalTool.name);
		}

		// Registry contents changed — invalidate discovery caches so the next BM25 lookup sees
		// the new RPC-host tool set. (apply below also invalidates, but doing
		// it here too keeps the contract local to "registry mutated".)
		this.#host.discovery.invalidate();

		const activeNonRpcToolNames = previousActiveToolNames.filter(name => !previousRpcHostToolNames.has(name));
		const preservedRpcToolNames = previousActiveToolNames.filter(
			name => previousRpcHostToolNames.has(name) && this.#rpcHostToolNames.has(name),
		);
		const autoActivatedRpcToolNames = rpcTools
			.filter(tool => !tool.hidden && !previousRpcHostToolNames.has(tool.name))
			.map(tool => tool.name);
		await this.apply(
			Array.from(new Set([...activeNonRpcToolNames, ...preservedRpcToolNames, ...autoActivatedRpcToolNames])),
		);
	}
}
