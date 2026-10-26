// Hold a complete record before publishing it: a pipe can split a credential at any byte.
// This is accidental-disclosure protection, not a sandbox against encoded or arbitrary exfiltration.
const MAX_RECORD_CHARS = 64 * 1024;
export const BLOCKED_OUTPUT_RECORD = "[credential output withheld]";
const CREDENTIAL_RECORD = /(?:^|[\s\"'{,])(?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|credentials?|authorization|api[_-]?key|private[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*[\"']?\s*(?:[=:]|\s{2,})/i;

/** Filters text before a producer can stream, retain, minimize, or persist it. */
export class ProducerOutputGuard {
	#pending = "";
	#dropping = false;
	#withholding = false;
	readonly #redact: ((text: string) => string) | undefined;

	constructor(redact?: (text: string) => string) {
		this.#redact = redact;
	}

	sanitize(text: string): string {
		if (text.length > MAX_RECORD_CHARS || text.split("\n").some(line => CREDENTIAL_RECORD.test(line))) {
			return BLOCKED_OUTPUT_RECORD;
		}
		try {
			return this.#redact?.(text) ?? text;
		} catch {
			return BLOCKED_OUTPUT_RECORD;
		}
	}

	push(chunk: string): string {
		if (this.#withholding) return "";
		const output: string[] = [];
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf("\n", offset);
			const end = newline < 0 ? chunk.length : newline;
			if (!this.#dropping) {
				if (this.#pending.length + end - offset > MAX_RECORD_CHARS) {
					this.#pending = "";
					this.#dropping = true;
				} else {
					this.#pending += chunk.slice(offset, end);
				}
			}
			if (newline < 0) break;
			const record = this.#dropping ? BLOCKED_OUTPUT_RECORD : this.sanitize(this.#pending);
			output.push(record + "\n");
			if (record === BLOCKED_OUTPUT_RECORD) {
				this.#withholding = true;
				this.#pending = "";
				this.#dropping = false;
				break;
			}
			this.#pending = "";
			this.#dropping = false;
			offset = newline + 1;
		}
		return output.join("");
	}

	finish(): string {
		if (this.#withholding) return "";
		const text = this.#dropping ? BLOCKED_OUTPUT_RECORD : this.sanitize(this.#pending);
		this.#pending = "";
		this.#dropping = false;
		if (text === BLOCKED_OUTPUT_RECORD) this.#withholding = true;
		return text;
	}

	reset(): void {
		this.#pending = "";
		this.#dropping = false;
		this.#withholding = false;
	}
}
