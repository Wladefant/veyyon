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
	deliverAsyncJobResult(jobId: string, text: string, job?: AsyncJob): unknown;
}

/** What {@link createOwnedAsyncJobManager} reads. */
export interface OwnedAsyncJobsInput {
	options: Pick<CreateAgentSessionOptions, "parentTaskPrefix">;
	settings: Settings;
	sessionManager: Pick<SessionManager, "allocateArtifactPath">;
	target: () => AsyncFollowUpTarget | undefined;
}

/**
 * A new AsyncJobManager when this session owns one, else undefined.
 *
 * Every top-level session owns one, and its `onJobComplete` delivers to that session and no other.
 * A second top-level session in the same process (the foreground session after a `/new` handoff,
 * the agent-creation architect) therefore runs background work of its own, and a job it starts
 * reports to it rather than to the session that happened to be built first. A spawned agent owns
 * none: it runs its jobs on the manager of the session that spawned it, so their results reach
 * that conversation. A job that finishes before the session exists, or whose delivery was
 * suppressed while its output was formatted, is not delivered.
 */
export function createOwnedAsyncJobManager(input: OwnedAsyncJobsInput): AsyncJobManager | undefined {
	if (isInProcessChildSession(input.options)) return undefined;
	const manager: AsyncJobManager = new AsyncJobManager({
		maxRunningJobs: Math.min(100, Math.max(1, input.settings.get("async.maxJobs") ?? 100)),
		onJobComplete: async (jobId, result, job) => {
			const target = input.target();
			if (!target || manager.isDeliverySuppressed(jobId)) return;
			const followUp = await formatAsyncResultForFollowUp(result, jobOutputMeta(job), input.sessionManager);
			if (manager.isDeliverySuppressed(jobId)) return;
			target.deliverAsyncJobResult(jobId, followUp, job);
		},
	});
	return manager;
}

/**
 * The manager a session runs its jobs on: the one it owns, else, for a spawned agent, the one its
 * spawner handed over, so a result reaches the conversation that spawned it. The process-wide
 * instance is the fallback for an SDK caller that passes a parent prefix and no manager.
 */
export function sessionAsyncJobManager(
	owned: AsyncJobManager | undefined,
	options: Pick<CreateAgentSessionOptions, "parentTaskPrefix" | "asyncJobManager">,
): AsyncJobManager | undefined {
	if (owned) return owned;
	if (!isInProcessChildSession(options)) return undefined;
	return options.asyncJobManager ?? AsyncJobManager.instance();
}
