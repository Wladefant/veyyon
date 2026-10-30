import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { currentProducerSecretOwner } from "./producer-owner";

// Hold a complete record before publishing it: a pipe can split a credential at any byte.
// This is accidental-disclosure protection, not a sandbox against encoded or arbitrary exfiltration.
const MAX_RECORD_CHARS = 64 * 1024;
export const BLOCKED_OUTPUT_RECORD = "[credential output withheld]";
const CREDENTIAL_RECORD = /(?:^|[\s\"'{,.?\-])(?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|credentials?|authorization|api[_-]?key|private[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*[\"']?\s*(?:[=:]|\s{2,})/i;
const CREDENTIAL_KEY_PREFIX = /(?:^|\s+export\s+|[?.,{\"'\-])(?:[A-Za-z0-9]+[_-])*(?:tok(?:en)?|sec(?:ret)?|pass(?:wd|word)?|credentials?|authori[sz]ation|api[_-]?(?:k(?:e(?:y)?)?)?|private[_-]?k(?:e(?:y)?)?|access[_-]?k(?:e(?:y)?)?)(?:[_-][A-Za-z0-9]*)?$/i;

/** Filters text before a producer can stream, retain, minimize, or persist it. */
export class ProducerOutputGuard {
	#pending = "";
	#recordLength = 0;
	#dropping = false;
	#withholding = false;
	readonly #redact: ((text: string) => string) | undefined;
	readonly #pendingPrefixLength: ((text: string) => number) | undefined;

	constructor(
		redact?: (text: string) => string,
		pendingPrefixLength?: (text: string) => number,
	) {
		const owner = currentProducerSecretOwner();
		this.#redact = redact ?? owner?.redact;
		this.#pendingPrefixLength = pendingPrefixLength ?? owner?.pendingPrefixLength;
	}

	sanitize(text: string): string {
		try {
			const normalized = sanitizeText(text);
			if (normalized.split("\n").some(line => line.length > MAX_RECORD_CHARS || CREDENTIAL_RECORD.test(line))) {
				return BLOCKED_OUTPUT_RECORD;
			}
			const redacted = this.#redact?.(normalized) ?? normalized;
			if (redacted !== normalized) return redacted;
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
			const separator = newline < 0 ? "" : "\n";
			if (!this.#dropping) {
				const segmentLength = end - offset;
				const next = this.#pending + chunk.slice(offset, end) + separator;
				if (
					this.#recordLength + segmentLength > MAX_RECORD_CHARS ||
					next.length > MAX_RECORD_CHARS
				) {
					this.#pending = "";
					this.#dropping = true;
				} else {
					this.#pending = next;
					this.#recordLength += segmentLength;
				}
			}
			if (newline < 0) break;
			this.#recordLength = 0;
			if (this.#dropping) {
				this.#withholding = true;
				this.#pending = "";
				this.#dropping = false;
				output.push(BLOCKED_OUTPUT_RECORD + "\n");
				break;
			}
			let pendingPrefix = 0;
			try {
				pendingPrefix = this.#pendingPrefixLength?.(sanitizeText(this.#pending)) ?? 0;
			} catch {
				this.#withholding = true;
				this.#pending = "";
				break;
			}
			if (pendingPrefix > 0) {
				offset = newline + 1;
				continue;
			}
			const record = this.sanitize(this.#pending);
			output.push(record === BLOCKED_OUTPUT_RECORD ? record + "\n" : record);
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
		if (!this.#dropping && CREDENTIAL_KEY_PREFIX.test(this.#pending)) {
			return "";
		}
		let pendingPrefix = 0;
		if (!this.#dropping) {
			try {
				pendingPrefix = this.#pendingPrefixLength?.(sanitizeText(this.#pending)) ?? 0;
			} catch {
				this.#pending = "";
				this.#withholding = true;
				return "";
			}
		}
		const text = this.#dropping ? BLOCKED_OUTPUT_RECORD : this.sanitize(this.#pending);
		this.#pending = "";
		this.#recordLength = 0;
		this.#dropping = false;
		if (pendingPrefix > 0 || text === BLOCKED_OUTPUT_RECORD) this.#withholding = true;
		return text;
	}

	reset(): void {
		this.#pending = "";
		this.#recordLength = 0;
		this.#dropping = false;
		this.#withholding = false;
	}
}
