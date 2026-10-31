import { HoverFade, type HoverFadeOptions } from "@veyyon/utils/motion";

/**
 * Manages hover state and transition cross-fades for interactive list/tab components.
 */
export class HoverController<K = number | string> {
	#key: K | null = null;
	#fade?: HoverFade<K>;

	get key(): K | null {
		return this.#key;
	}

	/**
	 * Point at a row (null for "the pointer left the list"). Returns true when the hovered row
	 * changed and the host must repaint; a report naming the row already hovered changes nothing.
	 */
	set(key: K | null): boolean {
		if (key === this.#key) return false;
		this.#key = key;
		this.#fade?.set(key);
		return true;
	}

	setMotion(options: HoverFadeOptions): void {
		this.#fade?.dispose();
		this.#fade = new HoverFade<K>(options);
		if (this.#key !== null) this.#fade.set(this.#key);
	}

	dispose(): void {
		this.#fade?.dispose();
		this.#fade = undefined;
		this.#key = null;
	}

	strength(key: K): number {
		if (this.#fade !== undefined) return this.#fade.strengthAt(key);
		return this.#key === key ? 1 : 0;
	}
}
