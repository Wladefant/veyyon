import { isCheckpointNodeLabel, type SessionHandoffIdentity } from "@veyyon/session/checkpoint-ownership";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { blobsDirForSessionDir } from "../../../../kernel/src/session/blob-store";
import { assertNotTerminalOwned } from "../../../../kernel/src/session/terminal-ownership";
import { type CheckpointFile, filterCheckpointFiles } from "./cloud-checkpoints";

export interface NativeCheckpointBundle {
	version: 1;
	native: { sessionId: string; header: Record<string, unknown>; sessionFile: string; forkedFrom?: string };
	journal: { path: string; bytes: string };
	artifacts: Record<string, string>;
	blobs: Record<string, string>;
	workspace: { dirty: string[]; files: { path: string; bytes: string }[] };
	pins: { bun: string; commit: string; runtime: string };
	handoff?: { targetNode: string; claimToken: string; transferId: string; epoch: number };
}

const forbidden =
	/(^|\/)(?:\.env(?:\..*)?|\.git|\.agents|\.cache|\.next|\.turbo|\.venv|venv|node_modules|auth|browser|cache|locks?)(\/|$)/i;
const deniedNames = /(?:^|\/)(?:.*\.lock|.*\.sqlite(?:-wal|-shm)?)$/i;
function safeRelative(value: string): string {
	const normalized = value.replaceAll("\\", "/");
	if (
		!normalized ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:/.test(normalized) ||
		normalized.split("/").some(part => !part || part === "." || part === "..") ||
		forbidden.test(normalized) ||
		deniedNames.test(normalized)
	)
		throw new Error(`Unsafe checkpoint path: ${value}`);
	return normalized;
}
function decodeBase64(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "base64"));
}
function encode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
async function assertNoSymlink(path: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in checkpoints: ${path}`);
}
async function walkFiles(root: string, base = root): Promise<string[]> {
	// The initial traversal root is user-derived, too: a linked sibling of the
	// session journal must not be treated as approved capture data.
	await assertNoSymlink(root);
	const names = await readdir(root);
	const found: string[] = [];
	for (const name of names) {
		const path = join(root, name);
		await assertNoSymlink(path);
		const info = await lstat(path);
		if (info.isDirectory()) found.push(...(await walkFiles(path, base)));
		else if (info.isFile()) found.push(safeRelative(relative(base, path).split(sep).join("/")));
	}
	return found;
}
// Cloud ciphertext is limited to 64 MiB. The original bytes are base64
// encoded without compression, so more than 48 MiB of raw file bytes could
// never fit, even before JSON and the AES-GCM envelope are included.
const MAX_CAPTURE_RAW_BYTES = 48 * 1024 * 1024;
const CAPTURE_READ_CHUNK_BYTES = 64 * 1024;

/** Offline forks are not Cloudflare 64 MiB ciphertext objects. Preserve their
 * existing byte behavior while cloud export/handoff keeps its hard ceiling. */
export function nativeCaptureByteBudget(mode: "cloud" | "local"): number {
	return mode === "cloud" ? MAX_CAPTURE_RAW_BYTES : Number.MAX_SAFE_INTEGER;
}

function captureFileSignature(value: Stats): string {
	return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

/**
 * Recheck the complete ancestry and canonical containment of a capture leaf
 * against its explicitly approved root. This rejects stable symlink/junction
 * substitution, including the root itself, but cannot atomically defeat an
 * adversary swapping a directory away and back between these path checks.
 */
type CheckpointSourceScope = "workspace" | "artifact" | "blob";
async function assertCheckpointSourceConfined(
	path: string,
	approvedRoot: string,
	opened: Stats,
	scope: CheckpointSourceScope,
): Promise<void> {
	const relativePath = relative(approvedRoot, path);
	const escaped = (value: string): boolean =>
		!value || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
	const deny = (): never => {
		throw new Error(`Checkpoint ${scope} source changed or escaped approved root: ${path}`);
	};
	if (escaped(relativePath)) deny();
	const rootInfo = await lstat(approvedRoot);
	if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) deny();
	const components = relativePath.split(sep);
	let ancestor = approvedRoot;
	for (const [index, component] of components.entries()) {
		ancestor = join(ancestor, component);
		const info = await lstat(ancestor);
		if (info.isSymbolicLink() || (index === components.length - 1 ? !info.isFile() : !info.isDirectory())) deny();
	}
	const canonicalRoot = await realpath(approvedRoot);
	const canonicalPath = await realpath(path);
	if (escaped(relative(canonicalRoot, canonicalPath))) deny();
	const current = await lstat(path);
	if (!current.isFile() || captureFileSignature(current) !== captureFileSignature(opened)) deny();
}

/**
 * Descriptor-bound capture body. Taking `before` separately allows the same
 * production read loop to be tested with an actual file grown immediately
 * after its initial fstat, without test-only hooks or copied algorithms.
 */
export async function readOpenedCheckpointFile(
	path: string,
	maxBytes: number,
	preliminary: Stats,
	handle: FileHandle,
	before: Stats,
	approvedRoot?: string,
	scope: CheckpointSourceScope = "workspace",
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid checkpoint capture byte budget");
	// A symlink replacing an approved regular file between lstat and open must
	// not inherit its approval, even on platforms without O_NOFOLLOW.
	if (!preliminary.isFile() || !before.isFile() || captureFileSignature(preliminary) !== captureFileSignature(before))
		throw new Error(`Checkpoint source changed during capture: ${path}`);
	const exceedsBudget = (): never => {
		throw new Error(`Checkpoint capture exceeds raw-byte budget: ${path}`);
	};
	if (before.size > maxBytes) exceedsBudget();
	// An approved ancestor may have been replaced while the caller assembled the
	// workspace list. Refuse any redirected source before reading its bytes.
	if (approvedRoot) await assertCheckpointSourceConfined(path, approvedRoot, before, scope);

	const chunks: Buffer[] = [];
	let length = 0;
	while (true) {
		const amount = Math.min(CAPTURE_READ_CHUNK_BYTES, maxBytes - length + 1);
		const chunk = Buffer.allocUnsafe(amount);
		const { bytesRead } = await handle.read(chunk, 0, amount, length);
		if (bytesRead === 0) break;
		if (bytesRead > maxBytes - length) exceedsBudget();
		chunks.push(chunk.subarray(0, bytesRead));
		length += bytesRead;
	}
	const first = Buffer.concat(chunks, length);
	const afterFirst = await handle.stat();

	// Verify content again using one fixed-size scratch buffer, not a second
	// full allocation. A growing source is refused within the first loop.
	const probe = Buffer.allocUnsafe(CAPTURE_READ_CHUNK_BYTES);
	let verified = 0;
	while (true) {
		const amount = Math.min(probe.length, first.byteLength - verified + 1);
		const { bytesRead } = await handle.read(probe, 0, amount, verified);
		if (bytesRead === 0) break;
		if (
			bytesRead > first.byteLength - verified ||
			!probe.subarray(0, bytesRead).equals(first.subarray(verified, verified + bytesRead))
		)
			throw new Error(`Checkpoint source changed during capture: ${path}`);
		verified += bytesRead;
	}
	const afterSecond = await handle.stat();
	// lstat, not stat: following a late leaf symlink would compare the linked
	// target's inode with our descriptor and incorrectly authorize the swap.
	const afterPath = await lstat(path);
	if (
		verified !== first.byteLength ||
		!afterPath.isFile() ||
		captureFileSignature(before) !== captureFileSignature(afterFirst) ||
		captureFileSignature(afterFirst) !== captureFileSignature(afterSecond) ||
		captureFileSignature(afterSecond) !== captureFileSignature(afterPath)
	)
		throw new Error(`Checkpoint source changed during capture: ${path}`);
	if (approvedRoot) await assertCheckpointSourceConfined(path, approvedRoot, afterSecond, scope);
	return first;
}

async function readStable(
	path: string,
	maxBytes: number,
	approvedRoot?: string,
	scope: CheckpointSourceScope = "workspace",
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid checkpoint capture byte budget");
	const preliminary = await lstat(path);
	// Reject FIFO/device inputs before open: their read can wait forever for a writer.
	if (!preliminary.isFile()) throw new Error(`Checkpoint capture requires a regular file: ${path}`);
	// POSIX rejects a link at open itself; Windows uses the pre-open/fstat and
	// final no-follow identity comparisons above for the same leaf boundary.
	const flags = process.platform === "win32" ? "r" : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
	const handle = await open(path, flags);
	try {
		const before = await handle.stat();
		return await readOpenedCheckpointFile(path, maxBytes, preliminary, handle, before, approvedRoot, scope);
	} finally {
		await handle.close();
	}
}

function parseHeader(bytes: Uint8Array): Record<string, unknown> {
	const lines = Buffer.from(bytes).toString("utf8").split(/\r?\n/, 2);
	for (const line of lines) {
		if (!line) continue;
		const value: unknown = JSON.parse(line);
		if (
			value &&
			typeof value === "object" &&
			"type" in value &&
			value.type === "session" &&
			"id" in value &&
			typeof value.id === "string" &&
			"cwd" in value &&
			typeof value.cwd === "string"
		)
			return value as Record<string, unknown>;
	}
	throw new Error("Native session header must contain type, id, and cwd");
}
export async function persistNativeHandoffIdentity(
	sessionFile: string,
	identity: SessionHandoffIdentity,
): Promise<void> {
	if (
		identity.version !== 1 ||
		!isCheckpointNodeLabel(identity.targetNode) ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(identity.transferId) ||
		!Number.isSafeInteger(identity.transferEpoch) ||
		identity.transferEpoch < 1
	)
		throw new Error("Invalid native session handoff identity");
	const journalPath = resolve(sessionFile);
	await assertNoSymlink(journalPath);
	await assertNotTerminalOwned(journalPath);
	const original = await readStable(journalPath, MAX_CAPTURE_RAW_BYTES);
	const header = parseHeader(original);
	const prior = header.checkpointHandoff;
	if (prior && typeof prior === "object" && "targetNode" in prior && prior.targetNode !== identity.targetNode)
		throw new Error("A handed-off native session cannot be transferred to a different node");
	const text = Buffer.from(original).toString("utf8");
	let offset = 0;
	let headerStart = -1;
	let headerEnd = -1;
	for (let index = 0; index < 2; index++) {
		const newline = text.indexOf("\n", offset);
		const lineEnd = newline < 0 ? text.length : newline;
		const contentEnd = lineEnd > offset && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
		let entry: unknown;
		try {
			entry = JSON.parse(text.slice(offset, contentEnd));
		} catch {
			entry = undefined;
		}
		if (entry && typeof entry === "object" && "type" in entry && entry.type === "session") {
			headerStart = offset;
			headerEnd = contentEnd;
			break;
		}
		if (newline < 0) break;
		offset = newline + 1;
	}
	if (headerStart < 0 || headerEnd < 0) throw new Error("Native session header could not be located");
	const next = Buffer.from(
		text.slice(0, headerStart) +
			JSON.stringify({ ...header, checkpointHandoff: identity }) +
			text.slice(headerEnd),
	);
	if (next.equals(Buffer.from(original))) return;
	if (!Buffer.from(await readStable(journalPath, original.byteLength)).equals(Buffer.from(original)))
		throw new Error("Native session changed while persisting its handoff identity");
	const temporary = `${journalPath}.${randomUUID()}.tmp`;
	await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
	try {
		await rename(temporary, journalPath);
	} catch (error) {
		await rm(temporary, { force: true });
		throw new Error("Could not persist the native session handoff identity", { cause: error });
	}
}
export async function captureNativeCheckpoint(
	sessionFile: string,
	workspacePaths: string[],
	mode: "cloud" | "local" = "cloud",
): Promise<NativeCheckpointBundle> {
	const journalPath = resolve(sessionFile);
	await assertNoSymlink(journalPath);
	await assertNotTerminalOwned(journalPath);
	if (!journalPath.endsWith(".jsonl")) throw new Error("Native session path must end with .jsonl");
	let remainingBytes = nativeCaptureByteBudget(mode);
	const readIncluded = async (
		filePath: string,
		approvedRoot?: string,
		scope: CheckpointSourceScope = "workspace",
	): Promise<Uint8Array> => {
		const content = await readStable(filePath, remainingBytes, approvedRoot, scope);
		remainingBytes -= content.byteLength;
		return content;
	};
	const bytes = await readIncluded(journalPath);
	const header = parseHeader(bytes);
	const sessionId = header.id as string;
	const artifactRoot = journalPath.slice(0, -6);
	const artifacts: Record<string, string> = {};
	// An absent sibling artifact directory is optional. Once it exists, however,
	// every failed traversal/read must abort capture: a child removed after
	// enumeration is NOT equivalent to a missing optional root.
	let artifactRootExists = false;
	try {
		await lstat(artifactRoot);
		artifactRootExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (artifactRootExists) {
		for (const rel of await walkFiles(artifactRoot))
			artifacts[rel] = encode(await readIncluded(join(artifactRoot, ...rel.split("/")), artifactRoot, "artifact"));
	}
	const blobs: Record<string, string> = {};
	const journals = [
		Buffer.from(bytes).toString("utf8"),
		...Object.entries(artifacts)
			.filter(([name]) => name.endsWith(".jsonl"))
			.map(([, content]) => Buffer.from(content, "base64").toString("utf8")),
	];
	const blobRoot = blobsDirForSessionDir(dirname(journalPath));
	for (const journal of journals) {
		for (const match of journal.matchAll(/blob(?:text)?:sha256:([a-f0-9]{64})/g)) {
			const hash = match[1]!;
			if (!blobs[hash])
				blobs[hash] = encode(await readIncluded(join(blobRoot, hash), blobRoot, "blob"));
		}
	}
	const workspaceRoot = await realpath(header.cwd as string);
	const files: CheckpointFile[] = [];
	const dirty: string[] = [];
	for (const input of workspacePaths) {
		if (input.replaceAll("\\", "/").split("/").includes("..")) throw new Error("Unsafe workspace path");
		const path = resolve(input);
		const lexicalRelative = relative(workspaceRoot, path);
		if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative))
			throw new Error(`Workspace path escapes its root: ${input}`);
		let ancestor = workspaceRoot;
		const components = lexicalRelative ? lexicalRelative.split(sep) : [];
		for (const component of components) {
			ancestor = join(ancestor, component);
			if ((await lstat(ancestor)).isSymbolicLink())
				throw new Error(`Symbolic links are not allowed in workspace paths: ${ancestor}`);
		}
		const canonicalPath = await realpath(path);
		const canonicalRelative = relative(workspaceRoot, canonicalPath);
		if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative))
			throw new Error(`Workspace path escapes its root: ${input}`);
		const info = await lstat(path);
		if (info.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in workspace capture: ${path}`);
		const data = info.isDirectory() ? await walkFiles(path) : [safeRelative(basename(path))];
		for (const rel of data) {
			const full = info.isDirectory() ? join(path, ...rel.split("/")) : path;
			// Validate the complete workspace-relative path before reading any bytes:
			// a safe basename inside node_modules/auth must not be opened first.
			const relativePath = safeRelative(relative(workspaceRoot, full).split(sep).join("/"));
			// The shared cloud filter also excludes names not covered by the
			// local path grammar (e.g. shared-auth, credentials, __pycache__).
			// Apply it to path-only metadata BEFORE reading potential secrets.
			if (filterCheckpointFiles([{ path: relativePath, content: new Uint8Array(0) }]).length !== 1)
				throw new Error("Workspace paths include excluded checkpoint files");
			const content = await readIncluded(full, workspaceRoot);
			dirty.push(relativePath);
			files.push({ path: relativePath, content });
		}
	}
	const approved = filterCheckpointFiles(files).map(file => ({
		path: safeRelative(file.path),
		bytes: encode(file.content),
	}));
	if (approved.length !== files.length) throw new Error("Workspace paths include excluded checkpoint files");
	const git = (args: string[]) => {
		try {
			return execFileSync("git", args, {
				cwd: header.cwd as string,
				encoding: "utf8",
				timeout: 3000,
				windowsHide: true,
			}).trim();
		} catch {
			return "unknown";
		}
	};
	if (!Buffer.from(await readStable(journalPath, bytes.byteLength)).equals(Buffer.from(bytes)))
		throw new Error("Journal changed during checkpoint capture");
	return {
		version: 1,
		native: { sessionId, header, sessionFile: "session.jsonl" },
		journal: { path: "session.jsonl", bytes: encode(bytes) },
		artifacts,
		blobs,
		workspace: { dirty, files: approved },
		pins: { bun: Bun.version, commit: git(["rev-parse", "HEAD"]), runtime: process.version },
	};
}

async function materialize(bundle: NativeCheckpointBundle, directory: string, fork: boolean): Promise<string> {
	const out = resolve(directory);
	try {
		await lstat(out);
		throw new Error(`Restore destination already exists: ${out}`);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	const header = parseHeader(decodeBase64(bundle.journal.bytes));
	if (header.id !== bundle.native.sessionId) throw new Error("Checkpoint journal and native header disagree");
	const handoff = bundle.handoff;
	if (handoff) {
		if (
			!isCheckpointNodeLabel(handoff.targetNode) ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(handoff.transferId) ||
			typeof handoff.claimToken !== "string" ||
			handoff.claimToken.length < 16 ||
			handoff.claimToken.length > 128 ||
			!Number.isSafeInteger(handoff.epoch) ||
			handoff.epoch < 1
		)
			throw new Error("Invalid transferred-session claim");
		if (
			header.checkpointHandoff &&
			typeof header.checkpointHandoff === "object" &&
			"targetNode" in header.checkpointHandoff &&
			header.checkpointHandoff.targetNode !== handoff.targetNode
		)
			throw new Error("Checkpoint handoff target does not match its native journal");
	} else if (!fork && header.checkpointHandoff !== undefined) {
		throw new Error("Transferred checkpoint is missing its authority claim");
	}
	const identity: SessionHandoffIdentity | undefined = handoff
		? { version: 1, targetNode: handoff.targetNode, transferId: handoff.transferId, transferEpoch: handoff.epoch }
		: undefined;
	const newId = fork ? randomUUID() : bundle.native.sessionId;
	const journalBytes = decodeBase64(bundle.journal.bytes);
	const journalText = Buffer.from(journalBytes).toString("utf8");
	let headerStart = 0;
	let headerEnd = journalText.indexOf("\n");
	if (JSON.parse(journalText.slice(0, headerEnd < 0 ? undefined : headerEnd)).type !== "session") {
		headerStart = headerEnd + 1;
		headerEnd = journalText.indexOf("\n", headerStart);
	}
	const outputHeader: Record<string, unknown> = {
		...header,
		id: newId,
		parentSessionId: bundle.native.sessionId,
	};
	if (fork) delete outputHeader.checkpointHandoff;
	else if (identity) outputHeader.checkpointHandoff = identity;
	const headerLine = JSON.stringify(outputHeader);
	const rewriteJournal = fork || identity !== undefined;
	const materializedJournal = rewriteJournal
		? Buffer.from(
				journalText.slice(0, headerStart) + headerLine + (headerEnd < 0 ? "" : journalText.slice(headerEnd)),
			)
		: journalBytes;
	const staging = `${out}.checkpoint-${randomUUID()}`;
	await mkdir(staging, { recursive: false });
	try {
		await mkdir(join(staging, "sessions"));
		await mkdir(join(staging, "blobs"));
		await writeFile(join(staging, "sessions", "session.jsonl"), materializedJournal, { flag: "wx", mode: 0o600 });
		for (const [hash, content] of Object.entries(bundle.blobs)) {
			if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid blob hash");
			const bytes = decodeBase64(content);
			if (new Bun.SHA256().update(bytes).digest("hex") !== hash) throw new Error("Blob integrity failure");
			await writeFile(join(staging, "blobs", hash), bytes, { flag: "wx", mode: 0o600 });
		}
		for (const [name, content] of Object.entries(bundle.artifacts)) {
			const rel = safeRelative(name);
			const target = join(staging, "sessions", "session", ...rel.split("/"));
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, decodeBase64(content), { flag: "wx", mode: 0o600 });
		}
		for (const file of bundle.workspace.files) {
			const rel = safeRelative(file.path);
			const target = join(staging, "workspace", ...rel.split("/"));
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, decodeBase64(file.bytes), { flag: "wx", mode: 0o600 });
		}
		if (!fork && handoff)
			await writeFile(
				join(staging, "sessions", "checkpoint-ownership.json"),
				JSON.stringify({
					version: 1,
					sessionId: newId,
					targetNode: handoff.targetNode,
					transferId: handoff.transferId,
					transferEpoch: handoff.epoch,
					epoch: handoff.epoch,
					claimToken: handoff.claimToken,
				}),
				{ flag: "wx", mode: 0o600 },
			);
		await writeFile(
			join(staging, "recovery.json"),
			JSON.stringify({
				version: 1,
				sessionId: newId,
				sourceSessionId: bundle.native.sessionId,
				pins: bundle.pins,
				originalCwd: header.cwd,
				restoredJobs: false,
				checkpointTransfer: !fork && Boolean(bundle.handoff),
			}),
			{ flag: "wx", mode: 0o600 },
		);
		await rename(staging, out);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
	return newId;
}
export async function restoreNativeCheckpoint(
	bundle: NativeCheckpointBundle,
	outputDirectory: string,
): Promise<string> {
	return materialize(bundle, outputDirectory, false);
}
export async function forkNativeCheckpoint(
	bundle: NativeCheckpointBundle,
): Promise<{ sessionId: string; sourceSessionId: string; directory: string }> {
	const directory = resolve(process.env.TMPDIR ?? process.env.TEMP ?? "/tmp", `veyyon-fork-${randomUUID()}`);
	const sessionId = await materialize(bundle, directory, true);
	return { sessionId, sourceSessionId: bundle.native.sessionId, directory };
}
