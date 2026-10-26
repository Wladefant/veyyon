import { randomUUID } from "node:crypto";
import type { CheckpointClient, CheckpointLease } from "./cloud-checkpoints";
import type { SessionOwnershipMarker } from "./session-ownership-marker";
const runtimeOwner = randomUUID();
/** One local runtime owns this guard. Losing its lease requires an explicit fork or transfer. */
export class SynchronizedSession {
	#lost = false;
	#timer?: NodeJS.Timeout;
	#lease?: CheckpointLease;
	#resumeToken?: string;
	constructor(
		readonly sessionId: string,
		readonly client: CheckpointClient,
		readonly claim?: SessionOwnershipMarker,
		readonly ownerNode = runtimeOwner,
		readonly persistOwnership?: (resumeToken: string, epoch: number) => Promise<void>,
	) {}
	async admit(): Promise<void> {
		if (this.#lost) throw new Error("Synchronized ownership lost. Start an explicit local fork.");
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
				this.#resumeToken = grant.resumeToken;
				try {
					await this.persistOwnership(grant.resumeToken, grant.lease.epoch);
					await this.client.finalizeTransfer(
						this.sessionId,
						node,
						this.claim.transferId,
						this.claim.transferEpoch,
						grant.lease.epoch,
						grant.resumeToken,
					);
				} catch (error) {
					this.#lost = true;
					throw error;
				}
			} else {
				this.#lease = await this.client.acquireLease(this.sessionId, this.ownerNode);
			}
			this.#timer = setInterval(() => {
				void this.client.renewLease(this.sessionId).then(
					lease => {
						this.#lease = lease;
					},
					() => {
						this.#lost = true;
						clearInterval(this.#timer);
					},
				);
			}, 15000);
			this.#timer.unref();
		}
		await this.client.assertWritable(this.sessionId, this.#lease.epoch);
		try {
			this.#lease = await this.client.renewLease(this.sessionId);
		} catch (error) {
			this.#lost = true;
			throw error;
		}
	}
	async close(): Promise<void> {
		clearInterval(this.#timer);
		try {
			const released = await this.client.releaseLease(this.sessionId);
			if (this.claim && this.#resumeToken && released && this.persistOwnership)
				await this.persistOwnership(this.#resumeToken, released.epoch);
		} finally {
			this.#lost = true;
		}
	}
}
