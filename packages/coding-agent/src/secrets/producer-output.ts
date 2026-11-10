import { PROVIDER_SECRET_FAMILIES, redactProviderSecrets } from "@veyyon/ai/error/error-body";
import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { stringifyJsonSafe } from "@veyyon/utils/json";
import { currentProducerSecretOwner } from "./producer-owner";
import { sanitizeJsonValue } from "../eval/json-sanitizer";

// Hold a complete record before publishing it: a pipe can split a credential at any byte.
// This is accidental-disclosure protection, not a sandbox against encoded or arbitrary exfiltration.
const MAX_RECORD_CHARS = 64 * 1024;
export const BLOCKED_OUTPUT_RECORD = "[credential output withheld]";
export const OVERSIZED_OUTPUT_RECORD = "[line over 65,536 chars, not scanned]";
const CREDENTIAL_RECORD =
	/(?<boundary>^|[\s"'{,.?-])(?<key>(?:[A-Za-z0-9]+[_-])*(?:auth|token|secret|password|passwd|pin|cookie|credentials?|authorization|api[_-]?key|private[_-]?key|access[_-]?key)(?:[_-][A-Za-z0-9]+)*)["']?\s*(?:[=:]|\s{2,})/i;
const CREDENTIAL_KEY_PREFIX =
	/(?:^|\s+export\s+|[?.,{"'-])(?:[A-Za-z0-9]+[_-])*(?:tok(?:en)?|sec(?:ret)?|pass(?:wd|word)?|pin|cookie|credentials?|authori[sz]ation|api[_-]?(?:k(?:e(?:y)?)?)?|private[_-]?k(?:e(?:y)?)?|access[_-]?k(?:e(?:y)?)?)(?:[_-][A-Za-z0-9]*)?$/i;

// Two ordinary assignments remain useful; a bulk run is an inventory even when
// none of its names says "secret". Hold the prefix until that decision is known.
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;
const ENV_MAP_KEY = /^(?:[A-Z_][A-Z0-9_]*|Path|SystemRoot|ComSpec)$/;
const ENV_TABLE_HEADER = /^\s*Name\s+Value\s*$/im;

/** A defs() entry names a variable and its shape, never the variable's value. */
const DEFINITION_SHAPE = /^(?:str|string|bool|boolean|int|float|number|bigint|symbol|undefined|null|NoneType|function|module|object(?:\(\d+ keys\))?|Array\(\d+\)|(?:list|tuple|dict|set|frozenset|bytes|bytearray)\(\d+\))(?=$|\r?\n|["'](?:\s*[,)\]]|\s*$)|(?<sourceDelimiter>[ \t]*[,;}]))/;

const PEM_BLOCK = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
const PEM_START = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const EXTRA_PREFIXED_KEY = /\b(?:github_pat_[A-Za-z0-9_]{22,}|figd_[A-Za-z0-9_-]{16,})/g;
const REDACTION_MARKER = /^(?:\[REDACTED\]|<redacted(?: credential| \d+ chars)?>|#[A-Za-z0-9_]+#)(?=[ \t]*(?:\r?\n|$))/;
const NUMERIC_METADATA_KEY = /[_-](?:count|length|size|limit|ttl)$/i;
const NUMERIC_METADATA_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?(?=[ \t]*(?:\r?\n|$|[,;}\]]))/;
const BARE_PROVIDER_SECRET_FAMILIES = PROVIDER_SECRET_FAMILIES.filter(family => !family.name.startsWith("labelled-"));

function knownCredentialLength(text: string): number {
	if (text.startsWith("-----BEGIN ")) {
		PEM_BLOCK.lastIndex = 0;
		const pem = PEM_BLOCK.exec(text);
		if (pem?.index === 0) return pem[0].length;
	}
	const redacted = redactProviderSecrets(text);
	const marker = text.startsWith("<redacted ") || redacted === text ? null : /^<redacted (\d+) chars>/.exec(redacted);
	if (marker) return Number(marker[1]);
	EXTRA_PREFIXED_KEY.lastIndex = 0;
	const extra = EXTRA_PREFIXED_KEY.exec(text);
	return extra?.index === 0 ? extra[0].length : 0;
}

function classifyCredentialText(text: string, redact?: (text: string) => string): string {
	const labels = new RegExp(CREDENTIAL_RECORD.source, "gi");
	const spans: { start: number; valueStart: number; end: number; extendToLine: boolean }[] = [];
	for (let match = labels.exec(text); match; match = labels.exec(text)) {
		const start = labels.lastIndex + /^[ \t]*/.exec(text.slice(labels.lastIndex))![0].length;
		const tail = text.slice(start);
		const shape = match[0].includes(":") ? DEFINITION_SHAPE.exec(tail) : null;
		const sourceType = /\b(?:type|interface)\s+[A-Za-z_$][\w$]*[^;\n]*[={]/.test(text.slice(0, match.index));
		if (shape && (!shape.groups?.sourceDelimiter || sourceType)) continue;
		const boundaryLength = match.groups!.boundary.length;
		if (match[0].slice(boundaryLength).includes("\n") || !tail || /^[ \t]*(?:\r?\n|$)/.test(tail)) {
			return BLOCKED_OUTPUT_RECORD;
		}
		if (NUMERIC_METADATA_KEY.test(match.groups!.key) && NUMERIC_METADATA_VALUE.test(tail)) continue;
		if (REDACTION_MARKER.test(tail) || /^<redacted \d+ chars>(?=$|[ \t])/.test(tail) || /^#[A-Za-z0-9_]+#(?=$|[ \t])/.test(tail)) continue;
		if (/^[{[|>]/.test(tail)) return BLOCKED_OUTPUT_RECORD;
		const quoted = isQuote(tail[0]);
		const quoteEnd = quoted ? quotedEnd(tail, 0) : -1;
		if (quoted && quoteEnd === tail.length) return BLOCKED_OUTPUT_RECORD;
		// Unknown unquoted values extend through their physical record.
		const newline = tail.indexOf("\n");
		const knownLength = quoted ? 0 : knownCredentialLength(tail);
		if (!quoted && !knownLength && PEM_START.test(tail)) return BLOCKED_OUTPUT_RECORD;
		const end = quoted ? start + quoteEnd : start + (knownLength || (newline < 0 ? tail.length : newline));
		spans.push({
			start: match.index + boundaryLength,
			valueStart: start + (quoted ? 1 : 0),
			end,
			extendToLine: knownLength > 0,
		});
		labels.lastIndex = Math.max(end + (quoted ? 1 : 0), start + 1);
	}
	PEM_BLOCK.lastIndex = 0;
	for (const pem of text.matchAll(PEM_BLOCK)) {
		spans.push({ start: pem.index, valueStart: pem.index, end: pem.index + pem[0].length, extendToLine: true });
	}
	for (let attempt = 0; attempt < (redact ? 2 : 1); attempt++) {
		spans.sort((left, right) => left.start - right.start);
		let count = 0;
		for (const span of spans) {
			const previous = spans[count - 1];
			if (previous && span.start < previous.end) {
				if (span.end > previous.end) {
					previous.end = span.end;
					previous.extendToLine = span.extendToLine;
				}
			} else {
				spans[count++] = span;
			}
		}
		spans.length = count;
		let result = "";
		let rawProjection = "";
		let normalizedProjection = "";
		let cursor = 0;
		let index = 0;
		let sensitive = false;
		while (cursor < text.length || index < spans.length) {
			const span = spans[index];
			const end = sensitive ? span.end : (span?.start ?? text.length);
			const fragment = text.slice(cursor, end);
			if (redact) {
				const owned = redact(fragment);
				const normalized = redact(sanitizeText(owned));
				rawProjection += owned;
				normalizedProjection += normalized;
				if (sensitive) {
					const prefix = redact(sanitizeText(redact(text.slice(span.start, span.valueStart))));
					// A contextual owner may change the label as well as its value.
					result += normalized.startsWith(prefix) ? prefix + "[REDACTED]" : "[REDACTED]";
				} else {
					result += normalized;
				}
			} else {
				result += sensitive ? text.slice(span.start, span.valueStart) + "[REDACTED]" : fragment;
			}
			cursor = end;
			if (sensitive) {
				index++;
				sensitive = false;
			} else {
				sensitive = span !== undefined;
			}
		}
		if (!redact) return PEM_START.test(result) ? BLOCKED_OUTPUT_RECORD : result;
		const owned = redact(text);
		// Masking must not split a registered literal or change its owner context.
		if (rawProjection === owned && normalizedProjection === redact(sanitizeText(owned))) {
			const ownerKeptCredential = spans.some(span =>
				owned.includes(text.slice(span.valueStart, span.end)),
			);
			if (ownerKeptCredential) return PEM_START.test(result) ? BLOCKED_OUTPUT_RECORD : result;
			const ownerMasked = sanitizeText(owned);
			const safe = classifyCredentialText(ownerMasked);
			return safe === BLOCKED_OUTPUT_RECORD ? safe : sanitizeText(safe);
		}
		let extended = false;
		for (const span of spans) {
			if (!span.extendToLine) continue;
			const newline = text.indexOf("\n", span.end);
			const end = newline < 0 ? text.length : newline;
			extended ||= end > span.end;
			span.end = end;
		}
		if (!extended) break;
	}
	const ownerMasked = sanitizeText(redact(text));
	const safe = classifyCredentialText(ownerMasked);
	return safe === BLOCKED_OUTPUT_RECORD ? safe : sanitizeText(safe);
}

function isQuote(character: string): boolean {
	return character === '"' || character === "'" || character === "`";
}

function quotedEnd(text: string, start: number): number {
	const quote = text[start];
	for (let index = start + 1; index < text.length; index++) {
		if (text[index] === "\\") index++;
		else if (text[index] === quote) return index;
	}
	return text.length;
}

function structuredStart(text: string): number {
	// Only a complete scalar record owns its quotes. Quotes in raw labels must
	// not consume delimiters belonging to a later structured argument.
	for (let start = 0; start < text.length; start++) {
		const character = text[start];
		if (character === '"' && !text.slice(0, start).trim()) {
			const end = quotedEnd(text, start);
			const lineEnd = text.indexOf("\n", end);
			const remainder = text.slice(end + 1, lineEnd < 0 ? text.length : lineEnd);
			if (end < text.length && !remainder.trim()) {
				start = end;
				continue;
			}
		}
		if (character === "{") return start;
		if (character === "[") {
			// Runtime severity prefixes and bracketed labels are not arrays.
			const label = /^\[[A-Za-z_][^\n[\]{}]*\]/.exec(text.slice(start));
			if (label) {
				start += label[0].length - 1;
				continue;
			}
			return start;
		}
	}
	return -1;
}

function hasInventoryKeys(text: string): boolean {
	const start = structuredStart(text);
	const scanStart = start >= 0 ? start : text.search(/\S/);
	const containers: string[] = [];
	let expectingKey = false;
	let keys = 0;
	for (let index = Math.max(scanStart, 0); index < text.length; index++) {
		const character = text[index];
		if (/\s/.test(character)) continue;
		if (character === "{" || character === "[") {
			containers.push(character);
			expectingKey = character === "{";
		} else if (character === "}" || character === "]") {
			containers.pop();
			expectingKey = false;
		} else if (character === ",") {
			expectingKey = containers.at(-1) === "{";
		} else {
			const tokenStart = index;
			const quoted = isQuote(character);
			if (quoted) index = quotedEnd(text, index);
			else while (index + 1 < text.length && /[A-Za-z0-9_$]/.test(text[index + 1])) index++;
			if (expectingKey) {
				const name = text.slice(tokenStart + (quoted ? 1 : 0), index + (quoted ? 0 : 1));
				let next = index + 1;
				while (next < text.length && /\s/.test(text[next])) next++;
				if (text[next] === ":" && ENV_MAP_KEY.test(name) && ++keys >= 3) return true;
			}
			expectingKey = false;
		}
	}
	return false;
}

function isInventory(text: string): boolean {
	if (ENV_TABLE_HEADER.test(text)) return true;
	let assignments = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		assignments = ENV_ASSIGNMENT.test(line) ? assignments + 1 : 0;
		if (assignments >= 3) return true;
	}
	return hasInventoryKeys(text);
}

// util.inspect prints a RegExp bare (`{ pattern: /\{/ }`), so a delimiter it escapes or
// holds in a class is not structure. Only a value position that closes on its own line
// counts; any other slash is ordinary text, so a lone path segment cannot hide a brace.
const REGEX_LITERAL = /\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[])+\/[dgimsuvy]*/y;
const REGEX_VALUE_START = ":,[{>";

/** Characters after `start` that a RegExp literal opening there covers, or 0. */
function regexLiteralLength(line: string, start: number, depth: number): number {
	let previous = start - 1;
	while (previous >= 0 && (line[previous] === " " || line[previous] === "\t")) previous--;
	// Console arguments are flattened with spaces, so later RegExp arguments may
	// follow a scalar or another RegExp; the complete-literal check below still
	// rejects a lone slash or division operator.
	const consoleArgument = depth === 0 && previous < start - 1;
	if (previous >= 0 && !REGEX_VALUE_START.includes(line[previous]) && !consoleArgument) return 0;
	REGEX_LITERAL.lastIndex = start;
	const match = REGEX_LITERAL.exec(line);
	if (!match) return 0;
	const end = start + match[0].length;
	if (consoleArgument && end < line.length && line[end] !== " " && line[end] !== "\t") return 0;
	return match[0].length - 1;
}

/** Keep JSON structure and primitive metadata out of the text-record grammar. */
export function sanitizeProducerJson(value: unknown, guard: ProducerOutputGuard): unknown {
	const safe = sanitizeJsonValue(value, text => guard.sanitize(text), {
		cycles: "mark",
		transformValue: (nested, key) => {
			if (key !== undefined && CREDENTIAL_RECORD.test(`${key}=`)) {
				if (typeof nested === "number" || typeof nested === "bigint") {
					if (!NUMERIC_METADATA_KEY.test(key)) return "[REDACTED]";
				} else if (typeof nested === "string") {
					if (REDACTION_MARKER.test(nested)) return nested;
					if (NUMERIC_METADATA_KEY.test(key) && NUMERIC_METADATA_VALUE.exec(nested)?.[0] === nested) return nested;
					return "[REDACTED]";
				} else if (nested !== null && typeof nested !== "boolean" && nested !== undefined) {
					if (/^(?:auth|authorization)$/i.test(key)) return "[REDACTED]";
					return BLOCKED_OUTPUT_RECORD;
				}
			}
			if (typeof nested === "bigint") return `${nested}n`;
			if (typeof nested === "function" || typeof nested === "symbol") return JSON.parse(stringifyJsonSafe(nested));
			return nested;
		},
	});
	const serialized = JSON.stringify(safe);
	if (typeof serialized === "string" && serialized.length > MAX_RECORD_CHARS) return OVERSIZED_OUTPUT_RECORD;
	return typeof serialized !== "string" || isInventory(sanitizeText(serialized)) ? BLOCKED_OUTPUT_RECORD : safe;
}

/** Filters text before a producer can stream, retain, minimize, or persist it. */
export class ProducerOutputGuard {
	#pending = "";
	#recordLength = 0;
	#droppingLabel = OVERSIZED_OUTPUT_RECORD;
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

	constructor(redact?: (text: string) => string, pendingPrefixLength?: (text: string) => number) {
		const owner = currentProducerSecretOwner();
		this.#redact = redact ?? owner?.redact;
		this.#pendingPrefixLength = pendingPrefixLength ?? owner?.pendingPrefixLength;
	}
	sanitize(text: string): string {
		try {
			const original = sanitizeText(text);
			if (isInventory(original)) return BLOCKED_OUTPUT_RECORD;
			if (original.split("\n").some(line => line.length > MAX_RECORD_CHARS)) return OVERSIZED_OUTPUT_RECORD;
			if (/^\s*[{[]/.test(text)) {
				try {
					const value = JSON.parse(text);
					const serialized = JSON.stringify(sanitizeProducerJson(value, this));
					return serialized === JSON.stringify(value) ? original : serialized;
				} catch {
					// util.inspect records are not JSON; the bounded record guard owns them.
				}
			}
			// Classify labels before an owner can rename them. Normalization must not
			// reveal a label that was missed while retaining raw literal secret bytes.
			const classified = classifyCredentialText(text);
			if (classified === BLOCKED_OUTPUT_RECORD ||
				sanitizeText(classified) !== classifyCredentialText(original)) return BLOCKED_OUTPUT_RECORD;
			const filtered = classifyCredentialText(text, this.#redact);
			if (filtered === BLOCKED_OUTPUT_RECORD) return filtered;
			const sanitized = sanitizeText(filtered);
			const normalized = this.#redact?.(sanitized) ?? sanitized;
			if (isInventory(normalized)) return BLOCKED_OUTPUT_RECORD;
			if (normalized.split("\n").some(line => line.length > MAX_RECORD_CHARS)) return OVERSIZED_OUTPUT_RECORD;
			let redacted = normalized;
			for (const family of BARE_PROVIDER_SECRET_FAMILIES) redacted = family.redact(redacted);
			return redacted.replace(EXTRA_PREFIXED_KEY, "[REDACTED]");
		} catch {
			return BLOCKED_OUTPUT_RECORD;
		}
	}

	/** Validate a separate, complete payload without reopening this producer stream. */
	sanitizeComplete(text: string): string {
		const sanitized = this.sanitize(text);
		if (sanitized === BLOCKED_OUTPUT_RECORD || sanitized === OVERSIZED_OUTPUT_RECORD) return sanitized;
		const guard = new ProducerOutputGuard(
			value => this.#redact?.(value) ?? value,
			value => this.#pendingPrefixLength?.(value) ?? 0,
		);
		return guard.push(text) + guard.finish();
	}

	#block(label = BLOCKED_OUTPUT_RECORD): string {
		this.#withholding = true;
		this.#pending = "";
		this.#recordLength = 0;
		this.#candidate = "";
		this.#dropping = false;
		return label;
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
		return filtered === BLOCKED_OUTPUT_RECORD || filtered === OVERSIZED_OUTPUT_RECORD
			? this.#block(filtered)
			: filtered;
	}

	#record(record: string, newline: string): string {
		const normalized = sanitizeText(record);
		const safe = this.sanitize(record + newline);
		if (safe === BLOCKED_OUTPUT_RECORD || safe === OVERSIZED_OUTPUT_RECORD)
			return this.#block(safe) + newline;
		// A registered literal can hold several physical records together. Classify every
		// raw line, but keep the group intact until redaction can see the complete literal.
		const lines = normalized.split("\n");
		const assignment = lines.some(line => ENV_ASSIGNMENT.test(line));
		const separator = this.#candidate.length > 0 && !normalized.trim();
		let prefix = "";
		if (this.#candidate && !this.#structured && !assignment && !separator) prefix = this.#flushCandidate();
		if (this.#withholding) return prefix;
		const structured = this.#structured || lines.some(line => structuredStart(line) >= 0);
		if (structured || assignment || separator) {
			if (this.#candidate.length + record.length + newline.length > MAX_RECORD_CHARS)
				return prefix + this.#block(OVERSIZED_OUTPUT_RECORD) + newline;
			this.#candidate += record + newline;
			for (const line of lines) {
				if (line.trim()) {
					this.#assignments = ENV_ASSIGNMENT.test(line) ? this.#assignments + 1 : 0;
					if (this.#assignments >= 3) return prefix + this.#block() + newline;
				}
				let start = 0;
				if (!this.#structured) {
					start = structuredStart(line);
					if (start < 0) continue;
					this.#structured = true;
				}
				// A logging label can precede the object. Ignore its quotes and braces
				// before tracking every delimiter util.inspect uses for string values.
				for (let index = start; index < line.length; index++) {
					const character = line[index];
					if (this.#escaped) {
						this.#escaped = false;
					} else if (this.#quote) {
						if (character === "\\") this.#escaped = true;
						else if (character === this.#quote) this.#quote = "";
					} else if (isQuote(character)) {
						this.#quote = character;
					} else if (character === "/") {
						index += regexLiteralLength(line, index, this.#depth);
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
					this.#recordLength + segmentLength + separator.length > MAX_RECORD_CHARS ||
					this.#pending.length + segmentLength + separator.length > MAX_RECORD_CHARS
				) {
					this.#pending = "";
					this.#dropping = true;
					this.#droppingLabel = OVERSIZED_OUTPUT_RECORD;
				} else {
					this.#pending += chunk.slice(offset, end) + separator;
					this.#recordLength += segmentLength;
				}
			}
			if (newline < 0) break;
			this.#recordLength = 0;
			if (this.#dropping) {
				output.push(`${this.#block(this.#droppingLabel)}\n`);
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
		const text = this.#dropping ? this.#block(this.#droppingLabel) : this.#record(this.#pending, "");
		this.#pending = "";
		this.#recordLength = 0;
		this.#dropping = false;
		this.#droppingLabel = OVERSIZED_OUTPUT_RECORD;
		if (!this.#withholding && this.#structured && this.#depth > 0) return text + this.#block();
		const output = text + (this.#withholding ? "" : this.#flushCandidate());
		if (pendingPrefix > 0) this.#withholding = true;
		return output;
	}

	reset(): void {
		this.#pending = "";
		this.#recordLength = 0;
		this.#dropping = false;
		this.#droppingLabel = OVERSIZED_OUTPUT_RECORD;
		this.#withholding = false;
		this.#candidate = "";
		this.#assignments = 0;
		this.#structured = false;
		this.#depth = 0;
		this.#quote = "";
		this.#escaped = false;
	}
}
