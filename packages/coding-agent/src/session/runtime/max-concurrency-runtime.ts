/**
 * Collaborator managing agent max concurrency updates and spawn semaphore resizing.
 *
 * This is a session collaborator. It owns the logic that reacts to changes in
 * `agent.maxConcurrency` and resizes the tree spawn semaphore accordingly, reaching
 * the session only through {@link MaxConcurrencyRuntimeHost}.
 */
import type { Settings } from "../../config/settings";
import { treeSpawnSemaphore } from "../../task/spawn-semaphore";

export interface MaxConcurrencyRuntimeHost {
	readonly settings: Settings;
	readonly sessionId: string;
}

export class MaxConcurrencyRuntime {
	readonly #host: MaxConcurrencyRuntimeHost;

	constructor(host: MaxConcurrencyRuntimeHost) {
		this.#host = host;
	}

	/**
	 * The spawn semaphore otherwise learns a new ceiling only on the next
	 * acquire or release, so a raised `/reload-config` or settings value left
	 * lanes already parked in the queue waiting for an unrelated lane to end.
	 */
	onSettingChanged(): void {
		treeSpawnSemaphore(this.#host.sessionId, this.#host.settings.get("agent.maxConcurrency"));
	}
}
