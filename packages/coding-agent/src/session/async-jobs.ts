/**
 * The background-job manager a top-level session owns, and how a finished job's output reaches the
 * conversation as a follow-up.
 */

import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { type AsyncJob, AsyncJobManager, formatAsyncResultForFollowUp } from "../async";
import type { Settings } from "../config/settings";
import type { OutputMeta } from "../tools/core/output-meta";
import { type CreateAgentSessionOptions, isInProcessChildSession } from "./factory-options";

/**
 * The output meta the producing tool attached to a job's latest details, if any. A truncated
 * result then links the raw capture that meta names instead of writing a second artifact.
 */
function jobOutputMeta(job: AsyncJob | undefined): OutputMeta | undefined {
	const details = job?.latestDetails;
	if (!details || typeof details !== "object" || !("meta" in details)) return undefined;
	const meta = details.meta;
	return typeof meta === "object" && meta !== null ? (meta as OutputMeta) : undefined;
}

/** The session a finished job's follow-up is delivered to, absent until it is constructed. */
export interface AsyncFollowUpTarget {
	readonly isDisposed?: boolean;
	deliverAsyncJobResult(jobId: string, text: string, job?: AsyncJob): unknown;
}

/** What {@link createOwnedAsyncJobManager} reads. */
export interface OwnedAsyncJobsInput {
	options: Pick<CreateAgentSessionOptions, "parentTaskPrefix">;
	settings: Settings;
	sessionManager: Pick<SessionManager, "allocateArtifactPath">;
	target: (ownerId?: string) => AsyncFollowUpTarget | undefined;
}

/**
 * A new AsyncJobManager when this session owns one, else undefined.
 *
 * Every top-level session owns one. Its callback resolves each job's owner in the live registry.
 * Spawned agents share the manager for inspection, but receive only their own completions.
 * Jobs without an owner use the creating session. A missing owner never falls back to Main.
 * A missing or disposed owner retains its completion for the manager's delivery retry.
 * Formatting can await artifact I/O, so delivery resolves the live owner again afterward.
 * The manager retains the original job identity while delivery waits, even after inspection expires.
 * Suppressed delivery never reaches any owner.
 */
export function createOwnedAsyncJobManager(input: OwnedAsyncJobsInput): AsyncJobManager | undefined {
	if (isInProcessChildSession(input.options)) return undefined;
	const manager: AsyncJobManager = new AsyncJobManager({
		maxRunningJobs: Math.min(100, Math.max(1, input.settings.get("async.maxJobs") ?? 100)),
		onJobComplete: async (jobId, result, job) => {
			if (manager.isDeliverySuppressed(jobId)) return;
			const initialTarget = input.target(job?.ownerId);
			if (!initialTarget || initialTarget.isDisposed)
				throw new Error(`Async job owner unavailable: ${job?.ownerId ?? "session"}`);
			const followUp = await formatAsyncResultForFollowUp(result, jobOutputMeta(job), input.sessionManager);
			if (manager.isDeliverySuppressed(jobId)) return;
			const target = input.target(job?.ownerId);
			if (!target || target.isDisposed) throw new Error(`Async job owner unavailable: ${job?.ownerId ?? "session"}`);
			await target.deliverAsyncJobResult(jobId, followUp, job);
		},
	});
	return manager;
}

/**
 * The manager a session runs its jobs on: the one it owns, else the one its spawner handed over.
 * Sharing the manager keeps all jobs visible to inspection without sharing completion turns.
 * The process-wide instance is the fallback for an SDK caller passing a parent prefix alone.
 */
export function sessionAsyncJobManager(
	owned: AsyncJobManager | undefined,
	options: Pick<CreateAgentSessionOptions, "parentTaskPrefix" | "asyncJobManager">,
): AsyncJobManager | undefined {
	if (owned) return owned;
	if (!isInProcessChildSession(options)) return undefined;
	return options.asyncJobManager ?? AsyncJobManager.instance();
}
