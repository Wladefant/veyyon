/** Per-socket replay memory follows the same windows as the server's history and delivery cache. */
export class TerminalReceipts {
	readonly history = new Set<string>();
	readonly deliveries = new Map<string, object>();

	retainHistory(ids: string[]): void {
		const window = new Set(ids.slice(-1000));
		for (const id of this.history) {
			if (!window.has(id)) this.history.delete(id);
		}
	}

	holdHistory(id: string): void {
		this.history.add(id);
		if (this.history.size > 1000) this.history.delete(this.history.values().next().value!);
	}

	holdDelivery(id: string, status: object): boolean {
		if (this.deliveries.get(id) === status) return false;
		this.deliveries.set(id, status);
		if (this.deliveries.size > 256) this.deliveries.delete(this.deliveries.keys().next().value!);
		return true;
	}
}
