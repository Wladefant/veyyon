import type { Usage } from "@veyyon/ai";
import { isRecord } from "@veyyon/utils/type-guards";
import { walkBranchPath } from "./session-context";
import type { SessionEntry, SessionTreeNode, UsageStatistics } from "./session-entries";

function emptyUsageStatistics(): UsageStatistics {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (!isRecord(details)) return undefined;
	const maybeUsage = details.usage;
	if (maybeUsage === null || typeof maybeUsage !== "object") return undefined;
	// A task result's details are written by the task tool, whose `usage` is the child's `Usage`.
	const usage = maybeUsage as Usage;
	return usage;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * resolved label map, the active leaf, and the running usage totals. Kept in
 * lockstep with the manager's `#entries` so reads stay O(1) instead of
 * rescanning the whole journal.
 */
export class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();
	/**
	 * Root→leaf path of `#leaf`, or undefined until a reader asks for it. An
	 * append to the leaf extends it in place; anything else that can change the
	 * walk (a leaf move, a rebuild, an insert off the leaf) drops it. Every
	 * startup reader walks the active branch, and on a session of hundreds of
	 * thousands of entries each walk costs tens of milliseconds.
	 */
	#leafPath: SessionEntry[] | undefined;

	clear(): void {
		this.#entriesById.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#leafPath = undefined;
		this.#usage = emptyUsageStatistics();
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
	}

	insert(entry: SessionEntry): void {
		// The new leaf's path is the old leaf's path plus this entry exactly when
		// it hangs off the old leaf and does not shadow an id already on the map.
		const leafPath =
			this.#leaf !== null && entry.parentId === this.#leaf && !this.#entriesById.has(entry.id)
				? this.#leafPath
				: undefined;
		this.#entriesById.set(entry.id, entry);
		this.#leaf = entry.id;
		leafPath?.push(entry);
		this.#leafPath = leafPath;

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		addUsage(this.#usage, entryUsage(entry));
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	/**
	 * The live id→entry map. Read-only for callers (lookups + `generateId`
	 * collision checks); never mutate it directly — go through `insert`/`rebuild`.
	 */
	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		if (id !== this.#leaf) this.#leafPath = undefined;
		this.#leaf = id;
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		return id === this.#leaf ? this.leafPath().slice() : walkBranchPath(this.#entriesById, this.#lookup(id));
	}

	/**
	 * The active branch, root→leaf. Shared with the index: read it, never mutate
	 * it. {@link pathTo} returns a copy for callers that keep or edit the array.
	 */
	leafPath(): readonly SessionEntry[] {
		this.#leafPath ??= walkBranchPath(this.#entriesById, this.#lookup(this.#leaf));
		return this.#leafPath;
	}

	#lookup(id: string | null | undefined): SessionEntry | undefined {
		return id ? this.#entriesById.get(id) : undefined;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = roots.slice();
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			for (let ci = 0; ci < node.children.length; ci++) stack.push(node.children[ci]!);
		}

		return roots;
	}
}
