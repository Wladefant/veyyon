/**
 * Fuzzy matching utilities for the edit tool.
 *
 * Provides both character-level and line-level fuzzy matching with progressive
 * fallback strategies for finding text in files.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import { lazy } from "@veyyon/utils/abortable";
import { type } from "arktype";
import type { FileDiagnosticsResult, WritethroughCallback, WritethroughDeferredHandle } from "../../lsp";
import type { ToolSession } from "../../tools";
import { routeWriteThroughBridge } from "../../tools/core/acp-bridge";
import { invalidateFsScanAfterWrite } from "../../tools/core/fs-cache-invalidation";
import { outputMeta } from "../../tools/core/output-meta";
import { enforcePlanModeWrite, resolvePlanPath } from "../../tools/core/plan-mode-guard";
import type { LspBatchRequest } from "../../tools/core/render-utils";
import type { EditToolDetails } from "../details";
import { generateDiffString, replaceText } from "../diff";
import { EditMatchError, findMatch, formatOccurrenceError } from "../match";
import { detectLineEnding, normalizeToLF, restoreLineEndings } from "../normalize";
import { readEditFileTextWithBom, serializeEditFileText } from "../read-file";
import { pruneOversizedEditSnapshots } from "../snapshot-details";

export const replaceEditEntrySchema = lazy(() =>
	type({
		old_text: "string",
		new_text: "string",
		"all?": "boolean",
	}),
);

export const replaceEditSchema = lazy(() =>
	type({
		path: "string",
		old_string: "string",
		new_string: "string",
		"replace_all?": "boolean",
	}),
);

export type ReplaceEditEntry = typeof replaceEditEntrySchema.value.infer;
export type ReplaceParams = typeof replaceEditSchema.value.infer;

export interface ReplaceBatchParams {
	path: string;
	edits: Array<
		| ReplaceEditEntry
		| {
				old_string: string;
				new_string: string;
				replace_all?: boolean;
		  }
	>;
}

export type ReplaceExecutionEntry =
	| ReplaceEditEntry
	| {
			old_string: string;
			new_string: string;
			replace_all?: boolean;
	  }
	| {
			old_text?: string;
			new_text?: string;
			all?: boolean;
			old_string?: string;
			new_string?: string;
			replace_all?: boolean;
	  };

export interface ExecuteReplaceSingleOptions {
	session: ToolSession;
	path: string;
	params: ReplaceExecutionEntry;
	signal?: AbortSignal;
	batchRequest?: LspBatchRequest;
	allowFuzzy: boolean;
	fuzzyThreshold: number;
	writethrough: WritethroughCallback;
	beginDeferredDiagnosticsForPath: (path: string) => WritethroughDeferredHandle;
}

export async function executeReplaceSingle(
	options: ExecuteReplaceSingleOptions,
): Promise<AgentToolResult<EditToolDetails, ReplaceExecutionEntry>> {
	const {
		session,
		path,
		params,
		signal,
		batchRequest,
		allowFuzzy,
		fuzzyThreshold,
		writethrough,
		beginDeferredDiagnosticsForPath,
	} = options;
	const old_text = params.old_string ?? params.old_text;
	const new_text = params.new_string ?? params.new_text;
	const all = params.replace_all ?? params.all;

	enforcePlanModeWrite(session, path);

	if (old_text === undefined || old_text.length === 0) {
		throw new Error(
			params.old_string !== undefined ? "old_string must not be empty." : "old_text must not be empty.",
		);
	}
	if (new_text === undefined) {
		throw new Error(params.new_string !== undefined ? "new_string must be provided." : "new_text must be provided.");
	}

	const absolutePath = resolvePlanPath(session, path);
	// Recover the BOM from raw bytes: the text reader drops a leading UTF-8 BOM,
	// so a plain read + stripBom would rewrite the file without it (regression:
	// "should preserve UTF-8 BOM after edit").
	const { bom, content } = await readEditFileTextWithBom(absolutePath, path);
	const originalEnding = detectLineEnding(content);
	const normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(old_text);
	const normalizedNewText = normalizeToLF(new_text);

	const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
		fuzzy: allowFuzzy,
		all: all ?? false,
		threshold: fuzzyThreshold,
	});

	if (result.count === 0) {
		const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
			allowFuzzy,
			threshold: fuzzyThreshold,
		});

		if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
			throw new Error(formatOccurrenceError(path, matchOutcome));
		}

		throw new EditMatchError(path, normalizedOldText, matchOutcome.closest, {
			allowFuzzy,
			threshold: fuzzyThreshold,
			fuzzyMatches: matchOutcome.fuzzyMatches,
		});
	}

	if (normalizedContent === result.content) {
		throw new Error(`Edits to ${path} resulted in no changes being made.`);
	}

	const finalContent = await serializeEditFileText(
		absolutePath,
		path,
		bom + restoreLineEndings(result.content, originalEnding),
	);

	// Route through ACP bridge when available; skips internal artifacts.
	let diagnostics: FileDiagnosticsResult | undefined;
	if (await routeWriteThroughBridge(session, path, absolutePath, finalContent, signal)) {
		// bridge handled the write; diagnostics not available via writethrough
	} else {
		diagnostics = await writethrough(absolutePath, finalContent, signal, Bun.file(absolutePath), batchRequest, dst =>
			dst === absolutePath ? beginDeferredDiagnosticsForPath(absolutePath) : undefined,
		);
		invalidateFsScanAfterWrite(absolutePath);
	}

	const diffResult = generateDiffString(normalizedContent, result.content, undefined, { path });
	const resultText =
		result.count > 1
			? `Successfully replaced ${result.count} occurrences in ${path}.`
			: `Successfully replaced text in ${path}.`;

	const meta = outputMeta()
		.diagnostics(diagnostics?.summary ?? "", diagnostics?.messages ?? [])
		.get();

	return {
		content: [{ type: "text", text: resultText }],
		details: pruneOversizedEditSnapshots({
			diff: diffResult.diff,
			path: absolutePath,
			firstChangedLine: diffResult.firstChangedLine,
			diagnostics,
			meta,
			oldText: content,
			newText: finalContent,
		}),
	};
}
