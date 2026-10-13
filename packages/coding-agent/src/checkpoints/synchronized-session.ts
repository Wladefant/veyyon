import { randomUUID } from "node:crypto";
import type { CheckpointClient, CheckpointLease } from "./cloud-checkpoints";
/** One local runtime owns this guard. Losing its lease requires an explicit fork or transfer. */
export class SynchronizedSession {
	readonly ownerNode: string;
	#timer?: NodeJS.Timeout;
	#lease?: CheckpointLease;
	#lost = false;
	constructor(
		readonly sessionId: string,
		readonly client: CheckpointClient,
		ownerNode = process.env.VEYYON_CHECKPOINT_NODE || randomUUID(),
	) {
		this.ownerNode = ownerNode;
	}
	async admit(): Promise<void> {
		if (this.#lost) throw new Error("Synchronized ownership lost. Start an explicit local fork.");
		if (!this.#lease) {
			this.#lease = await this.client.acquireLease(this.sessionId, this.ownerNode);
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
		// Check server epoch immediately before command admission, not only the cached expiry.
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
