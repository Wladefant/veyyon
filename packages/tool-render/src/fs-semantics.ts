import { splitReadSelector } from "@veyyon/utils/read-selector";
import { isRecord } from "@veyyon/utils/type-guards";
import { num, str } from "./scalars";

/**
 * Allocation-free line counter for text.
 * Returns 0 for empty or non-string text.
 */
export function countLines(text: string | null | undefined): number {
	if (!text) return 0;
	let count = 1;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
		count++;
	}
	return count;
}

// ============================================================================
// Read Tool Semantics
// ============================================================================

export interface ParsedReadArgs {
	readonly rawPath: string;
	readonly path: string;
	readonly sel: string | null;
	readonly from: number | null;
	readonly to: number | null;
	readonly rangeSuffix: string;
}

export function parseReadArgs(args: unknown): ParsedReadArgs {
	if (!isRecord(args)) {
		return { rawPath: "", path: "", sel: null, from: null, to: null, rangeSuffix: "" };
	}
	const rawPath = str(args.path) ?? str(args.file_path) ?? "";
	const split = splitReadSelector(rawPath);
	const sel = str(args.sel) ?? split.sel ?? null;
	const offset = num(args.offset);
	const limit = num(args.limit);
	const from = offset !== null || limit !== null ? (offset ?? 1) : null;
	const to = from !== null && limit !== null ? from + limit - 1 : null;

	let rangeSuffix = "";
	if (args.offset !== undefined || args.limit !== undefined) {
		const startLine = args.offset !== undefined ? (num(args.offset) ?? 1) : 1;
		const endLine = args.limit === undefined ? "" : `-${startLine + (num(args.limit) ?? 0) - 1}`;
		rangeSuffix = `:${startLine}${endLine}`;
	}

	return {
		rawPath,
		path: split.path || rawPath,
		sel,
		from,
		to,
		rangeSuffix,
	};
}

export interface ParsedReadDetails {
	readonly resolvedPath: string | null;
	readonly suffixTo: string | null;
	readonly suffixFrom: string | null;
	readonly elidedSpans: number | null;
	readonly conflictCount: number | null;
	readonly truncated: boolean;
	readonly totalLines: number | null;
}

export function parseReadDetails(details: unknown): ParsedReadDetails {
	if (!isRecord(details)) {
		return {
			resolvedPath: null,
			suffixTo: null,
			suffixFrom: null,
			elidedSpans: null,
			conflictCount: null,
			truncated: false,
			totalLines: null,
		};
	}
	const suffix = isRecord(details.suffixResolution) ? details.suffixResolution : null;
	const summary = isRecord(details.summary) ? details.summary : null;
	const trunc = isRecord(details.truncation) ? details.truncation : null;

	return {
		resolvedPath: str(details.resolvedPath),
		suffixTo: suffix ? str(suffix.to) : null,
		suffixFrom: suffix ? str(suffix.from) : null,
		elidedSpans: summary ? num(summary.elidedSpans) : null,
		conflictCount: num(details.conflictCount),
		truncated: trunc !== null,
		totalLines: trunc ? num(trunc.totalLines) : null,
	};
}

// ============================================================================
// Write Tool Semantics
// ============================================================================

export interface ParsedWriteArgs {
	readonly path: string | null;
	readonly content: string | null;
	readonly isValidContent: boolean;
}

export function parseWriteArgs(args: unknown): ParsedWriteArgs {
	if (!isRecord(args)) {
		return { path: null, content: null, isValidContent: false };
	}
	const path = str(args.path) ?? str(args.file_path);
	const isString = typeof args.content === "string";
	const content = isString ? (args.content as string) : null;
	return {
		path,
		content,
		isValidContent: isString,
	};
}

export interface WriteDiagnosticsSummary {
	readonly server: string | null;
	readonly messages: readonly string[];
	readonly summary: string | null;
	readonly errored: boolean;
}

export interface ParsedWriteDetails {
	readonly madeExecutable: boolean;
	readonly diagnostics: WriteDiagnosticsSummary | null;
}

export function parseWriteDetails(details: unknown): ParsedWriteDetails {
	if (!isRecord(details)) {
		return { madeExecutable: false, diagnostics: null };
	}
	const madeExecutable = details.madeExecutable === true;
	let diagnostics: WriteDiagnosticsSummary | null = null;

	if (isRecord(details.diagnostics)) {
		const d = details.diagnostics;
		const messages: string[] = [];
		if (Array.isArray(d.messages)) {
			for (const m of d.messages) {
				if (typeof m === "string") messages.push(m);
			}
		}
		const summary = str(d.summary);
		if (messages.length > 0 || summary !== null) {
			diagnostics = {
				server: str(d.server),
				messages,
				summary,
				errored: d.errored === true,
			};
		}
	}

	return {
		madeExecutable,
		diagnostics,
	};
}
