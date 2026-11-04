/**
 * Tool discovery: which registered tools the model can find with `search_tool_bm25`, which of them
 * it has selected, and which MCP tools a session starts with.
 *
 * This is a session collaborator. It holds the discovery state (the MCP tools the registry offers,
 * the MCP and local selections, the built-in names, the configured and per-session default MCP
 * selections and the cached search index) and reaches the session only through
 * {@link ToolDiscoveryHost}. It reads the tool registry and never writes it: registering,
 * activating and persisting stay with the session, which asks this collaborator what to activate
 * and reports back what it activated.
 *
 * Two selections, kept apart:
 *
 * - **MCP selection**: with MCP discovery on, the MCP tools the model or the configuration selected,
 *   which persist in the session file. With it off, the active MCP tools are the selection.
 * - **Local selection**: the built-in and custom tools the model activated through discovery. A
 *   name leaves it once the tool is no longer active, so the search can find the tool again.
 */

import * as path from "node:path";
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import { countToolsForAutoDiscovery, type EffectiveToolDiscoveryMode } from "../../discovery/mode";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	filterBySource,
	isMCPToolName,
	selectDiscoverableToolNamesByServer,
} from "../../discovery/tool-index";

/** What {@link ToolDiscovery} needs from the session that owns it. */
export interface ToolDiscoveryHost {
	/** The session's tool registry, read on every call, so a registry mutation is seen at once. */
	readonly registry: ReadonlyMap<string, AgentTool>;
	/** The names of the tools set on the agent, in order. */
	activeToolNames(): string[];
	/** `tools.discoveryMode` resolved for a registry of `toolCount` tools. */
	discoveryModeFor(toolCount: number): EffectiveToolDiscoveryMode;
	/** The maximum number of discovered tools allowed to remain active at once before LRU eviction. */
	maxDiscoveredTools?(): number;
	/** Recent session messages, used to derive tool recency for LRU eviction. */
	sessionMessages?(): readonly AgentMessage[];
}

/** The session configuration discovery starts from. */
export interface ToolDiscoveryConfig {
	/** Whether MCP tools are found through discovery rather than all activated. */
	mcpDiscoveryEnabled?: boolean;
	/** Registry entries that came from a built-in factory. */
	builtInToolNames?: Iterable<string>;
	/** The MCP selection the session resumes with. */
	initialSelectedMCPToolNames?: Iterable<string>;
	/** MCP servers whose every tool a fresh session selects. */
	defaultSelectedMCPServerNames?: Iterable<string>;
	/** MCP tools a fresh session selects. */
	defaultSelectedMCPToolNames?: Iterable<string>;
	/** Maximum number of search-activated tools before LRU eviction (default 40). */
	maxDiscoveredTools?: number;
	/** Tool names that are protected from eviction or pruning. */
	protectedToolNames?: Iterable<string>;
}

/** A discovery activation plan with LRU eviction when exceeding maxDiscoveredTools. */
export interface DiscoveryActivationPlan {
	readonly activated: string[];
	readonly evicted: string[];
	readonly nextActive: string[];
	readonly changed: boolean;
}

/** A discovery compaction pruning plan that drops unused search-activated tools. */
export interface DiscoveryPrunePlan {
	readonly dropped: string[];
	readonly nextActive: string[];
	readonly changed: boolean;
}

/**
 * Extract the last message index for each tool call found in `messages`.
 * Inspects assistant tool calls and toolResult messages.
 */
export function extractToolLastCallIndices(messages: readonly AgentMessage[]): Map<string, number> {
	const lastCalls = new Map<string, number>();
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block && typeof block === "object" && "type" in block && block.type === "toolCall" && "name" in block) {
					const name = block.name;
					if (typeof name === "string" && name.length > 0) {
						lastCalls.set(name, i);
					}
				}
			}
		} else if (message.role === "toolResult" && "toolName" in message) {
			const toolName = message.toolName;
			if (typeof toolName === "string" && toolName.length > 0) {
				lastCalls.set(toolName, i);
			}
		}
	}
	return lastCalls;
}

/** Whether two tool-name lists hold the same names in the same order. */
export function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

export class ToolDiscovery {
	readonly #host: ToolDiscoveryHost;
	#mcpEnabled: boolean;
	#mcpTools = new Map<string, DiscoverableTool>();
	#selectedMCP: Set<string>;
	#selectedLocal = new Set<string>();
	readonly #builtIn: Set<string>;
	readonly #defaultMCPServers: ReadonlySet<string>;
	readonly #defaultMCPTools: ReadonlySet<string>;
	readonly #protected: Set<string>;
	readonly #configMaxDiscovered?: number;
	/** The configured default MCP selection each session file was opened with, by resolved path. */
	readonly #sessionDefaults = new Map<string, string[]>();
	readonly #searchActivated = new Map<string, number>();
	#activationSeq = 0;
	#searchIndex: DiscoverableToolSearchIndex | null = null;
	/** Restored selections over the cap that must leave the already-loaded agent schemas. */
	readonly restoredCapDrops: ReadonlySet<string>;

	constructor(host: ToolDiscoveryHost, config: ToolDiscoveryConfig) {
		this.#host = host;
		this.#mcpEnabled = config.mcpDiscoveryEnabled ?? false;
		this.#builtIn = new Set(config.builtInToolNames ?? []);
		this.#defaultMCPServers = new Set(config.defaultSelectedMCPServerNames ?? []);
		this.#defaultMCPTools = new Set(config.defaultSelectedMCPToolNames ?? []);
		this.#protected = new Set(config.protectedToolNames ?? []);
		this.#configMaxDiscovered = config.maxDiscoveredTools;

		this.reindexMCPTools();

		const initialSelected = Array.from(config.initialSelectedMCPToolNames ?? []);
		this.#selectedMCP = new Set(this.selectableMCP(initialSelected.filter(isMCPToolName)));

		for (const name of initialSelected) {
			if (!isMCPToolName(name) && this.#host.registry.has(name)) {
				this.#selectedLocal.add(name);
			}
		}

		// Restore the combined selection in its persisted activation order, using retained
		// call recency when available. This lets a reduced cap retain the most recently used tools.
		const restoredCallIndices = extractToolLastCallIndices(this.#host.sessionMessages?.() ?? []);
		const searchCandidates = initialSelected.filter(name => {
			if (this.isInherentlyProtected(name)) return false;
			return this.#selectedMCP.has(name) || this.#selectedLocal.has(name);
		});
		searchCandidates.sort((a, b) => {
			const callA = restoredCallIndices.get(a);
			const callB = restoredCallIndices.get(b);
			if (callA !== undefined && callB !== undefined && callA !== callB) return callA - callB;
			if (callA !== undefined && callB === undefined) return 1;
			if (callA === undefined && callB !== undefined) return -1;
			return initialSelected.indexOf(a) - initialSelected.indexOf(b);
		});

		// Bound restored search-activated selections to maxDiscoveredTools, keeping the most recent.
		const cap = this.maxDiscoveredTools;
		const keptSearch =
			searchCandidates.length > cap ? searchCandidates.slice(searchCandidates.length - cap) : searchCandidates;
		const droppedSearch =
			searchCandidates.length > cap ? new Set(searchCandidates.slice(0, searchCandidates.length - cap)) : null;
		this.restoredCapDrops = droppedSearch ?? new Set();

		if (droppedSearch) {
			for (const name of droppedSearch) {
				this.#selectedMCP.delete(name);
				this.#selectedLocal.delete(name);
			}
		}

		for (const name of keptSearch) {
			this.#searchActivated.set(name, ++this.#activationSeq);
		}

		this.pruneSelectedMCP();
	}
	/** Whether MCP tools are found through discovery. */
	get mcpEnabled(): boolean {
		return this.#mcpEnabled;
	}

	/**
	 * Turn MCP discovery on once deferred discovery learns the real tool count. UI sessions resolve
	 * `tools.discoveryMode: "auto"` before MCP servers connect, so a large MCP toolset found later
	 * moves the session to the discovery path. One-way: discovery is never turned off mid-session.
	 */
	enableMCP(): void {
		this.#mcpEnabled = true;
	}

	/** Re-read the MCP tools the registry offers, after the registry's MCP entries changed. */
	reindexMCPTools(): void {
		const mcpTools = filterBySource(collectDiscoverableTools(this.#host.registry.values()), "mcp");
		this.#mcpTools = new Map(mcpTools.map(tool => [tool.name, tool] as const));
		this.invalidate();
	}

	/**
	 * Drop the cached search index. Called after any change to which tools are discoverable: a
	 * registry mutation or an active-tool change, since active tools are not discoverable.
	 */
	invalidate(): void {
		this.#searchIndex = null;
	}

	/** The names in `toolNames` that are discoverable MCP tools still in the registry. */
	selectableMCP(toolNames: Iterable<string>): string[] {
		const registry = this.#host.registry;
		return Array.from(toolNames).filter(name => this.#mcpTools.has(name) && registry.has(name));
	}

	/** The configured default MCP selection: the named tools and every tool of the named servers. */
	configuredDefaultMCP(): string[] {
		return this.selectableMCP([
			...this.#defaultMCPTools,
			...selectDiscoverableToolNamesByServer(this.#mcpTools.values(), this.#defaultMCPServers),
		]);
	}

	/** The configured default MCP tools alone, which a new session starts with. */
	defaultMCPTools(): string[] {
		return this.selectableMCP(this.#defaultMCPTools);
	}

	/** Drop selected MCP names that are no longer discoverable. */
	pruneSelectedMCP(): void {
		this.#selectedMCP = new Set(this.selectableMCP(this.#selectedMCP));
	}

	/** Add the configured default MCP selection to the current one. */
	addConfiguredDefaultMCP(): void {
		this.#selectedMCP = new Set([...this.#selectedMCP, ...this.configuredDefaultMCP()]);
	}

	/** A copy of the MCP selection, to restore with {@link restoreSelectedMCP} if a switch fails. */
	snapshotSelectedMCP(): Set<string> {
		return new Set(this.#selectedMCP);
	}

	restoreSelectedMCP(snapshot: ReadonlySet<string>): void {
		this.#selectedMCP = new Set(snapshot);
	}

	/** Record the configured default MCP selection as the one `sessionFile` falls back to. */
	rememberSessionDefaults(sessionFile: string | null | undefined): void {
		if (!sessionFile) return;
		this.#sessionDefaults.set(path.resolve(sessionFile), this.configuredDefaultMCP());
	}

	/** The default MCP selection recorded for `sessionFile`, empty when none was. */
	sessionDefaults(sessionFile: string | null | undefined): string[] {
		if (!sessionFile) return [];
		return this.#sessionDefaults.get(path.resolve(sessionFile)) ?? [];
	}

	/** The selected MCP tools: the discovery selection, or the active MCP tools with discovery off. */
	selectedMCP(): string[] {
		if (!this.#mcpEnabled) {
			const registry = this.#host.registry;
			return this.#host.activeToolNames().filter(name => isMCPToolName(name) && registry.has(name));
		}
		return this.selectableMCP(this.#selectedMCP);
	}

	/**
	 * The combined selected-tool order to persist, or `undefined` when it equals `previous`.
	 */
	selectedMCPChangedFrom(previous: readonly string[]): string[] | undefined {
		if (!this.#mcpEnabled) return undefined;
		const next = this.selectedDiscovered();
		return sameToolNames(previous, next) ? undefined : next;
	}

	/** The active tools that are not MCP tools, in active order. */
	activeNonMCP(): string[] {
		const registry = this.#host.registry;
		return this.#host.activeToolNames().filter(name => !isMCPToolName(name) && registry.has(name));
	}

	/** The maximum number of search-activated tools allowed before LRU eviction. */
	get maxDiscoveredTools(): number {
		const hostCap = this.#host.maxDiscoveredTools?.();
		if (typeof hostCap === "number" && Number.isFinite(hostCap) && hostCap > 0) {
			return hostCap;
		}
		if (
			typeof this.#configMaxDiscovered === "number" &&
			Number.isFinite(this.#configMaxDiscovered) &&
			this.#configMaxDiscovered > 0
		) {
			return this.#configMaxDiscovered;
		}
		return 40;
	}

	/** Whether `name` is inherently protected by defaults or configuration. */
	isInherentlyProtected(name: string): boolean {
		if (this.#protected.has(name)) return true;
		if (this.#defaultMCPTools.has(name)) return true;
		if (this.configuredDefaultMCP().includes(name)) return true;
		const tool = this.#host.registry.get(name);
		if (this.#builtIn.has(name) && tool?.loadMode !== "discoverable") return true;
		return false;
	}

	/** Whether `name` is a protected default tool that must never evict. */
	isProtected(name: string): boolean {
		if (this.isInherentlyProtected(name)) return true;
		if (this.#searchActivated.has(name)) return false;
		return this.#host.activeToolNames().includes(name);
	}

	/** The currently active tools that were activated through search (and thus eligible for cap eviction or compaction pruning). */
	searchActivatedTools(): string[] {
		const active = new Set(this.#host.activeToolNames());
		return Array.from(this.#searchActivated.keys()).filter(name => active.has(name));
	}

	/**
	 * Plan the activation of discoverable tools (both MCP and local), enforcing the activation cap
	 * and evicting LRU search tools by last tool call else activation order.
	 */
	planActivation(
		toolNames: readonly string[],
		options?: { messages?: readonly AgentMessage[] },
	): DiscoveryActivationPlan {
		const registry = this.#host.registry;
		const active = new Set(this.#host.activeToolNames());
		const toActivate: string[] = [];
		const seen = new Set<string>();

		for (const name of toolNames) {
			if (seen.has(name) || !registry.has(name) || active.has(name)) continue;
			if (isMCPToolName(name) && !this.#mcpTools.has(name)) continue;
			seen.add(name);
			toActivate.push(name);
		}

		if (toActivate.length === 0) {
			return {
				activated: [],
				evicted: [],
				nextActive: this.#host.activeToolNames(),
				changed: false,
			};
		}

		const messages = options?.messages ?? this.#host.sessionMessages?.() ?? [];
		const lastCalls = extractToolLastCallIndices(messages);
		const currentSearchActive = this.searchActivatedTools();
		const cap = this.maxDiscoveredTools;

		// Sort existing search-activated tools by LRU eviction priority (first to evict at index 0)
		const existingLRU = [...currentSearchActive].sort((a, b) => {
			const hasA = lastCalls.has(a);
			const hasB = lastCalls.has(b);
			if (!hasA && !hasB) {
				return (this.#searchActivated.get(a) ?? 0) - (this.#searchActivated.get(b) ?? 0);
			}
			if (!hasA && hasB) return -1;
			if (hasA && !hasB) return 1;
			const callA = lastCalls.get(a)!;
			const callB = lastCalls.get(b)!;
			if (callA !== callB) return callA - callB;
			return (this.#searchActivated.get(a) ?? 0) - (this.#searchActivated.get(b) ?? 0);
		});

		// Track incoming order for deterministic tie-breaking among incoming tools
		const incomingOrder = new Map(toActivate.map((name, idx) => [name, idx]));
		const compareIncoming = (a: string, b: string): number => {
			const hasA = lastCalls.has(a);
			const hasB = lastCalls.has(b);
			if (!hasA && !hasB) {
				return (incomingOrder.get(a) ?? 0) - (incomingOrder.get(b) ?? 0);
			}
			if (!hasA && hasB) return -1;
			if (hasA && !hasB) return 1;
			const callA = lastCalls.get(a)!;
			const callB = lastCalls.get(b)!;
			if (callA !== callB) return callA - callB;
			return (incomingOrder.get(a) ?? 0) - (incomingOrder.get(b) ?? 0);
		};

		const remainingExisting = [...existingLRU];
		const activeIncoming: string[] = [];
		const evictedExisting: string[] = [];
		const finalProtected: string[] = [];

		for (const candidate of toActivate) {
			if (this.isInherentlyProtected(candidate)) {
				finalProtected.push(candidate);
				continue;
			}

			const currentActiveCount = remainingExisting.length + activeIncoming.length;
			if (currentActiveCount < cap) {
				activeIncoming.push(candidate);
			} else if (remainingExisting.length > 0) {
				// Evict LRU from existing search activated first
				const evicted = remainingExisting.shift()!;
				evictedExisting.push(evicted);
				activeIncoming.push(candidate);
			} else {
				// Evict oldest never-called within incoming batch as needed
				const pool = [...activeIncoming, candidate];
				pool.sort(compareIncoming);
				const toEvict = pool[0];
				if (toEvict === candidate) {
					continue;
				}
				const evictIdx = activeIncoming.indexOf(toEvict);
				if (evictIdx !== -1) {
					activeIncoming.splice(evictIdx, 1);
				}
				activeIncoming.push(candidate);
			}
		}

		const activated = [...finalProtected, ...activeIncoming];
		if (activated.length === 0 && evictedExisting.length === 0) {
			return {
				activated: [],
				evicted: [],
				nextActive: this.#host.activeToolNames(),
				changed: false,
			};
		}

		const evictedSet = new Set(evictedExisting);
		const nextActive = this.#host
			.activeToolNames()
			.filter(name => !evictedSet.has(name))
			.concat(activated);

		return {
			activated,
			evicted: evictedExisting,
			nextActive,
			changed: true,
		};
	}

	applyActivation(plan: DiscoveryActivationPlan): void {
		if (!plan.changed) return;
		for (const name of plan.evicted) {
			this.#searchActivated.delete(name);
			this.#selectedLocal.delete(name);
			this.#selectedMCP.delete(name);
		}
		for (const name of plan.activated) {
			if (!this.isInherentlyProtected(name)) {
				this.#searchActivated.set(name, ++this.#activationSeq);
			}
			if (isMCPToolName(name)) {
				this.#selectedMCP.add(name);
			} else {
				this.#selectedLocal.add(name);
			}
		}
		this.invalidate();
	}

	/** Enforce a reduced cap without waiting for the next discovery search. */
	planCapReduction(): DiscoveryPrunePlan {
		const active = this.searchActivatedTools();
		const excess = active.length - this.maxDiscoveredTools;
		if (excess <= 0) {
			return { dropped: [], nextActive: this.#host.activeToolNames(), changed: false };
		}
		const calls = extractToolLastCallIndices(this.#host.sessionMessages?.() ?? []);
		active.sort((a, b) => {
			const lastA = calls.get(a);
			const lastB = calls.get(b);
			if (lastA === undefined && lastB !== undefined) return -1;
			if (lastA !== undefined && lastB === undefined) return 1;
			if (lastA !== undefined && lastB !== undefined && lastA !== lastB) return lastA - lastB;
			return (this.#searchActivated.get(a) ?? 0) - (this.#searchActivated.get(b) ?? 0);
		});
		const dropped = active.slice(0, excess);
		const droppedSet = new Set(dropped);
		return {
			dropped,
			nextActive: this.#host.activeToolNames().filter(name => !droppedSet.has(name)),
			changed: true,
		};
	}

	/**
	 * Plan pruning of search-activated tools after compaction: drops any search-activated tool
	 * not called in the retained `messages`. Protected and default tools are never pruned.
	 */
	planCompactionPrune(messages: readonly AgentMessage[]): DiscoveryPrunePlan {
		const called = new Set(extractToolLastCallIndices(messages).keys());
		const currentSearchActive = this.searchActivatedTools();
		const toDrop = currentSearchActive.filter(name => !called.has(name));

		if (toDrop.length === 0) {
			return {
				dropped: [],
				nextActive: this.#host.activeToolNames(),
				changed: false,
			};
		}

		const dropSet = new Set(toDrop);
		const nextActive = this.#host.activeToolNames().filter(name => !dropSet.has(name));

		return {
			dropped: toDrop,
			nextActive,
			changed: true,
		};
	}

	applyPrune(plan: DiscoveryPrunePlan): void {
		if (!plan.changed) return;
		for (const name of plan.dropped) {
			this.#searchActivated.delete(name);
			this.#selectedLocal.delete(name);
			this.#selectedMCP.delete(name);
		}
		this.invalidate();
	}

	/** Remove `name` from the local selection, after its registry entry went away. */
	deselect(name: string): void {
		this.#selectedLocal.delete(name);
		this.#searchActivated.delete(name);
	}

	/**
	 * Follow an active-tool list the session is about to set: with MCP discovery on, the MCP
	 * selection becomes the active MCP tools.
	 */
	followActiveMCP(activeToolNames: readonly string[]): void {
		if (!this.#mcpEnabled) return;
		this.#selectedMCP = new Set(this.selectableMCP(activeToolNames.filter(isMCPToolName)));
	}

	/**
	 * Settle after the session set `activeToolNames` on the agent: a local selection that is no longer
	 * active leaves the selection, and the search index, which excludes active tools, is dropped.
	 */
	settleActive(activeToolNames: readonly string[]): void {
		const active = new Set(activeToolNames);
		const registry = this.#host.registry;
		for (const name of this.#selectedLocal) {
			if (!active.has(name) || isMCPToolName(name) || !registry.has(name)) this.#selectedLocal.delete(name);
		}
		for (const name of this.#searchActivated.keys()) {
			if (!active.has(name)) {
				this.#searchActivated.delete(name);
			}
		}
		this.invalidate();
	}

	/** The selected tools in activation order: MCP and active local selections share one order. */
	selectedDiscovered(): string[] {
		const active = new Set(this.#host.activeToolNames());
		const registry = this.#host.registry;
		const selected = new Set(this.selectedMCP());
		for (const name of this.#selectedLocal) {
			if (active.has(name) && registry.has(name) && !isMCPToolName(name)) selected.add(name);
		}
		// Default and protected tools never enter #searchActivated; they precede every search-activated
		// tool, matching the order the selection was persisted in. Array.sort is stable.
		return Array.from(selected).sort(
			(a, b) => (this.#searchActivated.get(a) ?? 0) - (this.#searchActivated.get(b) ?? 0),
		);
	}

	/** Whether the registry entry for `name` came from a built-in factory. */
	isBuiltIn(name: string): boolean {
		return this.#builtIn.has(name);
	}

	addBuiltIn(name: string): void {
		this.#builtIn.add(name);
	}

	removeBuiltIn(name: string): void {
		this.#builtIn.delete(name);
	}

	/** `tools.discoveryMode` for the current registry, with MCP discovery lifting `off` to `mcp-only`. */
	effectiveMode(): EffectiveToolDiscoveryMode {
		const mode = this.#host.discoveryModeFor(countToolsForAutoDiscovery(this.#host.registry.keys()));
		if (mode !== "off") return mode;
		return this.#mcpEnabled ? "mcp-only" : "off";
	}

	/**
	 * The inactive tools the model can discover: the MCP tools, and in `all` mode the local tools whose
	 * `loadMode` is `discoverable`.
	 */
	discoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[] {
		const active = new Set(this.#host.activeToolNames());
		const tools = this.effectiveMode() === "all" ? this.#discoverableLocalTools(active) : [];
		for (const tool of this.#mcpTools.values()) {
			if (!active.has(tool.name)) tools.push(tool);
		}
		return filter?.source ? tools.filter(tool => tool.source === filter.source) : tools;
	}

	/** The search index over {@link discoverableTools}, built on first use after an invalidation. */
	searchIndex(): DiscoverableToolSearchIndex {
		this.#searchIndex ??= buildDiscoverableToolSearchIndex(this.discoverableTools());
		return this.#searchIndex;
	}

	/**
	 * Inactive local tools whose `loadMode` is `discoverable`; hidden and internal tools stay out of
	 * the index. A built-in name is sourced `builtin`, any other `custom`.
	 */
	#discoverableLocalTools(active: ReadonlySet<string>): DiscoverableTool[] {
		const tools: DiscoverableTool[] = [];
		for (const tool of this.#host.registry.values()) {
			if (tool.loadMode !== "discoverable" || active.has(tool.name)) continue;
			const source = this.#builtIn.has(tool.name) ? "builtin" : "custom";
			for (const discoverable of collectDiscoverableTools([tool], { source })) tools.push(discoverable);
		}
		return tools;
	}
}
