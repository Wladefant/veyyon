/**
 * The diagnostics a language server or linter publishes for one file: waiting for a fresh publish,
 * dropping a TypeScript server's orphan-project noise, and formatting the result.
 */

import { errorMessage } from "@veyyon/utils";
import { formatPathRelativeToCwd } from "../tools/core/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/core/tool-errors";
import { getOrCreateClient, LspResponseError, onDiagnosticsPublish, sendRequest, waitForProjectLoaded } from "./client";
import { getLinterClient } from "./clients";
import { hasRootMarkerAncestor } from "./config";
import { isProjectAwareLspServer } from "./servers";
import type { Diagnostic, LspClient, PublishedDiagnostics, ServerConfig } from "./types";
import { fileToUri, formatDiagnostic, formatDiagnosticsSummary, uniqueSortedDiagnostics } from "./utils";

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
export const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
export const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
/** Delay before re-sending a pull the server cancelled or saw outdated. */
const PULL_RETRY_DELAY_MS = 100;
const DIAGNOSTICS_SETTLE_MS = 250;
/**
 * JSON-RPC error codes a server answers `textDocument/diagnostic` with when the pull should be sent again:
 * ServerCancelled (-32802) and ContentModified (-32801).
 */
const RETRIGGER_PULL_ERROR_CODES: ReadonlySet<number> = new Set([-32802, -32801]);

export function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

const ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES: Record<number, true> = {
	1375: true,
	1378: true,
	2307: true,
	2580: true,
	2591: true,
	2792: true,
	2867: true,
};

function diagnosticCodeNumber(diagnostic: Diagnostic): number | null {
	if (typeof diagnostic.code === "number") return diagnostic.code;
	if (typeof diagnostic.code === "string" && /^\d+$/.test(diagnostic.code)) return Number(diagnostic.code);
	return null;
}
function isTypeScriptProjectDiagnostic(serverName: string, diagnostic: Diagnostic): boolean {
	if (diagnostic.source !== "typescript" && !serverName.toLowerCase().includes("typescript")) {
		return false;
	}
	const code = diagnosticCodeNumber(diagnostic);
	return code !== null && ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES[code] === true;
}

function filterOrphanProjectDiagnostics(
	absolutePath: string,
	serverName: string,
	serverConfig: ServerConfig,
	diagnostics: Diagnostic[],
): Diagnostic[] {
	if (!serverConfig.rootMarkers.length || hasRootMarkerAncestor(absolutePath, serverConfig.rootMarkers)) {
		return diagnostics;
	}
	return diagnostics.filter(diagnostic => !isTypeScriptProjectDiagnostic(serverName, diagnostic));
}

/** The answer to `textDocument/diagnostic`; `unchanged` only answers a pull that sent a `previousResultId`. */
interface DocumentDiagnosticReport {
	kind: "full" | "unchanged";
	items?: Diagnostic[];
}

/**
 * Resolves at `deadline` (epoch ms), when `wake` settles, or when `signal` aborts, whichever is first, and
 * leaves no timer or abort listener behind. Never rejects: the caller re-checks its state and the signal.
 */
async function sleepUntil(deadline: number, signal: AbortSignal | undefined, wake?: Promise<void>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
	const onAbort = () => resolve();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await (wake ? Promise.race([promise, wake]) : promise);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Pulls the diagnostics of one open document (`textDocument/diagnostic`, LSP 3.17). The server answers
 * after every change sent before the request, so the result needs no settle window. A server that only
 * pulls (tsgo) never publishes, and waiting for a publish from it lasted the whole timeout and reported no
 * diagnostics. Resolves undefined when no full report arrives before `deadline`; never rejects.
 */
async function pullDocumentDiagnostics(
	client: LspClient,
	uri: string,
	deadline: number,
	signal: AbortSignal | undefined,
): Promise<Diagnostic[] | undefined> {
	while (Date.now() < deadline) {
		try {
			const report = (await sendRequest(
				client,
				"textDocument/diagnostic",
				{ textDocument: { uri } },
				signal,
				Math.max(1, deadline - Date.now()),
			)) as DocumentDiagnosticReport | null;
			return report?.kind === "full" && Array.isArray(report.items) ? report.items : undefined;
		} catch (error) {
			if (signal?.aborted || !(error instanceof LspResponseError) || !RETRIGGER_PULL_ERROR_CODES.has(error.code)) {
				return undefined;
			}
		}
		await sleepUntil(Date.now() + PULL_RETRY_DELAY_MS, signal);
	}
	return undefined;
}

interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	minVersion?: number;
	expectedDocumentVersion?: number;
	/**
	 * Quiescence window (ms). typescript-language-server never echoes the document
	 * version (issue #983) and emits diagnostics from several sources at different
	 * times, so there is no single "complete, version-matched" publish to gate on.
	 * When the server does not exact-version-match, accept the latest publish only
	 * after no newer one has arrived for this long, letting an in-flight pre-edit
	 * publish be superseded by the fresh one.
	 */
	settleMs?: number;
}

export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, settleMs = DIAGNOSTICS_SETTLE_MS } = options;
	const start = Date.now();
	let settledRef: PublishedDiagnostics | undefined;
	let settledAt = 0;
	// A server that offers pulls answers with every change applied, so the first full report is accepted
	// as soon as it lands; a version-matched publish that lands first is accepted the same way. Every
	// state the loop reads changes on a publish or a finished pull, and the settle window and the budget
	// end at known times, so each pass sleeps until exactly one of those happens.
	let wake = Promise.withResolvers<void>();
	const stopListening = onDiagnosticsPublish(client, () => wake.resolve());
	const pull: { items?: Diagnostic[] } = {};
	if (client.serverCapabilities?.diagnosticProvider) {
		void pullDocumentDiagnostics(client, uri, start + timeoutMs, signal).then(items => {
			pull.items = items;
			wake.resolve();
		});
	}
	try {
		for (;;) {
			throwIfAborted(signal);
			if (pull.items) {
				client.diagnostics.set(uri, { diagnostics: pull.items, version: expectedDocumentVersion ?? null });
				return pull.items;
			}
			const now = Date.now();
			if (now - start >= timeoutMs) break;
			let wakeAt = start + timeoutMs;
			const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
			const published = client.diagnostics.get(uri);
			if (published && versionOk) {
				// Server honored our exact document version → authoritative, accept now.
				if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
					return published.diagnostics;
				}
				// Unversioned/mismatched publish: wait for the stream to go quiet so an
				// in-flight publish for the pre-edit content is superseded by the fresh one.
				if (published !== settledRef) {
					settledRef = published;
					settledAt = now;
				} else if (now - settledAt >= settleMs) {
					return published.diagnostics;
				}
				wakeAt = Math.min(wakeAt, settledAt + settleMs);
			}
			await sleepUntil(wakeAt, signal, wake.promise);
			wake = Promise.withResolvers<void>();
		}
	} finally {
		stopListening();
	}
	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	if (!versionOk) {
		return [];
	}
	return client.diagnostics.get(uri)?.diagnostics ?? [];
}

/** Result from getDiagnosticsForFile */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
	/** Whether the file was formatted */
	formatter?: FileFormatResult;
}

export type ServerVersionMap = Map<string, number>;

interface GetDiagnosticsForFileOptions {
	signal?: AbortSignal;
	minVersions?: ServerVersionMap;
	expectedDocumentVersions?: ServerVersionMap;
	/** Per-server wait budget (ms). Defaults to {@link SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * Capture current diagnostic versions for all LSP servers.
 * Call this BEFORE syncing content to detect stale diagnostics later.
 */
export async function captureDiagnosticVersions(
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	initTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<ServerVersionMap> {
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			if (serverConfig.createClient) return;
			const client = await getOrCreateClient(serverConfig, cwd, initTimeoutMs, signal);
			versions.set(serverName, client.diagnosticsVersion);
		}),
	);
	return versions;
}

export async function captureOpenFileVersions(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	signal?: AbortSignal,
): Promise<ServerVersionMap> {
	const uri = fileToUri(absolutePath);
	const versions = new Map<string, number>();
	await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			const version = client.openFiles.get(uri)?.version;
			if (version !== undefined) {
				versions.set(serverName, version);
			}
		}),
	);
	return versions;
}

/**
 * Get diagnostics for a file using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to query diagnostics for
 * @param minVersions - Minimum diagnostic versions per server (to detect stale results)
 * @returns Diagnostic results or undefined if no servers
 */
export async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
	const { signal, minVersions, expectedDocumentVersions, timeoutMs } = options;
	if (servers.length === 0) {
		return undefined;
	}

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	// Wait for diagnostics from all servers in parallel
	const results = await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				const diagnostics = await linterClient.lint(absolutePath);
				return { serverName, serverConfig, diagnostics };
			}

			// Default: use LSP
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);
			if (isProjectAwareLspServer(serverConfig)) {
				await waitForProjectLoaded(client, signal);
				throwIfAborted(signal);
			}
			// Content already synced + didSave sent, wait for fresh diagnostics
			const minVersion = minVersions?.get(serverName);
			const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
			const diagnostics = await waitForDiagnostics(client, uri, {
				timeoutMs: timeoutMs ?? SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
				signal,
				minVersion,
				expectedDocumentVersion,
			});
			return { serverName, serverConfig, diagnostics };
		}),
	);

	// A server that failed is named with its error, so a file no checker could read is not reported clean.
	const failures: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const result = results[i]!;
		if (result.status === "fulfilled") {
			serverNames.push(result.value.serverName);
			allDiagnostics.push(
				...filterOrphanProjectDiagnostics(
					absolutePath,
					result.value.serverName,
					result.value.serverConfig,
					result.value.diagnostics,
				),
			);
		} else if (!signal?.aborted && !(result.reason instanceof ToolAbortError)) {
			failures.push(`${servers[i]![0]} did not check the file: ${errorMessage(result.reason)}`);
		}
	}

	if (serverNames.length === 0 && failures.length === 0) {
		return undefined;
	}

	if (allDiagnostics.length === 0) {
		return {
			server: serverNames.length > 0 ? serverNames.join(", ") : undefined,
			messages: failures,
			summary:
				failures.length === 0
					? "OK"
					: serverNames.length === 0
						? "not checked"
						: `no issues from ${serverNames.join(", ")}`,
			errored: false,
		};
	}

	const uniqueDiagnostics = uniqueSortedDiagnostics(allDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	const limited = limitDiagnosticMessages(formatted);
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const hasErrors = uniqueDiagnostics.some(d => d.severity === 1);

	return {
		server: serverNames.join(", "),
		messages: limited.concat(failures),
		summary,
		errored: hasErrors,
	};
}

export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
}
