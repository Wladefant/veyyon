/**
 * Where each provider's object sits in `models.json`, found without parsing the document.
 *
 * The generator writes the catalog as `JSON.stringify(models, null, "\t")`. In that layout a
 * provider's key is the only line that starts with exactly one tab and a quote, and the provider's
 * closing brace is the first line after it that is exactly one tab and `}`: every line inside a
 * provider starts with at least two tabs, and a JSON string holds no raw newline. One `indexOf` per
 * provider finds the brace, so a reader parses the provider it needs rather than the whole catalog.
 */

/** The byte range `[start, end)` of one provider's object, braces included. */
export interface CatalogSpan {
	readonly start: number;
	readonly end: number;
}

const NEWLINE = 0x0a;
const TAB = 0x09;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const SPACE = 0x20;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const PROVIDER_CLOSE_LINE = "\n\t}";

/**
 * The span of every provider's object in `bytes`, in document order, or `null` when `bytes` is not
 * in the generator's layout. A `null` index sends every read through a parse of the whole document.
 */
export function indexCatalogSpans(bytes: Buffer): Map<string, CatalogSpan> | null {
	const spans = new Map<string, CatalogSpan>();
	if (bytes[0] !== OPEN_BRACE) return null;
	if (bytes[1] === CLOSE_BRACE) return isDocumentEnd(bytes, 2) ? spans : null;
	// `line` is the offset of the newline that opens a provider's key line.
	let line = 1;
	for (;;) {
		if (bytes[line] !== NEWLINE || bytes[line + 1] !== TAB || bytes[line + 2] !== QUOTE) return null;
		const keyStart = line + 2;
		const keyEnd = closingQuote(bytes, keyStart + 1);
		if (keyEnd < 0) return null;
		if (bytes[keyEnd + 1] !== COLON || bytes[keyEnd + 2] !== SPACE || bytes[keyEnd + 3] !== OPEN_BRACE) return null;
		const key = JSON.parse(bytes.toString("utf8", keyStart, keyEnd + 1)) as string;
		const start = keyEnd + 3;
		let end: number;
		if (bytes[start + 1] === CLOSE_BRACE) {
			end = start + 2;
		} else if (bytes[start + 1] === NEWLINE) {
			const close = bytes.indexOf(PROVIDER_CLOSE_LINE, start);
			if (close < 0) return null;
			end = close + PROVIDER_CLOSE_LINE.length;
		} else {
			return null;
		}
		// The whole-document parse keeps the last of two equal keys; a span index would keep the first.
		if (spans.has(key)) return null;
		spans.set(key, { start, end });
		if (bytes[end] === COMMA) {
			line = end + 1;
			continue;
		}
		return bytes[end] === NEWLINE && bytes[end + 1] === CLOSE_BRACE && isDocumentEnd(bytes, end + 2) ? spans : null;
	}
}

/** The offset of the quote that closes the JSON string whose body starts at `from`, or -1. */
function closingQuote(bytes: Buffer, from: number): number {
	for (let i = from; i < bytes.length; i++) {
		const byte = bytes[i];
		if (byte === BACKSLASH) i++;
		else if (byte === QUOTE) return i;
		else if (byte === NEWLINE) return -1;
	}
	return -1;
}

/** Whether nothing but one optional trailing newline follows `offset`. */
function isDocumentEnd(bytes: Buffer, offset: number): boolean {
	return offset === bytes.length || (offset + 1 === bytes.length && bytes[offset] === NEWLINE);
}
