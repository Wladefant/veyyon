/**
 * The FIFO that serializes hook dialogs on the shared editor surface.
 *
 * Selector, input, editor and ask dialogs all clear `editorContainer` and take focus, so showing a second one while
 * the first is open would orphan the first: its promise would hang until the caller's signal aborts. At most one
 * dialog is presented at a time and the rest queue.
 */
export class DialogQueue {
	#active = false;
	#queue: Array<() => void> = [];
	readonly #onPresent: () => void;

	/** @param onPresent Runs each time a dialog takes the surface, before it is built. */
	constructor(onPresent: () => void) {
		this.#onPresent = onPresent;
	}

	/**
	 * Present a modal dialog, serializing against any dialog already open. `present` builds the component, swaps it
	 * into `editorContainer`, steals focus, and returns a `hide` closure; it is invoked with a single `settle` callback
	 * that the component fires on submit/cancel.
	 *
	 * `settle` (or an abort) hides the current dialog and hands the surface to the next queued request. A request whose
	 * signal aborts before its turn resolves `undefined` and is never shown.
	 */
	present<T = string>(
		signal: AbortSignal | undefined,
		present: (settle: (value: T | undefined) => void) => () => void,
	): Promise<T | undefined> {
		const { promise, resolve, reject } = Promise.withResolvers<T | undefined>();
		let settled = false;
		let started = false;
		let hide: (() => void) | undefined;

		function onAbort(): void {
			settle(undefined);
		}

		const settle = (value: T | undefined): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (started) {
				hide?.();
				this.#active = false;
				this.#advance();
			}
			resolve(value);
		};

		const startPresentation = (): void => {
			if (settled) {
				// Aborted before its turn arrived — never present, hand off the surface.
				this.#advance();
				return;
			}
			started = true;
			this.#active = true;
			this.#onPresent();
			try {
				hide = present(settle);
			} catch (error) {
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				this.#active = false;
				reject(error);
				this.#advance();
			}
		};

		if (signal?.aborted) {
			resolve(undefined);
			return promise;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		if (this.#active) {
			this.#queue.push(startPresentation);
		} else {
			startPresentation();
		}
		return promise;
	}

	#advance(): void {
		this.#queue.shift()?.();
	}
}
