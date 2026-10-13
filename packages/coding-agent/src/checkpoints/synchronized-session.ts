import { randomUUID } from "node:crypto";
import type { CheckpointClient, CheckpointLease } from "./cloud-checkpoints";
/** One local runtime owns this guard. Losing its lease requires an explicit fork or transfer. */
export class SynchronizedSession {
	readonly ownerNode = randomUUID();
	#timer?: NodeJS.Timeout;
	#lease?: CheckpointLease;
	#lost = false;
	constructor(
		readonly sessionId: string,
		readonly client: CheckpointClient,
		readonly claim?: { targetNode: string; claimToken?: string; epoch: number },
	) {}
	async admit(): Promise<void> {
		if (this.#lost) throw new Error("Synchronized ownership lost. Start an explicit local fork.");
		if (!this.#lease) {
			if (this.claim) {
				const node = process.env.VEYYON_CHECKPOINT_NODE;
				if (!node || node !== this.claim.targetNode)
					throw new Error("This transferred session belongs to a different checkpoint node");
				this.#lease = this.claim.claimToken
					? await this.client.claimTransfer(this.sessionId, node, this.claim.claimToken, this.claim.epoch, this.ownerNode)
					: await this.client.acquireLease(this.sessionId, this.ownerNode);
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
		if (this.#lease && !this.#lost) await this.client.releaseLease(this.sessionId);
		this.#lost = true;
	}
}
