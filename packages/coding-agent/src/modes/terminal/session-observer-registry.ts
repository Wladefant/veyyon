// `../../task/types`, the module that DECLARES these, not the `../../task` barrel that re-exports them: the
// barrel is the whole task subsystem, 1,406 modules, and this file subscribes to two channels by name.
import type { AgentRef, AgentStatus } from "../../registry/agent-registry";
import type { AgentLifecyclePayload, AgentProgress, AgentProgressPayload } from "../../task/types";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../task/types";
import type { EventBus } from "../../utils/event-bus";

export interface ObservableSession {
	id: string;
	kind: "main" | "spawn";
	label: string;
	agent?: string;
	description?: string;
	status: "active" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * The anchored agent HUD only lists detached spawns: sync task spawns
	 * and eval `agent()` spawns are already rendered live by their own inline
	 * tool block / eval cell.
	 */
	detached?: boolean;
	index?: number;
	lastUpdate: number;
	/** Latest progress snapshot from the agent executor */
	progress?: AgentProgress;
}

/** Coarse source of an observer change; callers use it to separate lifecycle work from high-frequency progress. */
export type SessionObserverChangeKind = "main" | "reset" | "lifecycle" | "progress";

const STATUS_MAP: Record<string, ObservableSession["status"]> = {
	started: "active",
	completed: "completed",
	failed: "failed",
	aborted: "aborted",
};

export class SessionObserverRegistry {
	#sessions = new Map<string, ObservableSession>();
	#listeners = new Set<(kind: SessionObserverChangeKind) => void>();
	#eventBusUnsubscribers: Array<() => void> = [];
	#sortOrderById = new Map<string, number>();
	#parentSortOrderById = new Map<string, number>();
	#nextSortOrder = 0;
	/** The last registry status seen per agent id, so {@link mirrorAgentStatus} acts on transitions only. */
	#registryStatusById = new Map<string, AgentStatus>();
	/**
	 * A spawn's settled row as the bus left it, held while a turn {@link mirrorAgentStatus} listed is
	 * running, so the row goes back to the outcome the bus reported rather than one the wake made up.
	 */
	#settledBeforeWake = new Map<string, Pick<ObservableSession, "status" | "detached">>();

	/** Add a change listener. Returns unsubscribe function. */
	onChange(cb: (kind: SessionObserverChangeKind) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	#notifyListeners(kind: SessionObserverChangeKind): void {
		for (const cb of this.#listeners) cb(kind);
	}

	#ensureSortOrder(id: string): number {
		const existing = this.#sortOrderById.get(id);
		if (existing !== undefined) return existing;
		const order = this.#nextSortOrder++;
		this.#sortOrderById.set(id, order);
		return order;
	}

	#ensureParentSortOrder(parentToolCallId: string | undefined, order: number): void {
		if (!parentToolCallId) return;
		if (this.#parentSortOrderById.has(parentToolCallId)) return;
		this.#parentSortOrderById.set(parentToolCallId, order);
	}

	#getStableOrder(session: ObservableSession): number {
		return this.#sortOrderById.get(session.id) ?? Number.MAX_SAFE_INTEGER;
	}

	#getGroupOrder(session: ObservableSession): number {
		const parentOrder = session.parentToolCallId
			? this.#parentSortOrderById.get(session.parentToolCallId)
			: undefined;
		return parentOrder ?? this.#getStableOrder(session);
	}

	setMainSession(sessionFile?: string): void {
		const existing = this.#sessions.get("main");
		this.#ensureSortOrder("main");
		this.#sessions.set("main", {
			id: "main",
			kind: "main",
			label: "Main Session",
			status: "active",
			sessionFile: sessionFile ?? existing?.sessionFile,
			lastUpdate: Date.now(),
		});
		this.#notifyListeners("main");
	}

	getSessions(): ObservableSession[] {
		const sessions = Array.from(this.#sessions.values());
		sessions.sort((a, b) => {
			if (a.kind === "main" && b.kind !== "main") return -1;
			if (b.kind === "main" && a.kind !== "main") return 1;
			if (a.kind === "main" || b.kind === "main") return 0;

			const groupDiff = this.#getGroupOrder(a) - this.#getGroupOrder(b);
			if (groupDiff !== 0) return groupDiff;

			const aIndex = a.index ?? Number.MAX_SAFE_INTEGER;
			const bIndex = b.index ?? Number.MAX_SAFE_INTEGER;
			if (aIndex !== bIndex) return aIndex - bIndex;

			return this.#getStableOrder(a) - this.#getStableOrder(b);
		});
		return sessions;
	}

	/**
	 * The agents one session directly spawned, by the dotted-id spawn-tree
	 * convention: a requested id never contains ".", so a dot marks a nested
	 * child ("Anna.Bob" is Anna's child Bob; see AgentOutputManager). An
	 * undefined `parentId` names the driving session's scope, the top-level
	 * spawns; `"Anna"` names Anna's direct children, not her whole subtree.
	 *
	 * The registry observes ONE session's event bus, so a scope below the root
	 * is empty until that session's bus is observed; for a leaf agent the empty
	 * answer is the truth, not a fallback. The agent HUD scopes itself by the
	 * viewed session through this accessor; the `/agents` roster keeps the
	 * unscoped {@link getSessions}.
	 */
	getSessionsSpawnedBy(parentId: string | undefined): ObservableSession[] {
		return this.getSessions().filter(session => {
			if (session.kind !== "spawn") return false;
			if (parentId === undefined) return !session.id.includes(".");
			const prefix = `${parentId}.`;
			if (!session.id.startsWith(prefix)) return false;
			return !session.id.slice(prefix.length).includes(".");
		});
	}

	getActiveAgentCount(): number {
		let count = 0;
		for (const s of this.#sessions.values()) {
			if (s.kind === "spawn" && s.status === "active") count++;
		}
		return count;
	}

	/**
	 * Follow a spawn's registry status after its own run. The executor reports a spawn's first run
	 * and a `task` follow-up on the event bus, but a turn woken any other way, such as an IRC
	 * message to an idle or parked agent, reports only to the registry: the roster counted it as
	 * running while the Agents block had no row for it.
	 *
	 * Only transitions act, so an event that repeats a status (an approval prompt, a rescope) and
	 * the first status seen for an id change nothing. Entering `running` on a settled row lists the
	 * spawn as a detached run, because no parent turn blocks on a woken agent; a row the bus still
	 * reports as active is the bus's own run and is left to it. Leaving `running` puts a woken row
	 * back to the outcome the bus last reported, or `aborted` when the registry says so: a wake
	 * carries no outcome of its own, so it never turns a failed run into a completed one. Only
	 * spawns this bus reported are followed, so another session's agents stay out.
	 */
	mirrorAgentStatus(ref: Pick<AgentRef, "id" | "status">): void {
		const previous = this.#registryStatusById.get(ref.id);
		this.#registryStatusById.set(ref.id, ref.status);
		if (previous === undefined || previous === ref.status) return;
		const session = this.#sessions.get(ref.id);
		if (session?.kind !== "spawn") return;
		if (ref.status === "running") {
			if (session.status === "active") return;
			this.#settledBeforeWake.set(ref.id, { status: session.status, detached: session.detached });
			session.status = "active";
			session.detached = true;
		} else {
			const settled = this.#settledBeforeWake.get(ref.id);
			if (settled === undefined) return;
			this.#settledBeforeWake.delete(ref.id);
			// The bus reported the woken turn itself (a `task` follow-up) and its outcome stands.
			if (session.status !== "active") return;
			session.status = ref.status === "aborted" ? "aborted" : settled.status;
			session.detached = settled.detached;
		}
		session.lastUpdate = Date.now();
		this.#notifyListeners("lifecycle");
	}

	/** Clear all tracked sessions (e.g. on session switch). Keeps EventBus subscriptions and listeners. */
	resetSessions(): void {
		this.#sessions.clear();
		this.#settledBeforeWake.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#nextSortOrder = 0;
		this.#notifyListeners("reset");
	}

	dispose(): void {
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];
		this.#sessions.clear();
		this.#sortOrderById.clear();
		this.#parentSortOrderById.clear();
		this.#registryStatusById.clear();
		this.#settledBeforeWake.clear();
		this.#nextSortOrder = 0;
		this.#listeners.clear();
	}

	subscribeToEventBus(eventBus: EventBus): void {
		// Dispose previous EventBus subscriptions if called again
		for (const unsub of this.#eventBusUnsubscribers) unsub();
		this.#eventBusUnsubscribers = [];

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
				const payload = data as AgentLifecyclePayload;
				const status = STATUS_MAP[payload.status];
				if (!status) return;

				const sortOrder = this.#ensureSortOrder(payload.id);
				this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
				const existing = this.#sessions.get(payload.id);
				if (existing) {
					existing.status = status;
					existing.lastUpdate = Date.now();
					existing.index = payload.index;
					existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
					existing.detached = payload.detached ?? existing.detached;
					if (payload.description) existing.description = payload.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
				} else {
					this.#sessions.set(payload.id, {
						id: payload.id,
						kind: "spawn",
						label: payload.description ?? `Agent #${payload.index}`,
						agent: payload.agent,
						description: payload.description,
						status,
						sessionFile: payload.sessionFile,
						parentToolCallId: payload.parentToolCallId,
						detached: payload.detached,
						index: payload.index,
						lastUpdate: Date.now(),
					});
				}
				this.#notifyListeners("lifecycle");
			}),
		);

		this.#eventBusUnsubscribers.push(
			eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
				const payload = data as AgentProgressPayload;
				const progress = payload.progress;
				const id = progress.id;
				const existing = this.#sessions.get(id);

				const sortOrder = this.#ensureSortOrder(id);
				this.#ensureParentSortOrder(payload.parentToolCallId, sortOrder);
				if (existing) {
					existing.lastUpdate = Date.now();
					existing.index = payload.index;
					existing.parentToolCallId = payload.parentToolCallId ?? existing.parentToolCallId;
					existing.detached = payload.detached ?? existing.detached;
					existing.progress = progress;
					if (progress.description) existing.description = progress.description;
					if (payload.sessionFile) existing.sessionFile = payload.sessionFile;
				} else {
					this.#sessions.set(id, {
						id,
						kind: "spawn",
						label: progress.description ?? `Agent #${payload.index}`,
						agent: payload.agent,
						description: progress.description,
						status: "active",
						sessionFile: payload.sessionFile,
						parentToolCallId: payload.parentToolCallId,
						detached: payload.detached,
						index: payload.index,
						lastUpdate: Date.now(),
						progress,
					});
				}
				this.#notifyListeners("progress");
			}),
		);
	}
}
