/**
 * packages/coding-agent/src/task/topic-replenishment.ts
 *
 * Generic subagent completion and topic replenishment coordination engine.
 *
 * Provides opt-in coordination for replenishing subagent worker tasks
 * when running subagents complete, bounded by configurable target capacity.
 */

export interface NativeActorSnapshot {
	id: string;
	status: string;
	role?: string;
	topic?: string;
	task?: string;
	metadata?: Record<string, unknown>;
}
export const INACTIVE_STATUSES: Readonly<Record<string, true>> = {
	idle: true,
	parked: true,
	completed: true,
	stopped: true,
	terminated: true,
	cancelled: true,
};

export interface ClaimedTicket {
	id: string;
	topic: string;
	prompt: string;
	task?: string;
	metadata?: Record<string, unknown>;
}

export interface BlockedTopicInfo {
	topic: string;
	ticketId: string;
	reason: string;
}

export interface ClaimTicketResult {
	claimed: boolean;
	ticket?: ClaimedTicket;
	reason?: string;
	blockedTopics?: BlockedTopicInfo[];
}

export interface TicketProvider {
	claimNext(coveredTopics: string[]): Promise<ClaimTicketResult> | ClaimTicketResult;
	complete?(ticketId: string, result?: Record<string, unknown>): Promise<void> | void;
	rollback?(ticketId: string, reason: string): Promise<void> | void;
}

export interface TopicReconciliationResult {
	activeWorkers: NativeActorSnapshot[];
	activeUsefulCount: number;
	idleWorkers: NativeActorSnapshot[];
	parkedWorkers: NativeActorSnapshot[];
	otherInactiveWorkers: NativeActorSnapshot[];
	coveredTopics: string[];
	uncoveredTopics: string[];
	runningWorkersByTopic: Record<string, string[]>;
	targetDeficit: number;
	eligibleTopicCount: number;
}

export interface TopicReplenishmentEngineOptions {
	targetCount?: number;
	maxCeiling?: number;
	eligibleTopics?: readonly string[];
	provider?: TicketProvider;
	executor?: (ticket: ClaimedTicket) => Promise<unknown>;
}

export interface ReplenishmentOutcome {
	reconciliation: TopicReconciliationResult;
	dispatchedTickets: ClaimedTicket[];
	dispatchedCount: number;
	blockedTopics: BlockedTopicInfo[];
	status: "replenished" | "target_satisfied" | "no_eligible_work" | "error";
	reason?: string;
}

export interface SubagentCompleteEvent {
	agentId: string;
	agentName: string;
	task: string;
	status: "completed" | "failed" | "cancelled";
	exitCode?: number;
	durationMs?: number;
	error?: string;
	ticketId?: string;
	structuredResult?: Record<string, unknown>;
}

/**
 * Reconcile running workers against eligible topics and calculate capacity deficit.
 */
export function reconcileRunningTopics(
	roster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
	options?: {
		targetCount?: number;
		eligibleTopics?: readonly string[];
	},
): TopicReconciliationResult {
	const targetCount = options?.targetCount ?? 0;
	const eligibleTopics = options?.eligibleTopics ?? [];

	const activeWorkers: NativeActorSnapshot[] = [];
	const idleWorkers: NativeActorSnapshot[] = [];
	const parkedWorkers: NativeActorSnapshot[] = [];
	const otherInactiveWorkers: NativeActorSnapshot[] = [];

	const runningWorkersByTopic: Record<string, string[]> = {};
	for (const t of eligibleTopics) {
		runningWorkersByTopic[t] = [];
	}

	for (const raw of roster) {
		const item: NativeActorSnapshot = {
			id: String(raw.id || "unknown"),
			status: String(raw.status || "idle").toLowerCase(),
			role: raw.role ? String(raw.role).toLowerCase() : "sub",
			topic: raw.topic ? String(raw.topic) : undefined,
			task: raw.task ? String(raw.task) : undefined,
			metadata: (raw.metadata as Record<string, unknown>) || undefined,
		};

		if (item.status === "idle") {
			idleWorkers.push(item);
			continue;
		}

		if (item.status === "parked") {
			parkedWorkers.push(item);
			continue;
		}

		if (INACTIVE_STATUSES[item.status]) {
			otherInactiveWorkers.push(item);
			continue;
		}

		if (item.status === "running") {
			if (item.role === "main" || item.id === "Main" || item.id.startsWith("main:")) {
				continue;
			}
			activeWorkers.push(item);
			const topic = item.topic || "general";
			if (!runningWorkersByTopic[topic]) {
				runningWorkersByTopic[topic] = [];
			}
			runningWorkersByTopic[topic].push(item.id);
		} else {
			otherInactiveWorkers.push(item);
		}
	}

	const activeUsefulCount = activeWorkers.length;
	const coveredTopics = Object.entries(runningWorkersByTopic)
		.filter(([, workers]) => workers.length > 0)
		.map(([topic]) => topic);

	const uncoveredTopics = eligibleTopics.filter(t => !coveredTopics.includes(t));
	const eligibleTopicCount = eligibleTopics.length;
	const targetDeficit = Math.max(0, targetCount - activeUsefulCount);

	return {
		activeWorkers,
		activeUsefulCount,
		idleWorkers,
		parkedWorkers,
		otherInactiveWorkers,
		coveredTopics,
		uncoveredTopics,
		runningWorkersByTopic,
		targetDeficit,
		eligibleTopicCount,
	};
}

/**
 * Opt-in engine to coordinate subagent worker replenishment.
 */
export class TopicReplenishmentEngine {
	targetCount: number;
	maxCeiling: number;
	eligibleTopics: readonly string[];
	provider?: TicketProvider;
	executor?: (ticket: ClaimedTicket) => Promise<unknown>;

	constructor(options?: TopicReplenishmentEngineOptions) {
		this.targetCount = options?.targetCount ?? 0;
		this.maxCeiling = options?.maxCeiling ?? 10;
		this.eligibleTopics = options?.eligibleTopics ?? [];
		this.provider = options?.provider;
		this.executor = options?.executor;
	}

	setExecutor(executor: (ticket: ClaimedTicket) => Promise<unknown>): void {
		this.executor = executor;
	}

	setProvider(provider: TicketProvider): void {
		this.provider = provider;
	}

	/**
	 * Perform a single replenishment cycle.
	 */
	async replenish(
		currentRoster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
		options?: {
			dispatchWorker?: (ticket: ClaimedTicket) => Promise<unknown>;
		},
	): Promise<ReplenishmentOutcome> {
		const reconciliation = reconcileRunningTopics(currentRoster, {
			targetCount: this.targetCount,
			eligibleTopics: this.eligibleTopics,
		});

		if (reconciliation.targetDeficit <= 0) {
			return {
				reconciliation,
				dispatchedTickets: [],
				dispatchedCount: 0,
				blockedTopics: [],
				status: "target_satisfied",
				reason: `Target worker count (${this.targetCount}) already satisfied with ${reconciliation.activeUsefulCount} active workers.`,
			};
		}

		const executor = options?.dispatchWorker ?? this.executor;
		if (!executor || !this.provider) {
			return {
				reconciliation,
				dispatchedTickets: [],
				dispatchedCount: 0,
				blockedTopics: [],
				status: "no_eligible_work",
				reason: !executor ? "No task executor configured." : "No ticket provider configured.",
			};
		}

		const dispatchedTickets: ClaimedTicket[] = [];
		const blockedTopics: BlockedTopicInfo[] = [];

		while (dispatchedTickets.length < reconciliation.targetDeficit) {
			if (reconciliation.activeUsefulCount + dispatchedTickets.length >= this.maxCeiling) {
				break;
			}

			const covered = new Set([...reconciliation.coveredTopics, ...dispatchedTickets.map(t => t.topic)]);
			const claimResult = await this.provider.claimNext(Array.from(covered));

			if (!claimResult.claimed || !claimResult.ticket) {
				if (claimResult.blockedTopics) {
					blockedTopics.push(...claimResult.blockedTopics);
				}
				break;
			}

			const ticket = claimResult.ticket;
			try {
				await executor(ticket);
				dispatchedTickets.push(ticket);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				await this.provider.rollback?.(ticket.id, reason);
				break;
			}
		}

		return {
			reconciliation,
			dispatchedTickets,
			dispatchedCount: dispatchedTickets.length,
			blockedTopics,
			status: dispatchedTickets.length > 0 ? "replenished" : "no_eligible_work",
			reason:
				dispatchedTickets.length > 0
					? `Dispatched ${dispatchedTickets.length} worker(s).`
					: "No further eligible tickets available.",
		};
	}

	/**
	 * Hook invoked when a subagent completes.
	 */
	async onWorkerComplete(
		event: SubagentCompleteEvent,
		currentRoster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
	): Promise<ReplenishmentOutcome> {
		if (event.ticketId && this.provider?.complete) {
			try {
				await this.provider.complete(event.ticketId, event.structuredResult);
			} catch {
				// Non-fatal completion notification
			}
		}
		return this.replenish(currentRoster);
	}

	/**
	 * Hook invoked on session recovery.
	 */
	async onSessionRecovery(
		currentRoster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
	): Promise<ReplenishmentOutcome> {
		return this.replenish(currentRoster);
	}
}
