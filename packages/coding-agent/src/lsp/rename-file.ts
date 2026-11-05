/**
 * `rename_file`: the move resolved, the edits each server proposes for it collected and coalesced across
 * servers, applied once per file, and the rename announced to every server.
 */

import * as fs from "node:fs";
import path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import { formatPathRelativeToCwd, resolveToCwd } from "../tools/core/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/core/tool-errors";
import {
	ensureFileOpen,
	getOrCreateClient,
	LspResponseError,
	sendNotification,
	sendRequest,
	waitForProjectLoaded,
} from "./client";
import { type LspConfig, serverHandlesFile } from "./config";
import { applyTextEdits, flattenWorkspaceTextEdits, rangesOverlap } from "./edits";
import { getLspServers, getLspServersForFile, isProjectAwareLspServer } from "./servers";
import type { ServerConfig, TextEdit, WorkspaceEdit } from "./types";
import { fileToUri, formatWorkspaceEdit, uriToFile } from "./utils";

const MAX_RENAME_PAIRS = 1000;

interface FileRenamePair {
	oldUri: string;
	newUri: string;
}

/**
 * Enumerate the {oldUri, newUri} pairs needed for an LSP willRenameFiles/didRenameFiles request.
 * For files this is a single pair. For directories this walks every regular file underneath
 * and produces a parallel pair anchored at the new directory root; null when the directory holds
 * more than {@link MAX_RENAME_PAIRS} files.
 */
async function enumerateRenamePairs(
	source: string,
	dest: string,
	directory: boolean,
): Promise<FileRenamePair[] | null> {
	if (!directory) {
		return [{ oldUri: fileToUri(source), newUri: fileToUri(dest) }];
	}
	const entries = await fs.promises.readdir(source, { recursive: true, withFileTypes: true });
	const pairs: FileRenamePair[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (pairs.length >= MAX_RENAME_PAIRS) {
			return null;
		}
		const parent = entry.parentPath ?? source;
		const absOld = path.join(parent, entry.name);
		const rel = path.relative(source, absOld);
		pairs.push({
			oldUri: fileToUri(absOld),
			newUri: fileToUri(path.join(dest, rel)),
		});
	}
	return pairs;
}

/** What a `rename_file` call moves: the resolved paths, whether the source is a directory, and its file pairs. */
interface RenameTarget {
	readonly source: string;
	readonly dest: string;
	readonly directory: boolean;
	readonly pairs: FileRenamePair[];
}

/** The rename from `file` to `newName`, or the error text that rejects it. */
export async function resolveRenameTarget(
	file: string | undefined,
	newName: string | undefined,
	cwd: string,
): Promise<RenameTarget | string> {
	if (!file || !newName) {
		return "Error: rename_file requires both `file` (source path) and `new_name` (destination path)";
	}
	const source = resolveToCwd(file, cwd);
	const dest = resolveToCwd(newName, cwd);
	if (source === dest) {
		return "Error: source and destination paths are identical";
	}
	let sourceStat: fs.Stats;
	try {
		sourceStat = await fs.promises.stat(source);
	} catch {
		return `Error: source path does not exist: ${formatPathRelativeToCwd(source, cwd)}`;
	}
	const destExists = await fs.promises.stat(dest).then(
		() => true,
		() => false,
	);
	if (destExists) {
		return `Error: destination already exists: ${formatPathRelativeToCwd(dest, cwd)}`;
	}
	const directory = sourceStat.isDirectory();
	const pairs = await enumerateRenamePairs(source, dest, directory);
	if (!pairs) {
		return `Error: directory contains more than ${MAX_RENAME_PAIRS} files; rename in smaller batches to keep LSP edits accurate`;
	}
	if (pairs.length === 0) {
		return "Error: no files to rename";
	}
	return { source, dest, directory, pairs };
}

/**
 * The configured language servers whose file types match the source, the destination or any renamed
 * file. Asking every configured server about a .md/.sql/.txt rename stacked willRenameFiles requests
 * against irrelevant language servers until the wall-clock timeout hit.
 */
export function renameServers(config: LspConfig, target: RenameTarget): Array<[string, ServerConfig]> {
	const relevantNames = new Set<string>();
	const collectRelevant = (filePath: string) => {
		for (const [name] of getLspServersForFile(config, filePath)) {
			relevantNames.add(name);
		}
	};
	collectRelevant(target.source);
	collectRelevant(target.dest);
	for (const pair of target.pairs) {
		collectRelevant(uriToFile(pair.oldUri));
		collectRelevant(uriToFile(pair.newUri));
	}
	return getLspServers(config).filter(([name]) => relevantNames.has(name));
}

/** What the servers answered a willRenameFiles request with. */
interface RenameProposals {
	/** Every server that answered, edits or not. */
	readonly respondingServers: Set<string>;
	/** Each answer that carries edits, in server order. */
	readonly perServerEdits: Array<{ serverName: string; edit: WorkspaceEdit }>;
	/** One line per server that failed with anything but MethodNotFound. */
	readonly serverNotes: string[];
}

/**
 * One server's willRenameFiles answer, asked once a project-aware server has loaded its project. The
 * first renamed file the server handles is opened first: tsserver loads no project until one of its
 * files is open, and without a project it proposes no import edits.
 */
async function askRenameServer(
	serverConfig: ServerConfig,
	lspParams: { files: FileRenamePair[] },
	cwd: string,
	signal: AbortSignal,
): Promise<WorkspaceEdit | null> {
	const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
	if (isProjectAwareLspServer(serverConfig)) {
		const handled = lspParams.files.find(pair => serverHandlesFile(serverConfig, uriToFile(pair.oldUri)));
		if (handled) await ensureFileOpen(client, uriToFile(handled.oldUri), signal);
		await waitForProjectLoaded(client, signal);
	}
	return (await sendRequest(client, "workspace/willRenameFiles", lspParams, signal)) as WorkspaceEdit | null;
}

/** Ask each server for the edits a rename implies; an abort ends the rename. */
export async function requestRenameEdits(
	servers: Array<[string, ServerConfig]>,
	lspParams: { files: FileRenamePair[] },
	cwd: string,
	signal: AbortSignal,
): Promise<RenameProposals> {
	const proposals: RenameProposals = { respondingServers: new Set(), perServerEdits: [], serverNotes: [] };
	for (const [serverName, serverConfig] of servers) {
		throwIfAborted(signal);
		try {
			const result = await askRenameServer(serverConfig, lspParams, cwd, signal);
			proposals.respondingServers.add(serverName);
			if (result && (result.changes || result.documentChanges)) {
				proposals.perServerEdits.push({ serverName, edit: result });
			}
		} catch (err) {
			if (err instanceof ToolAbortError || signal?.aborted) {
				throw err;
			}
			if (!isMethodNotFoundError(err)) {
				proposals.serverNotes.push(`  ${serverName}: ${errorMessage(err)}`);
			}
		}
	}
	return proposals;
}

/** The `apply: false` report: each server's proposed edits, and its notes. */
export function renamePreview(heading: string, proposals: RenameProposals, cwd: string): string {
	const lines = [`Rename preview: ${heading}`];
	if (proposals.perServerEdits.length === 0) {
		lines.push("  No LSP edits would be applied");
	}
	for (const { serverName, edit } of proposals.perServerEdits) {
		const edits = formatWorkspaceEdit(edit, cwd);
		if (edits.length === 0) continue;
		lines.push(`  ${serverName}:`);
		for (const e of edits) {
			lines.push(`    ${e}`);
		}
	}
	if (proposals.serverNotes.length > 0) {
		lines.push("  Server notes:", ...proposals.serverNotes);
	}
	return lines.join("\n");
}

/** The edits accepted for one file: the primary server's, plus each other server's that overlaps none. */
interface AcceptedBucket {
	primaryServer: string;
	edits: TextEdit[];
	discarded: number;
	conflictServers: Set<string>;
}

/**
 * Coalesce per-URI edits across servers before applying. Each server computed positions against the
 * pre-edit file content, so applying server A then re-reading for server B yields stale positions and
 * produces malformed imports. Group all text edits by URI, prefer the project-primary (project-aware)
 * server on overlap, and apply once per URI from a single snapshot.
 */
export function coalesceRenameEdits(
	perServerEdits: RenameProposals["perServerEdits"],
	servers: Array<[string, ServerConfig]>,
): Map<string, AcceptedBucket> {
	const serverConfigByName = new Map(servers);
	const isPrimary = (serverName: string): boolean => {
		const cfg = serverConfigByName.get(serverName);
		return cfg ? isProjectAwareLspServer(cfg) : false;
	};
	const acceptedByUri = new Map<string, AcceptedBucket>();
	for (const { serverName, edit } of perServerEdits) {
		const incomingPrimary = isPrimary(serverName);
		for (const [uri, edits] of flattenWorkspaceTextEdits(edit)) {
			const existing = acceptedByUri.get(uri);
			if (!existing) {
				acceptedByUri.set(uri, { primaryServer: serverName, edits, discarded: 0, conflictServers: new Set() });
			} else if (incomingPrimary && !isPrimary(existing.primaryServer)) {
				promoteBucket(existing, serverName, edits);
			} else {
				mergeIntoBucket(existing, serverName, edits);
			}
		}
	}
	return acceptedByUri;
}

/** Make `serverName` a bucket's primary: its edits win, and each accepted edit they overlap is discarded. */
function promoteBucket(bucket: AcceptedBucket, serverName: string, edits: TextEdit[]): void {
	const keptOld: TextEdit[] = [];
	let discardedOld = 0;
	for (const oe of bucket.edits) {
		if (edits.some(ne => rangesOverlap(ne.range, oe.range))) discardedOld++;
		else keptOld.push(oe);
	}
	if (discardedOld > 0) bucket.conflictServers.add(bucket.primaryServer);
	bucket.discarded += discardedOld;
	bucket.primaryServer = serverName;
	bucket.edits = edits.concat(keptOld);
}

/** Add `serverName`'s edits to a bucket, discarding each one that overlaps an accepted edit. */
function mergeIntoBucket(bucket: AcceptedBucket, serverName: string, edits: TextEdit[]): void {
	let discardedNew = 0;
	for (const ne of edits) {
		if (bucket.edits.some(ae => rangesOverlap(ae.range, ne.range))) {
			discardedNew++;
		} else {
			bucket.edits.push(ne);
		}
	}
	if (discardedNew > 0) {
		bucket.conflictServers.add(serverName);
		bucket.discarded += discardedNew;
	}
}

/** Apply each file's accepted edits; one summary line per file, and a note for its discarded overlaps. */
export async function applyRenameEdits(acceptedByUri: Map<string, AcceptedBucket>, cwd: string): Promise<string[]> {
	const summary: string[] = [];
	for (const [uri, bucket] of acceptedByUri) {
		const filePath = uriToFile(uri);
		await applyTextEdits(filePath, bucket.edits);
		const rel = formatPathRelativeToCwd(filePath, cwd);
		summary.push(`  ${bucket.primaryServer}: applied ${bucket.edits.length} edit(s) to ${rel}`);
		if (bucket.discarded > 0) {
			const others = Array.from(bucket.conflictServers).join(", ");
			summary.push(
				`    note: discarded ${bucket.discarded} overlapping edit(s) from ${others} (kept ${bucket.primaryServer})`,
			);
			logger.warn(
				`lsp rename_file: discarded ${bucket.discarded} overlapping edit(s) from ${others} on ${rel}; kept ${bucket.primaryServer}`,
			);
		}
	}
	return summary;
}

/**
 * Close each renamed file a server holds open and send it didRenameFiles; one note per server that
 * failed. An abort ends the rename.
 */
export async function notifyRenamed(
	servers: Array<[string, ServerConfig]>,
	lspParams: { files: FileRenamePair[] },
	cwd: string,
	signal: AbortSignal,
): Promise<string[]> {
	const notes: string[] = [];
	for (const [serverName, serverConfig] of servers) {
		try {
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			for (const { oldUri } of lspParams.files) {
				if (client.openFiles.has(oldUri)) {
					await sendNotification(client, "textDocument/didClose", { textDocument: { uri: oldUri } }, signal);
					client.openFiles.delete(oldUri);
				}
			}
			await sendNotification(client, "workspace/didRenameFiles", lspParams, signal);
		} catch (err) {
			if (err instanceof ToolAbortError || signal?.aborted) {
				throw err;
			}
			notes.push(`  ${serverName}: ${errorMessage(err)}`);
		}
	}
	return notes;
}

/**
 * True when an LSP error indicates the server doesn't implement the requested method: the JSON-RPC
 * `MethodNotFound` code, or a server that reports the absence under another code by message.
 */
function isMethodNotFoundError(err: unknown): boolean {
	if (err instanceof LspResponseError && err.code === -32601) return true;
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return msg.includes("method not found") || msg.includes("unhandled method") || msg.includes("not supported");
}
