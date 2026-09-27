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
 * Only the first top-level session in a process owns one. A spawned agent shares its parent's
 * through `AsyncJobManager.instance()`, and a second top-level session started in-process (the
 * agent-creation architect) shares the live singleton: its own manager would be disposed with it
 * and take the owning session's `task` and `bash` async paths down (issue #1923), or sit orphaned
 * with nothing routed to it. A job that finishes before the session exists, or whose delivery was
 * suppressed while its output was formatted, is not delivered.
 */
export function createOwnedAsyncJobManager(input: OwnedAsyncJobsInput): AsyncJobManager | undefined {
	if (isInProcessChildSession(input.options) || AsyncJobManager.instance()) return undefined;
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
