import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
	handoff?: { targetNode: string; claimToken: string; epoch: number };
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
async function readStable(path: string): Promise<Uint8Array> {
	const before = await stat(path);
	const first = await readFile(path);
	const afterFirst = await stat(path);
	const second = await readFile(path);
	const afterSecond = await stat(path);
	const signature = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
	if (
		signature(before) !== signature(afterFirst) ||
		signature(afterFirst) !== signature(afterSecond) ||
		!first.equals(second)
	)
		throw new Error(`Checkpoint source changed during capture: ${path}`);
	return first;
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
export async function captureNativeCheckpoint(
	sessionFile: string,
	workspacePaths: string[],
): Promise<NativeCheckpointBundle> {
	const journalPath = resolve(sessionFile);
	await assertNoSymlink(journalPath);
	await assertNotTerminalOwned(journalPath);
	if (!journalPath.endsWith(".jsonl")) throw new Error("Native session path must end with .jsonl");
	const bytes = await readStable(journalPath);
	const header = parseHeader(bytes);
	const sessionId = header.id as string;
	const artifactRoot = journalPath.slice(0, -6);
	const artifacts: Record<string, string> = {};
	try {
		for (const rel of await walkFiles(artifactRoot))
			artifacts[rel] = encode(await readStable(join(artifactRoot, ...rel.split("/"))));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const blobs: Record<string, string> = {};
	const journals = [
		Buffer.from(bytes).toString("utf8"),
		...Object.entries(artifacts)
			.filter(([name]) => name.endsWith(".jsonl"))
			.map(([, content]) => Buffer.from(content, "base64").toString("utf8")),
	];
	for (const journal of journals) {
		for (const match of journal.matchAll(/blob(?:text)?:sha256:([a-f0-9]{64})/g)) {
			const hash = match[1]!;
			if (!blobs[hash])
				blobs[hash] = encode(await readStable(join(blobsDirForSessionDir(dirname(journalPath)), hash)));
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
			const content = await readStable(full);
			const relativePath = safeRelative(relative(workspaceRoot, full).split(sep).join("/"));
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
	if (!Buffer.from(await readStable(journalPath)).equals(Buffer.from(bytes)))
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
	const newId = fork ? randomUUID() : bundle.native.sessionId;
	const journalBytes = decodeBase64(bundle.journal.bytes);
	const journalText = Buffer.from(journalBytes).toString("utf8");
	let headerStart = 0;
	let headerEnd = journalText.indexOf("\n");
	if (JSON.parse(journalText.slice(0, headerEnd < 0 ? undefined : headerEnd)).type !== "session") {
		headerStart = headerEnd + 1;
		headerEnd = journalText.indexOf("\n", headerStart);
	}
	const headerLine = JSON.stringify({ ...header, id: newId, parentSessionId: bundle.native.sessionId });
	const materializedJournal = fork
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
		if (
			!fork &&
			bundle.handoff &&
			(!bundle.handoff.targetNode ||
				!bundle.handoff.claimToken ||
				!Number.isSafeInteger(bundle.handoff.epoch) ||
				bundle.handoff.epoch < 1)
		)
			throw new Error("Invalid transferred-session claim");
		if (!fork && bundle.handoff)
			await writeFile(
				join(staging, "sessions", "checkpoint-ownership.json"),
				JSON.stringify({ version: 1, sessionId: newId, ...bundle.handoff }),
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
