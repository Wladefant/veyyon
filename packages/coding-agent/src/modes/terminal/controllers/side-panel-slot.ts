import type { Component, Container } from "@veyyon/tui";
import { errorMessage } from "@veyyon/utils";

/** What a side-channel panel offers the slot that shows it. */
export interface SidePanel extends Component {
	close(): void;
	markAborted(): void;
	markError(message: string): void;
}

/** One side-channel request: the panel that shows it and the signal that cancels it. */
export interface SidePanelRequest {
	readonly component: SidePanel;
	readonly abortController: AbortController;
}

/** Where a slot mounts its panel. */
export interface SidePanelHost {
	container(): Container;
	requestRender(): void;
}

/**
 * The one request a side-channel command (`/btw`, `/omfg`) shows at a time.
 *
 * Showing a request aborts and closes the open one and makes the new panel the container's only
 * child. A request that fails while it is open marks its panel aborted or errored; one that fails
 * after it was replaced or closed changes nothing on screen.
 */
export class SidePanelSlot<TRequest extends SidePanelRequest> {
	#open: TRequest | undefined;
	readonly #host: SidePanelHost;

	constructor(host: SidePanelHost) {
		this.#host = host;
	}

	/** The request on screen, if any. */
	get open(): TRequest | undefined {
		return this.#open;
	}

	isOpen(request: TRequest): boolean {
		return this.#open === request;
	}

	/** The request was replaced, closed or aborted, so its work should stop. */
	isStopped(request: TRequest): boolean {
		return this.#open !== request || request.abortController.signal.aborted;
	}

	show(request: TRequest): void {
		this.close({ abort: true });
		const container = this.#host.container();
		container.clear();
		container.addChild(request.component);
		this.#host.requestRender();
		this.#open = request;
	}

	close(options: { abort: boolean }): void {
		const request = this.#open;
		if (!request) return;
		this.#open = undefined;
		if (options.abort) request.abortController.abort();
		request.component.close();
		this.#host.container().clear();
		this.#host.requestRender();
	}

	/** Escape closes the open request, aborting it if it is still running. Returns whether one was open. */
	escape(): boolean {
		const request = this.#open;
		if (!request) return false;
		this.close({ abort: !request.abortController.signal.aborted });
		return true;
	}

	/** Run a request's work, showing a failure on its panel while the request is still open. */
	async run(request: TRequest, work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch (error) {
			if (!this.isOpen(request)) return;
			if (request.abortController.signal.aborted) request.component.markAborted();
			else request.component.markError(errorMessage(error));
		}
	}
}
