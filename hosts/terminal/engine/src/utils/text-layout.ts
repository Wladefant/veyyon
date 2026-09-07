import { padding } from "@veyyon/utils/padding";
import { applyBackgroundToLine } from "@veyyon/utils/sgr";
import { getSegmenter, visibleWidth } from "@veyyon/utils/width";

/**
 * Return the first grapheme of a string, or an empty string if empty.
 */
export function firstGrapheme(text: string): string {
	for (const seg of getSegmenter().segment(text)) {
		return seg.segment;
	}
	return "";
}

/**
 * Return the last grapheme of a string, or an empty string if empty.
 */
export function lastGrapheme(text: string): string {
	let last = "";
	for (const seg of getSegmenter().segment(text)) {
		last = seg.segment;
	}
	return last;
}

/**
 * Drop the last code point of a string (stripping a full surrogate pair if trailing).
 */
export function dropLastCodePoint(text: string): string {
	const len = text.length;
	if (len === 0) return "";
	const cut =
		len >= 2 && (text.charCodeAt(len - 1) & 0xfc00) === 0xdc00 && (text.charCodeAt(len - 2) & 0xfc00) === 0xd800
			? 2
			: 1;
	return text.slice(0, len - cut);
}

/**
 * Pad a line to full width and optionally apply a background color function.
 */
export function applyLineBackground(line: string, width: number, bgFn?: (text: string) => string): string {
	if (bgFn) {
		return applyBackgroundToLine(line, width, bgFn);
	}
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	return line + padding(paddingNeeded);
}
