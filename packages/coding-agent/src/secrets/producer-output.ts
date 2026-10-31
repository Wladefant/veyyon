import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { currentProducerSecretOwner } from "./producer-owner";

// Hold a complete record before publishing it: a pipe can split a credential at any byte.
// This is accidental-disclosure protection, not a sandbox against encoded or arbitrary exfiltration.
const MAX_RECORD_CHARS = 64 * 1024;
export const BLOCKED_OUTPUT_RECORD = "[credential output withheld]";
const CREDENTIAL_RECORD =
	/(?:^|[\s"'{,.?-])(?:[A-Za-z0-9]+[_-])*(?:token|secret|password|passwd|credentials?|authorization|api[_-]?key|private[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*["']?\s*(?:[=:]|\s{2,})/i;
const CREDENTIAL_KEY_PREFIX =
	/(?:^|\s+export\s+|[?.,{"'-])(?:[A-Za-z0-9]+[_-])*(?:tok(?:en)?|sec(?:ret)?|pass(?:wd|word)?|credentials?|authori[sz]ation|api[_-]?(?:k(?:e(?:y)?)?)?|private[_-]?k(?:e(?:y)?)?|access[_-]?k(?:e(?:y)?)?)(?:[_-][A-Za-z0-9]*)?$/i;

// Two ordinary assignments remain useful; a bulk run is an inventory even when
// none of its names says "secret". Hold the prefix until that decision is known.
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_MAP_KEY = /["'](?:[A-Z_][A-Z0-9_]*|Path|SystemRoot|ComSpec)["']\s*:/g;
const ENV_TABLE_HEADER = /^\s*Name\s+Value\s*$/im;

function isInventory(text: string): boolean {
	if (ENV_TABLE_HEADER.test(text)) return true;
	let assignments = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		assignments = ENV_ASSIGNMENT.test(line) ? assignments + 1 : 0;
		if (assignments >= 3) return true;
	}
	let keys = 0;
	for (const _match of text.matchAll(ENV_MAP_KEY)) {
		if (++keys >= 3) return true;
	}
	return false;
}

/** Filters text before a producer can stream, retain, minimize, or persist it. */
export class ProducerOutputGuard {
	#pending = "";
	#recordLength = 0;
	#dropping = false;
	#withholding = false;
	#candidate = "";
	#assignments = 0;
	#structured = false;
	#depth = 0;
	#quote = "";
	#escaped = false;
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
			if (
				isInventory(normalized) ||
				normalized.split("\n").some(line => line.length > MAX_RECORD_CHARS || CREDENTIAL_RECORD.test(line))
			) {
				return BLOCKED_OUTPUT_RECORD;
			}
			const redacted = this.#redact?.(normalized) ?? normalized;
			if (redacted !== normalized) return redacted;
			return this.#redact?.(text) ?? text;
		} catch {
			return BLOCKED_OUTPUT_RECORD;
		}
	}

	#block(): string {
		this.#withholding = true;
		this.#pending = "";
		this.#recordLength = 0;
		this.#candidate = "";
		this.#dropping = false;
		return BLOCKED_OUTPUT_RECORD;
	}

	#flushCandidate(): string {
		const candidate = this.#candidate;
		this.#candidate = "";
		this.#assignments = 0;
		this.#structured = false;
		this.#depth = 0;
		this.#quote = "";
		this.#escaped = false;
		const filtered = this.sanitize(candidate);
		return filtered === BLOCKED_OUTPUT_RECORD ? this.#block() : filtered;
	}

	#record(record: string, newline: string): string {
		const normalized = sanitizeText(record);
		if (this.sanitize(record + newline) === BLOCKED_OUTPUT_RECORD) return this.#block() + newline;
		// A registered literal can hold several physical records together. Classify every
		// raw line, but keep the group intact until redaction can see the complete literal.
		const lines = normalized.split("\n");
		const assignment = lines.some(line => ENV_ASSIGNMENT.test(line));
		const separator = this.#candidate.length > 0 && !normalized.trim();
		let prefix = "";
		if (this.#candidate && !this.#structured && !assignment && !separator) prefix = this.#flushCandidate();
		if (this.#withholding) return prefix;
		const structured = this.#structured || lines.some(line => /^\s*[[{]/.test(line));
		if (structured || assignment || separator) {
			if (this.#candidate.length + record.length + newline.length > MAX_RECORD_CHARS)
				return prefix + this.#block() + newline;
			this.#candidate += record + newline;
			for (const line of lines) {
				if (line.trim()) {
					this.#assignments = ENV_ASSIGNMENT.test(line) ? this.#assignments + 1 : 0;
					if (this.#assignments >= 3) return prefix + this.#block() + newline;
				}
				if (!this.#structured) {
					if (!/^\s*[[{]/.test(line)) continue;
					this.#structured = true;
				}
				// Track quoted delimiters only inside a structured record: an earlier
				// ordinary line in the held group may itself contain quotes or braces.
				for (const character of line) {
					if (this.#escaped) {
						this.#escaped = false;
					} else if (this.#quote) {
						if (character === "\\") this.#escaped = true;
						else if (character === this.#quote) this.#quote = "";
					} else if (character === '"' || character === "'") {
						this.#quote = character;
					} else if (character === "{" || character === "[") {
						this.#depth++;
					} else if (character === "}" || character === "]") {
						this.#depth--;
					}
				}
				if (this.#depth <= 0) {
					this.#structured = false;
					this.#depth = 0;
					this.#quote = "";
					this.#escaped = false;
				}
			}
			return prefix + (this.#structured || this.#assignments > 0 ? "" : this.#flushCandidate());
		}
		return prefix + this.sanitize(record + newline);
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
				if (
					this.#recordLength + segmentLength > MAX_RECORD_CHARS ||
					this.#pending.length + segmentLength + separator.length > MAX_RECORD_CHARS
				) {
					this.#pending = "";
					this.#dropping = true;
				} else {
					this.#pending += chunk.slice(offset, end) + separator;
					this.#recordLength += segmentLength;
				}
			}
			if (newline < 0) break;
			this.#recordLength = 0;
			if (this.#dropping) {
				output.push(this.#block() + "\n");
				break;
			}
			let pendingPrefix = 0;
			try {
				pendingPrefix = this.#pendingPrefixLength?.(sanitizeText(this.#pending)) ?? 0;
			} catch {
				this.#block();
				break;
			}
			if (pendingPrefix > 0) {
				offset = newline + 1;
				continue;
			}
			const record = this.#record(this.#pending.slice(0, -1), "\n");
			output.push(record);
			if (this.#withholding) break;
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
				this.#block();
				return "";
			}
		}
		const text = this.#dropping ? this.#block() : this.#record(this.#pending, "");
		this.#pending = "";
		this.#recordLength = 0;
		this.#dropping = false;
		const output = text + (this.#withholding ? "" : this.#flushCandidate());
		if (pendingPrefix > 0) this.#withholding = true;
		return output;
	}

	reset(): void {
		this.#pending = "";
		this.#recordLength = 0;
		this.#dropping = false;
		this.#withholding = false;
		this.#candidate = "";
		this.#assignments = 0;
		this.#structured = false;
		this.#depth = 0;
		this.#quote = "";
		this.#escaped = false;
	}
}
