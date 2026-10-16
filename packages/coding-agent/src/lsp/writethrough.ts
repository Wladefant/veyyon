/**
 * The commit path of the edit and write tools: the file is written atomically, synced to and formatted
 * by its language servers, and its diagnostics are fetched inline or delivered late.
 */

import { atomicWriteFilePreservingMode, errorMessage, lazy, logger, settleWithin, untilAborted } from "@veyyon/utils";
import { isTimeoutError } from "@veyyon/utils/abortable";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import type { BunFile } from "bun";
import { formatPathRelativeToCwd } from "../tools/core/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/core/tool-errors";
import {
	FileChangeType,
	getOrCreateClient,
	notifySaved,
	notifyWorkspaceWatchedFiles,
	sendRequest,
	syncContent,
} from "./client";
import { getLinterClient } from "./clients";
import { getServersForFile } from "./config";
import {
	captureDiagnosticVersions,
	captureOpenFileVersions,
	type FileDiagnosticsResult,
	FileFormatResult,
	getDiagnosticsForFile,
	limitDiagnosticMessages,
	type ServerVersionMap,
} from "./diagnostics";
import { applyTextEditsToString } from "./edits";
import { resolveFormatOptions } from "./format-options";
import { getConfig, splitServers } from "./servers";
import type { ServerConfig, TextEdit } from "./types";
import { fileToUri, summarizeDiagnosticMessages } from "./utils";

/**
 * Sync in-memory file content to all applicable LSP servers.
 * Sends didOpen (if new) or didChange (if already open).
 *
 * @param absolutePath - Absolute path to the file
 * @param content - The new file content
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to sync to
 */
async function syncFileContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);
			await syncContent(client, absolutePath, content, signal);
		}),
	);
}

/**
 * Notify all LSP servers that a file was saved.
 * Assumes content was already synced via syncFileContent.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to notify
 */
async function notifyFileSaved(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	await Promise.allSettled(
		servers.map(async ([_serverName, serverConfig]) => {
			throwIfAborted(signal);
			if (serverConfig.createClient) {
				return;
			}
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			await notifySaved(client, absolutePath, signal);
		}),
	);
}

/**
 * How long the edit/write writethrough blocks inline waiting for fresh
 * diagnostics before handing slow servers off to the deferred late-injection
 * channel. Keeps the common fast-server case inline while letting an edit
 * return promptly when a server (e.g. a large-monorepo tsserver) is slow to
 * publish fresh diagnostics.
 */
const INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 500;
/**
 * Inner per-server diagnostics wait budget for the background/deferred fetch.
 * Longer than the inline cap (and the old 3s default) so a slow server still
 * delivers late instead of giving up before it ever publishes.
 */
const DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS = 12_000;

/**
 * Format content using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path (for URI)
 * @param content - Content to format
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to try formatting with
 * @returns Formatted content, or original if no formatter available
 */
async function formatContent(
	absolutePath: string,
	content: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<string> {
	if (servers.length === 0) {
		return content;
	}

	const uri = fileToUri(absolutePath);

	for (const [serverName, serverConfig] of servers) {
		try {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				return await linterClient.format(absolutePath, content);
			}

			// Default: use LSP
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);

			const caps = client.serverCapabilities;
			if (!caps?.documentFormattingProvider) {
				continue;
			}

			// Request formatting (content already synced)
			const edits = (await sendRequest(
				client,
				"textDocument/formatting",
				{
					textDocument: { uri },
					options: resolveFormatOptions(absolutePath, content),
				},
				signal,
			)) as TextEdit[] | null;

			if (!edits || edits.length === 0) {
				return content;
			}

			// Apply edits in-memory and return
			return applyTextEditsToString(content, edits);
		} catch (error) {
			// Cancellation and timeouts must propagate, never be swallowed as a
			// formatter failure that silently falls through to unformatted content.
			if (signal?.aborted || error instanceof ToolAbortError || isTimeoutError(error)) throw error;
			// Formatting is best-effort: a server crash or protocol error must not
			// fail the edit (the content already saved), but it must be visible —
			// a silent no-op leaves the operator unable to see why format-on-write
			// stopped applying (Law: no silent fallbacks).
			logger.warn("LSP formatting failed; wrote unformatted content", {
				server: serverName,
				path: formatPathRelativeToCwd(absolutePath, cwd),
				error: errorMessage(error),
			});
		}
	}

	return content;
}

/** Options for creating the LSP writethrough callback */
export interface WritethroughOptions {
	/** Whether to format the file using LSP after writing */
	enableFormat?: boolean;
	/** Whether to get LSP diagnostics after writing */
	enableDiagnostics?: boolean;
	/** Called when diagnostics arrive after the main timeout. */
	onDeferredDiagnostics?: (diagnostics: FileDiagnosticsResult) => void;
	/** Signal to cancel a pending deferred diagnostics fetch. */
	deferredSignal?: AbortSignal;
	/** Transform diagnostics before surfacing them after a successful fetch. */
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
}

/** Internal resolved form of {@link WritethroughOptions} that the writethrough machinery operates on. */
type ResolvedWritethroughOptions = {
	enableFormat: boolean;
	enableDiagnostics: boolean;
	transformDiagnostics?: (absPath: string, result: FileDiagnosticsResult) => FileDiagnosticsResult;
};

/** Per-file deferred LSP diagnostics wiring for {@link WritethroughCallback}. */
export type WritethroughDeferredHandle = {
	onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
	signal: AbortSignal;
	finalize: (diagnostics: FileDiagnosticsResult | undefined) => void;
};

/** Callback type for the LSP writethrough */
export type WritethroughCallback = (
	dst: string,
	content: string,
	signal?: AbortSignal,
	file?: BunFile,
	batch?: LspWritethroughBatchRequest,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
) => Promise<FileDiagnosticsResult | undefined>;

/**
 * Persist `content` to `dst` crash-atomically, carrying the existing file's
 * permission bits forward. Every edit/write commit routes through here.
 *
 * A raw `Bun.write` truncates the target and then streams the new bytes in; if
 * the process dies between those steps (SIGINT, OOM-kill, full disk, power loss)
 * the user's source file is left truncated or empty. {@link atomicWriteFile}
 * writes a sibling temp and renames it over the target, so a crash leaves either
 * the whole old file or the whole new one — never a partial one. It also resolves
 * symlinks (the link survives instead of being replaced by a regular file).
 *
 * Two overrides of the atomic-write defaults are load-bearing here:
 *  - MODE: the rename swaps in a fresh inode, so without preservation the
 *    replacement would take the temp file's `0o600` default and silently strip a
 *    script's `+x` or a file's group/other read bits.
 *    {@link atomicWriteFilePreservingMode} carries the current file's mode
 *    forward (a brand-new file gets `0o644`).
 *  - FSYNC OFF: this is the interactive edit hot path. The rename alone already
 *    defeats the truncation-on-crash class; forcing an fsync + directory fsync on
 *    every edit would add a disk round-trip per write purely for power-loss
 *    durability, which the previous `Bun.write` never provided either. Keeping it
 *    off preserves the prior latency while adding crash-atomicity.
 */
async function commitFileContentAtomic(dst: string, content: string, signal?: AbortSignal): Promise<void> {
	// The abort check belongs HERE, immediately before the rename, rather than at
	// the top of each caller. A tool that was interrupted while computing its
	// content used to commit anyway: the operator saw "aborted" and believed the
	// file was untouched while it had in fact been replaced. Reporting a
	// cancellation that did not cancel is worse than either outcome on its own,
	// because it is the state nobody goes back to check.
	//
	// The write is atomic, so failing here leaves the original file exactly as it
	// was. There is still a window of a few microseconds between this check and
	// the rename; a signal that arrives inside it commits, which is correct.
	// Atomicity is the guarantee, not instantaneous cancellation.
	throwIfAborted(signal);
	try {
		await atomicWriteFilePreservingMode(dst, content, { fsync: false });
	} catch (error) {
		// The temp-path rewrite that used to live here now belongs to
		// `atomicWriteFile` itself, so EVERY caller gets a message naming the file
		// it asked to write rather than a hidden staging path. All this adds is the
		// "which operation failed" prefix; the original travels as `cause`.
		throw new Error(`Failed to write ${dst}: ${errorMessage(error)}`, { cause: error });
	}
}

/** No-op writethrough callback */
export async function writethroughNoop(
	dst: string,
	content: string,
	signal?: AbortSignal,
	_file?: BunFile,
	_batch?: LspWritethroughBatchRequest,
	_getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	await commitFileContentAtomic(dst, content, signal);
	return undefined;
}

interface PendingWritethrough {
	dst: string;
	content: string;
	file?: BunFile;
	changeType: FileChangeType;
}

interface LspWritethroughBatchRequest {
	id: string;
	flush: boolean;
}

interface LspWritethroughBatchState {
	entries: Map<string, PendingWritethrough>;
	options: ResolvedWritethroughOptions;
}

const writethroughBatches = new Map<string, LspWritethroughBatchState>();

function getOrCreateWritethroughBatch(id: string, options: ResolvedWritethroughOptions): LspWritethroughBatchState {
	const existing = writethroughBatches.get(id);
	if (existing) {
		existing.options.enableFormat ||= options.enableFormat;
		existing.options.enableDiagnostics ||= options.enableDiagnostics;
		existing.options.transformDiagnostics ??= options.transformDiagnostics;
		return existing;
	}
	const batch: LspWritethroughBatchState = {
		entries: new Map<string, PendingWritethrough>(),
		options: { ...options },
	};
	writethroughBatches.set(id, batch);
	return batch;
}

export async function flushLspWritethroughBatch(
	id: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<FileDiagnosticsResult | undefined> {
	const state = writethroughBatches.get(id);
	if (!state) {
		return undefined;
	}
	writethroughBatches.delete(id);
	return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal);
}

function mergeDiagnostics(
	results: Array<FileDiagnosticsResult | undefined>,
	options: ResolvedWritethroughOptions,
): FileDiagnosticsResult | undefined {
	const messages: string[] = [];
	const servers = new Set<string>();
	let hasResults = false;
	let hasFormatter = false;
	let formatted = false;

	for (const result of results) {
		if (!result) continue;
		hasResults = true;
		if (result.server) {
			for (const server of result.server.split(",")) {
				const trimmed = server.trim();
				if (trimmed) {
					servers.add(trimmed);
				}
			}
		}
		if (result.messages.length > 0) {
			for (let mi = 0; mi < result.messages.length; mi++) messages.push(result.messages[mi]!);
		}
		if (result.formatter !== undefined) {
			hasFormatter = true;
			if (result.formatter === FileFormatResult.FORMATTED) {
				formatted = true;
			}
		}
	}

	if (!hasResults && !hasFormatter) {
		return undefined;
	}

	let summary = options.enableDiagnostics ? "no issues" : "OK";
	let errored = false;
	let limitedMessages = messages;
	if (messages.length > 0) {
		const summaryInfo = summarizeDiagnosticMessages(messages);
		summary = summaryInfo.summary;
		errored = summaryInfo.errored;
		limitedMessages = limitDiagnosticMessages(messages);
	}
	const formatter = hasFormatter ? (formatted ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED) : undefined;

	return {
		server: servers.size > 0 ? Array.from(servers).join(", ") : undefined,
		messages: limitedMessages,
		summary,
		errored,
		formatter,
	};
}

async function scheduleDeferredDiagnosticsFetch(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	signal: AbortSignal;
	callback: (diagnostics: FileDiagnosticsResult) => void;
}): Promise<void> {
	const deferredTimeout = scopedTimeoutSignal(25_000, args.signal);
	try {
		const diagnostics = await getDiagnosticsForFile(args.dst, args.cwd, args.servers, {
			signal: deferredTimeout.signal,
			minVersions: args.minVersions,
			expectedDocumentVersions: args.expectedDocumentVersions,
			timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
		});
		if (args.signal.aborted || diagnostics === undefined) return;
		args.callback(diagnostics);
	} catch {
		// Cancelled or LSP gave up; silently discard.
	} finally {
		deferredTimeout.cancel();
	}
}

/**
 * Fetch post-write diagnostics without making the edit/write block on a slow
 * language server.
 *
 * Blocks inline only briefly ({@link INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS}) for a
 * fresh result. Freshness is enforced by the pre-edit `minVersions` baseline:
 * exact document-version matches return immediately, and unversioned/mismatched
 * publishes must settle with no newer publish before inline acceptance. If
 * nothing fresh arrives in the inline window and a deferred
 * channel is available, the in-flight fetch is handed off to deliver late via
 * `onDeferredDiagnostics`, and this returns `undefined` so the tool result
 * lands immediately. Without a deferred channel (direct/CI callers) it blocks
 * for the standard budget so the result is still returned inline.
 */
async function fetchDiagnosticsWithDeferral(args: {
	dst: string;
	cwd: string;
	servers: Array<[string, ServerConfig]>;
	minVersions: ServerVersionMap | undefined;
	expectedDocumentVersions: ServerVersionMap | undefined;
	transformDiagnostics?: ResolvedWritethroughOptions["transformDiagnostics"];
	deferred?: { onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void; signal: AbortSignal };
	signal?: AbortSignal;
}): Promise<FileDiagnosticsResult | undefined> {
	const { dst, cwd, servers, minVersions, expectedDocumentVersions, transformDiagnostics, deferred, signal } = args;
	const apply = (d: FileDiagnosticsResult | undefined) =>
		d && transformDiagnostics ? transformDiagnostics(dst, d) : d;

	if (!deferred) {
		// No late-injection channel: block for the standard budget and return inline.
		return apply(
			await getDiagnosticsForFile(dst, cwd, servers, {
				signal,
				minVersions,
				expectedDocumentVersions,
			}),
		);
	}

	// One background fetch with a generous inner budget; await it only briefly inline.
	const fetchPromise = getDiagnosticsForFile(dst, cwd, servers, {
		signal: deferred.signal,
		minVersions,
		expectedDocumentVersions,
		timeoutMs: DEFERRED_DIAGNOSTICS_WAIT_TIMEOUT_MS,
	});
	const INLINE_TIMEOUT = Symbol("inline-diagnostics-timeout");
	const raced = await settleWithin(fetchPromise, INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS, INLINE_TIMEOUT);
	if (raced !== INLINE_TIMEOUT) {
		return apply(raced);
	}
	// Slow server: deliver late via the deferred channel; nothing inline. The
	// deferred sink (edit tool) applies its own dedup, so pass the raw result.
	// Nothing awaits this, so a failure here used to mean the deferred diagnostics simply never arrived: the
	// edit reported no problems and the user could not tell that the fetch had failed rather than come back
	// clean. Reported so a server that keeps failing this late fetch is visible.
	void fetchPromise
		.then(diagnostics => {
			if (diagnostics && !deferred.signal.aborted) deferred.onDeferredDiagnostics(diagnostics);
		})
		.catch((error: unknown) => {
			logger.warn("deferred LSP diagnostics fetch failed; none were delivered", { error: errorMessage(error) });
		});
	return undefined;
}

async function runLspWritethrough(
	dst: string,
	content: string,
	cwd: string,
	options: ResolvedWritethroughOptions,
	changeType: FileChangeType,
	signal?: AbortSignal,
	_file?: BunFile,
	deferred?: {
		onDeferredDiagnostics: (diagnostics: FileDiagnosticsResult) => void;
		signal: AbortSignal;
	},
): Promise<FileDiagnosticsResult | undefined> {
	const { enableFormat, enableDiagnostics } = options;

	let finalContent = content;
	const writeContent = (value: string) => commitFileContentAtomic(dst, value, signal);
	const commitWrite = lazy(() => writeContent(finalContent));
	let writeNotified = false;
	const notifyWriteCommitted = async (notifySignal: AbortSignal | undefined = signal) => {
		if (writeNotified) return;
		writeNotified = true;
		try {
			await notifyWorkspaceWatchedFiles(cwd, [{ filePath: dst, type: changeType }], notifySignal);
		} catch (error) {
			if (notifySignal?.aborted && !signal?.aborted) {
				// The operation budget died mid-notify while the caller is still
				// live: allow the post-write retry below to re-announce with the
				// caller's signal (didChangeWatchedFiles is idempotent).
				writeNotified = false;
				return;
			}
			throw error;
		}
	};
	if (!enableFormat && !enableDiagnostics) {
		await commitWrite.value;
		await notifyWriteCommitted();
		return undefined;
	}

	const config = getConfig(cwd);
	const servers = getServersForFile(config, dst);

	if (servers.length === 0) {
		await commitWrite.value;
		await notifyWriteCommitted();
		return undefined;
	}
	const { lspServers, customLinterServers } = splitServers(servers);
	const useCustomFormatter = enableFormat && customLinterServers.length > 0;

	// Capture diagnostic versions BEFORE syncing to detect stale diagnostics
	// Bound client creation by the writethrough budget: a hung/broken server
	// must not add its full init wait (30s default) to every edit.
	const minVersions = enableDiagnostics ? await captureDiagnosticVersions(cwd, servers, 5_000, signal) : undefined;
	let expectedDocumentVersions: ServerVersionMap | undefined;

	let formatter: FileFormatResult | undefined;
	let diagnostics: FileDiagnosticsResult | undefined;
	let timedOut = false;
	let synced = false;
	let operationSignal: AbortSignal | undefined;
	const operationTimeout = scopedTimeoutSignal(5_000, signal);
	try {
		const opSignal = operationTimeout.signal;
		operationSignal = opSignal;
		opSignal.addEventListener(
			"abort",
			() => {
				if (isTimeoutError(opSignal.reason)) timedOut = true;
			},
			{ once: true },
		);
		await untilAborted(operationSignal, async () => {
			if (useCustomFormatter) {
				// Custom linters (e.g. Biome CLI) require on-disk input.
				await writeContent(content);
				finalContent = await formatContent(dst, content, cwd, customLinterServers, operationSignal);
				formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				await writeContent(finalContent);
				await notifyWriteCommitted(operationSignal);
				await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
			} else {
				// 1. Sync original content to LSP servers
				await syncFileContent(dst, content, cwd, lspServers, operationSignal);

				// 2. Format in-memory via LSP
				if (enableFormat) {
					finalContent = await formatContent(dst, content, cwd, lspServers, operationSignal);
					formatter = finalContent !== content ? FileFormatResult.FORMATTED : FileFormatResult.UNCHANGED;
				}

				// 3. If formatted, sync formatted content to LSP servers
				if (finalContent !== content) {
					await syncFileContent(dst, finalContent, cwd, lspServers, operationSignal);
				}

				// 4. Write to disk
				await commitWrite.value;
				await notifyWriteCommitted(operationSignal);
			}

			if (enableDiagnostics) {
				expectedDocumentVersions = await captureOpenFileVersions(dst, cwd, lspServers, operationSignal);
			}

			// 5. Notify saved to LSP servers
			await notifyFileSaved(dst, cwd, lspServers, operationSignal);
		});
		synced = true;
	} catch {
		if (timedOut) {
			formatter = undefined;
			diagnostics = undefined;
			// Schedule background diagnostic fetch if caller wants deferred results
			if (deferred && !deferred.signal.aborted && enableDiagnostics) {
				void scheduleDeferredDiagnosticsFetch({
					dst,
					cwd,
					servers,
					minVersions,
					expectedDocumentVersions,
					signal: deferred.signal,
					callback: deferred.onDeferredDiagnostics,
				});
			}
		}
		await commitWrite.value;
		// The write above committed even though the operation budget elapsed:
		// announce it on the caller's signal — the dead `operationSignal` would
		// abort the notify before it ever reaches the server.
		await notifyWriteCommitted();
	} finally {
		operationTimeout.cancel();
	}

	if (synced && enableDiagnostics) {
		diagnostics = await fetchDiagnosticsWithDeferral({
			dst,
			cwd,
			servers,
			minVersions,
			expectedDocumentVersions,
			transformDiagnostics: options.transformDiagnostics,
			deferred,
			signal,
		});
	}

	if (formatter !== undefined) {
		diagnostics ??= {
			server: servers.map(([name]) => name).join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
		diagnostics.formatter = formatter;
	}

	return diagnostics;
}

async function flushWritethroughBatch(
	batch: PendingWritethrough[],
	cwd: string,
	options: ResolvedWritethroughOptions,
	signal?: AbortSignal,
	getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
): Promise<FileDiagnosticsResult | undefined> {
	if (batch.length === 0) {
		return undefined;
	}
	const results: Array<FileDiagnosticsResult | undefined> = [];
	for (const entry of batch) {
		const bundle = getDeferred?.(entry.dst);
		const deferredInner =
			bundle &&
			({
				onDeferredDiagnostics: bundle.onDeferredDiagnostics,
				signal: bundle.signal,
			} as const);
		const diag = await runLspWritethrough(
			entry.dst,
			entry.content,
			cwd,
			options,
			entry.changeType,
			signal,
			entry.file,
			deferredInner,
		);
		bundle?.finalize(diag);
		results.push(diag);
	}
	return mergeDiagnostics(results, options);
}

/** Create a writethrough callback for LSP aware write operations */
export function createLspWritethrough(cwd: string, options?: WritethroughOptions): WritethroughCallback {
	const resolvedOptions: ResolvedWritethroughOptions = {
		enableFormat: options?.enableFormat ?? false,
		enableDiagnostics: options?.enableDiagnostics ?? false,
		transformDiagnostics: options?.transformDiagnostics,
	};
	return async (
		dst: string,
		content: string,
		signal?: AbortSignal,
		file?: BunFile,
		batch?: LspWritethroughBatchRequest,
		getDeferred?: (dst: string) => WritethroughDeferredHandle | undefined,
	) => {
		const changeType = (await Bun.file(dst).exists()) ? FileChangeType.Changed : FileChangeType.Created;
		if (!batch) {
			const bundle = getDeferred?.(dst);
			const deferredInner =
				bundle &&
				({
					onDeferredDiagnostics: bundle.onDeferredDiagnostics,
					signal: bundle.signal,
				} as const);
			const diagnostics = await runLspWritethrough(
				dst,
				content,
				cwd,
				resolvedOptions,
				changeType,
				signal,
				file,
				deferredInner,
			);
			bundle?.finalize(diagnostics);
			return diagnostics;
		}

		const state = getOrCreateWritethroughBatch(batch.id, resolvedOptions);
		state.entries.set(dst, { dst, content, file, changeType });

		if (!batch.flush) {
			await writethroughNoop(dst, content, signal, file);
			return undefined;
		}

		writethroughBatches.delete(batch.id);
		return flushWritethroughBatch(Array.from(state.entries.values()), cwd, state.options, signal, getDeferred);
	};
}
