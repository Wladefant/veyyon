/**
 * What a session holds outside itself that ends with it: the background jobs it and its spawned
 * agents started, the job manager it owns, its eval kernels, the browser tabs and other resources
 * keyed by its session id, and its hold on the MCP manager.
 *
 * This is a session collaborator, the disposal counterpart of `ConversationRelease`, which releases
 * what one conversation holds when the transcript is swapped under a live session. It reaches the
 * session only through {@link SessionReleaseHost}. A release that fails is logged and the next one
 * still runs, and a release that waits on a peer is bounded, so a broken peer cannot hang `/exit`.
 */
import { disposeOwnedResources } from "@veyyon/kernel/session/owned-resources";
import { errorMessage, logger, withTimeout } from "@veyyon/utils";
import { AsyncJobManager } from "../../async";
import type { AgentSessionConfig } from "../agent-session-types";
import type { OwnedAsyncJobs } from "./owned-async-jobs";
import type { UserExecutions } from "./user-executions";

/** How long the owned job manager and the MCP manager each get to release before dispose moves on. */
const RELEASE_TIMEOUT_MS = 3_000;

/** What {@link SessionRelease} needs from the session that holds it. */
export interface SessionReleaseHost {
	/** The background jobs this session and its spawned agents started. */
	readonly ownedJobs: Pick<OwnedAsyncJobs, "cancelOwn">;
	/** The eval runs still in flight, which hold the kernels released after them. */
	readonly executions: Pick<UserExecutions, "settleEvalForDispose">;
	/** The job manager this session owns and the callback that drops its hold on the MCP manager. */
	readonly config: Pick<AgentSessionConfig, "ownedAsyncJobManager" | "releaseMcpManager">;
	/** The id of the transcript the session records to, which keys the resources it created. */
	sessionId(): string | undefined;
}

export class SessionRelease {
	readonly #host: SessionReleaseHost;
	readonly #evalKernelOwnerId: string;

	constructor(host: SessionReleaseHost, evalKernelOwnerId: string) {
		this.#host = host;
		this.#evalKernelOwnerId = evalKernelOwnerId;
	}

	/**
	 * Release the work the session started: its jobs, the job manager it owns, its eval runs, then the
	 * kernels and session-scoped resources they ran on.
	 *
	 * The jobs this agent registered are cancelled so a spawned agent's teardown does not leak its
	 * background bash and task work into the parent's manager. Only the session that owns the manager
	 * disposes it, which also drops leftover jobs and pending deliveries.
	 *
	 * Owner-scoped resources (the Python, Ruby and Julia kernels and the JS eval contexts) are released
	 * through one registry call that runs every disposer and reports the failures together, so one that
	 * throws does not skip the rest or the browser tabs after them. The browser tool's tabs and
	 * browsers live in module-global maps shared with spawned agents and later sessions, so they are
	 * keyed by the session id stamped at `acquireTab` creation and only this session's are released;
	 * the registry bounds a broken CDP close (issue #3963).
	 */
	async releaseWork(): Promise<void> {
		const host = this.#host;
		host.ownedJobs.cancelOwn();
		const ownedAsyncManager = host.config.ownedAsyncJobManager;
		if (ownedAsyncManager) {
			const drained = await ownedAsyncManager.dispose({ timeoutMs: RELEASE_TIMEOUT_MS });
			const deliveryState = ownedAsyncManager.getDeliveryState();
			if (drained === false && deliveryState) {
				logger.warn("Async job completion deliveries still pending during dispose", { ...deliveryState });
			}
			if (AsyncJobManager.instance() === ownedAsyncManager) {
				AsyncJobManager.setInstance(undefined);
			}
		}
		const evalExecutionsSettled = await host.executions.settleEvalForDispose();
		if (!evalExecutionsSettled) {
			logger.warn("Detaching retained eval-kernel ownership during dispose while eval execution is still active");
		}
		try {
			await disposeOwnedResources("eval-kernel-owner", this.#evalKernelOwnerId);
		} catch (error) {
			logger.warn("Some owner-scoped resources failed to release during dispose", { error: errorMessage(error) });
		}
		const sessionId = host.sessionId();
		if (sessionId) {
			try {
				await disposeOwnedResources("session", sessionId);
			} catch (error) {
				logger.warn("Some session-scoped resources failed to release during dispose", {
					error: errorMessage(error),
				});
			}
		}
	}

	/**
	 * Drop the session's hold on the MCP manager. The last top-level holder disconnects it, so its
	 * stdio servers are not orphaned at exit, and a conversation that outlives this one keeps them.
	 * Spawned agents reuse a parent's manager without a hold and pass no callback.
	 *
	 * Bounded: an HTTP/SSE server's session-termination DELETE blocks up to the MCP request timeout
	 * (30 s by default, unbounded when `VEYYON_MCP_TIMEOUT_MS=0`), which would stall `/exit` and the
	 * print-mode shutdown on a broken remote endpoint. A stdio close, the subprocess reap this exists
	 * for, completes well within the bound; a slow transport close finishes detached. A failure is
	 * logged and never thrown out of dispose.
	 */
	async releaseMcpHold(): Promise<void> {
		const releaseMcpManager = this.#host.config.releaseMcpManager;
		if (!releaseMcpManager) return;
		try {
			await withTimeout(
				releaseMcpManager(),
				RELEASE_TIMEOUT_MS,
				"Timed out releasing the MCP manager during dispose",
			);
		} catch (error) {
			logger.warn("Failed to release the MCP manager during dispose", { error: errorMessage(error) });
		}
	}
}
