import { randomUUID } from "node:crypto";
import type { CheckpointClient, CheckpointLease } from "./cloud-checkpoints";
import type { SessionOwnershipMarker } from "./session-ownership-marker";
const runtimeOwner = randomUUID();
/** One local runtime owns this guard. Losing its lease requires an explicit fork or transfer. */
export class SynchronizedSession {
	#lost = false;
	#timer?: NodeJS.Timeout;
	#renewal?: Promise<void>;
	#lease?: CheckpointLease;
	#admission?: Promise<void>;
	#closing?: Promise<void>;
	#resumeToken?: string;
	constructor(
		readonly sessionId: string,
		readonly client: CheckpointClient,
		readonly claim?: SessionOwnershipMarker,
		readonly ownerNode = runtimeOwner,
		readonly persistOwnership?: (resumeToken: string, epoch: number) => Promise<void>,
		private readonly renewalIntervalMs = 15_000,
	) {}
	admit(): Promise<void> {
		if (this.#lost) return Promise.reject(new Error("Synchronized ownership lost. Start an explicit local fork."));
		// Shared ownership acquisition must not race another prompt/tool admission.
		if (this.#admission) return this.#admission;
		const admission = this.#admitOnce();
		this.#admission = admission;
		const clear = () => {
			if (this.#admission === admission) this.#admission = undefined;
		};
		void admission.then(clear, clear);
		return admission;
	}

	#assertOpen(): void {
		if (this.#lost) throw new Error("Synchronized ownership lost. Start an explicit local fork.");
	}

	#loseOwnership(): void {
		this.#lost = true;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async #admitOnce(): Promise<void> {
		this.#assertOpen();
		if (!this.#lease) {
			if (this.claim) {
				const node = process.env.VEYYON_CHECKPOINT_NODE;
				if (!node || node !== this.claim.targetNode)
					throw new Error("This transferred session belongs to a different checkpoint node");
				if (!this.persistOwnership) throw new Error("Transferred session cannot resume without persistent ownership metadata");
				const grant = this.claim.claimToken
					? await this.client.claimTransfer(
							this.sessionId,
							node,
							this.claim.transferId,
							this.claim.claimToken,
							this.claim.transferEpoch,
							this.ownerNode,
						)
					: this.claim.resumeToken
						? await this.client.resumeTransfer(
								this.sessionId,
								node,
								this.claim.transferId,
								this.claim.resumeToken,
								this.claim.transferEpoch,
								this.ownerNode,
							)
						: undefined;
				if (!grant) throw new Error("Transferred session is missing an authority resume capability");
				this.#lease = grant.lease;
				this.#assertOpen();
				try {
					await this.persistOwnership(grant.resumeToken, grant.lease.epoch);
					this.#assertOpen();
					await this.client.finalizeTransfer(
						this.sessionId,
						node,
						this.claim.transferId,
						this.claim.transferEpoch,
						grant.lease.epoch,
						grant.resumeToken,
					);
					this.#assertOpen();
					// Close may persist only a successfully finalized resume capability.
					this.#resumeToken = grant.resumeToken;
				} catch (error) {
					this.#loseOwnership();
					throw error;
				}
			} else {
				this.#lease = await this.client.acquireLease(this.sessionId, this.ownerNode);
			}
			// close() can run while acquisition/finalization is awaiting the authority.
			this.#assertOpen();
		}
		try {
			await this.client.assertWritable(this.sessionId, this.#lease.epoch);
			this.#assertOpen();
			const renewed = await this.client.renewLease(this.sessionId);
			// A successful HTTP renewal can still return an already-expired fence.
			await this.client.assertWritable(this.sessionId, renewed.epoch);
			this.#assertOpen();
			this.#lease = renewed;
		} catch (error) {
			this.#loseOwnership();
			throw error;
		}
		// An expired/rejected grant must not leave a background renewer.
		if (!this.#timer) {
			this.#timer = setInterval(() => {
				if (this.#lost || this.#renewal) return;
				const renewal = this.client.renewLease(this.sessionId)
					.then(async lease => {
						// HTTP 200 is not an admission proof when the returned deadline
						// is expired or cannot be parsed. Fence even without a new admit().
						await this.client.assertWritable(this.sessionId, lease.epoch);
						if (!this.#lost) this.#lease = lease;
					})
					.catch(() => this.#loseOwnership());
				this.#renewal = renewal;
				void renewal.finally(() => {
					if (this.#renewal === renewal) this.#renewal = undefined;
				});
			}, this.renewalIntervalMs);
			this.#timer.unref();
		}
	}
	close(): Promise<void> {
		// A close result is final, including an ambiguous failed /release:
		// never send a second release for the same potentially spent epoch.
		if (!this.#closing) this.#closing = this.#closeOnce();
		return this.#closing;
	}
	async #closeOnce(): Promise<void> {
		// Fence admission and periodic renewal, then drain calls before release.
		this.#loseOwnership();
		await this.#admission?.catch(() => {});
		await this.#renewal;
		try {
			const released = await this.client.releaseLease(this.sessionId);
			if (this.claim && this.#resumeToken && released && this.persistOwnership)
				await this.persistOwnership(this.#resumeToken, released.epoch);
		} finally {
			this.#loseOwnership();
		}
	}
}
