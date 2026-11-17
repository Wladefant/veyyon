/**
 * Crash-safe file writes.
 *
 * A plain `writeFile` (or `Bun.write`) truncates the target and then streams the
 * new bytes in. If the process dies between those two steps (a self-update that
 * replaces the binary, a `SIGINT`, a full disk, a power loss) the file is left
 * truncated or empty. For a config file that holds every profile and setting,
 * that is silent data loss.
 *
 * {@link atomicWriteFile} (and its blocking twin {@link atomicWriteFileSync})
 * avoid it the standard way: write the new bytes to a unique temp file in the
 * same directory, flush them to disk, then `rename` the temp over the target.
 * `rename` within one filesystem is atomic, so a reader or a crash sees either
 * the whole old file or the whole new file, never a partial one.
 *
 * This is the single home for atomic writes. Do not hand-roll temp-file +
 * rename at a call site; import one of these instead.
 *
 * @example
 * ```ts
 * import { atomicWriteFile } from "@veyyon/utils";
 *
 * await atomicWriteFile(configPath, YAML.stringify(config));
 * ```
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { WindowsAtomicOutcome } from "@veyyon/natives";
import { isEnoent, isFsError, nonRegularKind } from "./fs-error";
import { createWindowsStage, type WindowsStage } from "./windows-file-replace";

export interface AtomicWriteOptions {
	/**
	 * Permission bits for the created file. Defaults to `0o600` (owner
	 * read/write only) because config files routinely hold tokens. On POSIX the
	 * replacement takes the temp's mode. Windows replacements preserve the
	 * destination's DACL and security attributes.
	 */
	mode?: number;
	/**
	 * Flush the file (and its directory entry) to physical storage before
	 * returning. Defaults to `true`. `rename` already prevents a *truncated*
	 * file on a crash; the flush additionally protects the *contents* against
	 * power loss. Set to `false` only for high-churn caches where durability
	 * does not matter and the extra `fsync` cost does.
	 */
	fsync?: boolean;
	/**
	 * Retry transient Windows access/sharing denials up to 2s. Async-only
	 * (`atomicWriteFile` / `atomicWriteFileWith`). Exhaustion fails the write;
	 * it never falls back to a replacement that discards destination security.
	 */
	retryRename?: boolean;
}

export type AtomicWriteSyncOptions = Omit<AtomicWriteOptions, "retryRename">;

// Monotonic per-process counter gives every in-flight writer a distinct name.
// The temp is then reserved with O_EXCL, so wraparound or debris from a killed
// process cannot make a later writer truncate a file it does not own.
let tempCounter = 0;

function nextTempPath(dir: string, targetBasename: string): string {
	tempCounter = (tempCounter + 1) >>> 0;
	return path.join(dir, `.${targetBasename}.${process.pid}.${tempCounter}.tmp`);
}

function removeTempSync(tmpPath: string): void {
	fs.rmSync(tmpPath, { force: true, recursive: true });
}

// Temps an async write has reserved and not yet finished with. A process that exits
// mid-write (SIGTERM, SIGINT, SIGHUP, a fatal error, `process.exit`) would leave each one beside
// its target for good: its name holds a dead pid, so no later writer reuses or removes it. The
// exit listener removes them; SIGKILL and power loss still leave one. A name joins the set before
// its exclusive open is issued, since the exit can land while the open is on the thread pool and
// file already exists; a name with this pid in it is this process's or a dead one's. Keep a
// temp tracked until its rename (including the Windows backup-and-restore replace) finishes.
const pendingTemps = new Set<string>();
const pendingWindowsStages = new Set<WindowsStage>();
let exitListenerInstalled = false;

function trackPendingTemp(tmpPath: string): void {
	if (!exitListenerInstalled) {
		exitListenerInstalled = true;
		process.on("exit", removePendingTemps);
	}
	pendingTemps.add(tmpPath);
}

function removePendingTemps(): void {
	for (const tmpPath of pendingTemps) {
		try {
			removeTempSync(tmpPath);
		} catch {}
	}
	pendingTemps.clear();
	for (const stage of pendingWindowsStages) {
		try {
			stage.native.cleanupSync();
		} catch {}
	}
	pendingWindowsStages.clear();
}

async function reserveTempFile(
	dir: string,
	targetBasename: string,
	mode: number,
	target: string,
): Promise<{ handle: fsp.FileHandle; tmpPath: string; stage?: WindowsStage }> {
	if (process.platform === "win32") {
		for (;;) {
			const stageDir = nextTempPath(dir, targetBasename);
			try {
				const stage = createWindowsStage(stageDir);
				trackPendingWindowsStage(stage);
				const handle = await fsp.open(stage.path, "r+");
				await handle.chmod(mode);
				return { handle, tmpPath: stage.path, stage };
			} catch (error) {
				if (isFsError(error) && ["EEXIST", "WIN32_183", "WIN32_80"].includes(error.code ?? "")) continue;
				throw withTargetInMessage(error, target, stageDir);
			}
		}
	}
	for (;;) {
		const tmpPath = nextTempPath(dir, targetBasename);
		trackPendingTemp(tmpPath);
		try {
			return { handle: await fsp.open(tmpPath, "wx", mode), tmpPath };
		} catch (error) {
			pendingTemps.delete(tmpPath);
			if (isFsError(error) && error.code === "EEXIST") continue;
			throw withTargetInMessage(error, target, tmpPath);
		}
	}
}

function reserveTempFileSync(
	dir: string,
	targetBasename: string,
	mode: number,
	target: string,
): { fd: number; tmpPath: string; stage?: WindowsStage } {
	if (process.platform === "win32") {
		for (;;) {
			const stageDir = nextTempPath(dir, targetBasename);
			try {
				const stage = createWindowsStage(stageDir);
				trackPendingWindowsStage(stage);
				const fd = fs.openSync(stage.path, "r+");
				fs.fchmodSync(fd, mode);
				return { fd, tmpPath: stage.path, stage };
			} catch (error) {
				if (isFsError(error) && ["EEXIST", "WIN32_183", "WIN32_80"].includes(error.code ?? "")) continue;
				throw withTargetInMessage(error, target, stageDir);
			}
		}
	}
	for (;;) {
		const tmpPath = nextTempPath(dir, targetBasename);
		try {
			return { fd: fs.openSync(tmpPath, "wx", mode), tmpPath };
		} catch (error) {
			if (isFsError(error) && error.code === "EEXIST") continue;
			throw withTargetInMessage(error, target, tmpPath);
		}
	}
}

function trackPendingWindowsStage(stage: WindowsStage): void {
	if (!exitListenerInstalled) {
		exitListenerInstalled = true;
		process.on("exit", removePendingTemps);
	}
	pendingWindowsStages.add(stage);
}


function isRetryableWindowsRenameError(error: unknown): boolean {
	if (process.platform !== "win32" || !isFsError(error)) return false;
	const outcome = error as WindowsOutcomeError;
	return outcome.publicationState === "unpublished" &&
		(error.code === "EACCES" || error.code === "EBUSY" ||
			outcome.rawErrorCode === 5 || outcome.rawErrorCode === 32 || outcome.rawErrorCode === 33);
}

// Follow every basename symlink ourselves instead of using realpath. realpath
// cannot return the resolved prefix of a dangling chain; falling back to a
// single readlink hop would then rename over the next link and destroy it.
async function resolveWriteTarget(filePath: string): Promise<{ target: string; viaSymlink: boolean }> {
	let target = filePath;
	let viaSymlink = false;
	const seen = new Set<string>();

	for (;;) {
		let stats: fs.Stats;
		try {
			stats = await fsp.lstat(target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { target, viaSymlink };
		}
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, target);
			return { target, viaSymlink };
		}

		viaSymlink = true;
		recordSymlinkHop(seen, target, filePath);
		target = path.resolve(path.dirname(target), await fsp.readlink(target));
	}
}

/**
 * Records one hop of a symlink chain and fails with `ELOOP` when the chain
 * revisits a link it already followed, which is what a cyclic chain does
 * instead of ending in a file or a missing path.
 */
function recordSymlinkHop(seen: Set<string>, target: string, filePath: string): void {
	const absoluteTarget = path.resolve(target);
	if (seen.has(absoluteTarget)) {
		const error = new Error(`Too many symbolic links while resolving ${filePath}`) as NodeJS.ErrnoException;
		error.code = "ELOOP";
		throw error;
	}
	seen.add(absoluteTarget);
}

/**
 * Refuse to replace anything that is not a regular file.
 *
 * An atomic write finishes with `rename(temp, target)`, and rename does not care
 * what the target is: pointed at a FIFO it DESTROYS the named pipe and leaves a
 * regular file with the same name, silently breaking whatever process was
 * reading the other end. The same goes for a socket or a device node. None of
 * these can be written atomically by definition, so the only honest outcomes are
 * to refuse or to destroy, and the refusal names the type so the operator can
 * see what their path actually pointed at.
 *
 * Directories are included: rename would fail there anyway, with an `EISDIR`
 * that says nothing about which path was wrong.
 *
 * A missing target is not an error — creating the file is the normal first write.
 */
function assertRegularFileTarget(stats: fs.Stats, target: string): void {
	if (stats.isFile()) return;
	throw new Error(
		`Refusing to write ${target}: it is ${nonRegularKind(stats)}, and an atomic write would replace it with a regular file. ` +
			`Point the write at a regular file path instead.`,
	);
}

/** Blocking twin of {@link resolveWriteTarget}; see that function for the reasoning. */
function resolveWriteTargetSync(filePath: string): { target: string; viaSymlink: boolean } {
	let target = filePath;
	let viaSymlink = false;
	const seen = new Set<string>();

	for (;;) {
		let stats: fs.Stats;
		try {
			stats = fs.lstatSync(target);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			return { target, viaSymlink };
		}
		if (!stats.isSymbolicLink()) {
			assertRegularFileTarget(stats, target);
			return { target, viaSymlink };
		}

		viaSymlink = true;
		recordSymlinkHop(seen, target, filePath);
		target = path.resolve(path.dirname(target), fs.readlinkSync(target));
	}
}

/**
 * Restate a failure in terms of the file the caller asked to write.
 *
 * An atomic write does its work on a temp sibling, so the OS error names that
 * temp: `EACCES: permission denied, open '/etc/veyyon/.config.yml.4711.1.tmp'`.
 * That path never existed as far as the operator is concerned, it changes on
 * every attempt, and it sends people looking for a stray temp file instead of at
 * the read-only directory that actually stopped them. The rewrite keeps the OS
 * reason and the failing syscall, swaps in the real target, and says why a temp
 * was involved at all.
 *
 * `code` is copied onto the new error and the original travels as `cause`, so
 * `isEnoent`, `isFsError` and any caller matching on a code keep working.
 *
 * Only a message that quotes THE TEMP PATH is rewritten. An error naming the
 * target already reads correctly and is passed through untouched.
 */
function withTargetInMessage(error: unknown, target: string, tmpPath: string): unknown {
	if (!(error instanceof Error) || !error.message.includes(tmpPath)) return error;
	const restated = new Error(
		`${error.message.replaceAll(tmpPath, target)} (the write is staged in a temporary file beside the target, ` +
			`so it can replace it atomically; the temporary file is what the operating system named)`,
		{ cause: error },
	);
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== undefined) (restated as NodeJS.ErrnoException).code = code;
	return restated;
}

async function assertReplaceableTarget(target: string): Promise<void> {
	try {
		assertRegularFileTarget(await fsp.lstat(target), target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function assertReplaceableTargetSync(target: string): void {
	try {
		assertRegularFileTarget(fs.lstatSync(target), target);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

/**
 * Runs `operation`, then `close` whether or not the operation failed. A failed operation is the
 * primary diagnosis and is thrown over a close failure; a close failure after a successful
 * operation is thrown on its own.
 */
async function closingAfter(operation: () => Promise<void>, close: () => Promise<void>): Promise<void> {
	let operationError: unknown;
	try {
		await operation();
	} catch (error) {
		operationError = error;
	}
	try {
		await close();
	} catch (error) {
		if (operationError === undefined) operationError = error;
	}
	if (operationError !== undefined) throw operationError;
}

/** Blocking twin of {@link closingAfter}. */
function closingAfterSync(operation: () => void, close: () => void): void {
	let operationError: unknown;
	try {
		operation();
	} catch (error) {
		operationError = error;
	}
	try {
		close();
	} catch (error) {
		if (operationError === undefined) operationError = error;
	}
	if (operationError !== undefined) throw operationError;
}

const RENAME_RETRY_BUDGET_MS = 2_000;
const RENAME_RETRY_INITIAL_MS = 5;
const RENAME_RETRY_MAX_MS = 100;

async function renameTempOverTarget(
	tmpPath: string,
	target: string,
	retryRename = false,
	stage?: WindowsStage,
): Promise<void> {
	if (process.platform !== "win32") {
		await fsp.rename(tmpPath, target);
		return;
	}
	if (!stage) throw new Error("Windows publication requires its owned native stage");
	const deadline = retryRename ? Date.now() + RENAME_RETRY_BUDGET_MS : 0;
	const nativeTarget = path.toNamespacedPath(path.resolve(target));
	for (let failures = 0; ; failures++) {
		try {
			stage.publicationState = "recovery-required";
			const outcome = await stage.native.publish(nativeTarget);
			stage.publicationState = outcome.state;
			if (outcome.errorCode !== 0) throw windowsOutcomeError(outcome, target, stage);
			return;
		} catch (error) {
			if (!retryRename || !isRetryableWindowsRenameError(error) ||
				!(error instanceof Error) || (error as WindowsOutcomeError).publicationState !== "unpublished") throw error;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw error;
			await Bun.sleep(Math.min(remaining, RENAME_RETRY_MAX_MS, RENAME_RETRY_INITIAL_MS * 2 ** failures));
		}
	}
}

type WindowsOutcomeError = Error & { code?: string; publicationState?: string; recoveryDirectory?: string; rawErrorCode?: number };

function windowsOutcomeError(outcome: WindowsAtomicOutcome, target: string, stage: WindowsStage): WindowsOutcomeError {
	const retained = outcome.state === "recovery-required" || outcome.state === "published";
	const error = new Error(`${outcome.operation} failed for ${target} (Win32 error ${outcome.errorCode}; publication: ${outcome.state}).${retained ? ` Recovery files remain at ${stage.directory}.` : ""}`) as WindowsOutcomeError;
	error.rawErrorCode = outcome.errorCode;
	error.code = `WIN32_${outcome.errorCode}`;
	error.publicationState = outcome.state;
	if (retained) error.recoveryDirectory = stage.directory;
	return error;
}

function withWindowsPublicationState(error: unknown, stage: WindowsStage, target: string): unknown {
	if (stage.publicationState === "unpublished" || (error instanceof Error && "publicationState" in error)) return error;
	const state = stage.publicationState;
	const message = state === "published" ? "The replacement was published" : "The publication outcome is unknown";
	const failure = new Error(`${message} for ${target}; recovery files remain at ${stage.directory}.`, { cause: error }) as WindowsOutcomeError;
	failure.publicationState = state;
	failure.recoveryDirectory = stage.directory;
	return failure;
}

const DIRECTORY_FSYNC_UNSUPPORTED: Readonly<Record<string, true>> = {
	EINVAL: true,
	EISDIR: true,
	ENOSYS: true,
	ENOTSUP: true,
};

function isDirectoryFsyncUnsupported(error: unknown): boolean {
	if (!isFsError(error) || error.code === undefined) return false;
	if (DIRECTORY_FSYNC_UNSUPPORTED[error.code]) return true;
	// Windows refuses directory handles with either access code depending on
	// filesystem and Node version. On POSIX those codes are real failures.
	return process.platform === "win32" && (error.code === "EACCES" || error.code === "EPERM");
}

/** Flush directory-entry metadata when the platform supports directory handles. */
export async function fsyncDirEntry(dir: string): Promise<void> {
	let dirHandle: fsp.FileHandle;
	try {
		dirHandle = await fsp.open(dir, "r");
	} catch (error) {
		if (isDirectoryFsyncUnsupported(error)) return;
		throw error;
	}
	await closingAfter(
		() => dirHandle.sync().catch(rethrowUnlessDirectoryFsyncUnsupported),
		() => dirHandle.close(),
	);
}

/** Rethrows a directory fsync failure, unless it is one {@link isDirectoryFsyncUnsupported} accepts. */
function rethrowUnlessDirectoryFsyncUnsupported(error: unknown): void {
	if (!isDirectoryFsyncUnsupported(error)) throw error;
}

/**
 * Write `data` to `filePath` atomically. Creates parent directories as needed.
 * Throws on failure; publication may already have committed if a later durability
 * or native cleanup operation fails.
 */
export async function atomicWriteFile(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteOptions = {},
): Promise<void> {
	const { mode = 0o600, fsync = true, retryRename = false } = options;
	await atomicWriteBytes(filePath, data, mode, fsync, false, retryRename);
}

async function atomicWriteBytes(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	mode: number,
	fsync: boolean,
	preserveModeExactly: boolean,
	retryRename = false,
): Promise<void> {
	await atomicWriteFileWithImpl(
		filePath,
		{
			kind: "handle",
			write: async handle => {
				await handle.writeFile(data);
				if (preserveModeExactly) await handle.chmod(mode);
				if (fsync) await handle.sync();
			},
		},
		{ fsync, mode, retryRename },
	);
}

/**
 * Atomic write that carries the target's CURRENT permission bits forward.
 *
 * {@link atomicWriteFile} replaces the file by renaming a fresh temp over it, so
 * the result takes the temp's mode — `0o600` by default. That is right for a
 * secret-bearing config file, but wrong when you are rewriting a file whose mode
 * matters: an executable script would silently lose its `+x`, a group-readable
 * file its group bit. Use this when you are overwriting an existing file and must
 * not change how it is permissioned — source files an editor rewrites, a move
 * that overwrites a destination, any content update to a pre-existing path.
 *
 * The current mode is read with `stat` (which follows a symlink to the file that
 * will actually be replaced), so a symlinked path preserves its target's mode. A
 * path that does not exist yet is created with `defaultMode` (0o644 — a normal,
 * non-secret file default), still subject to the process umask at creation.
 */
export async function atomicWriteFilePreservingMode(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: { fsync?: boolean; defaultMode?: number } = {},
): Promise<void> {
	const { fsync = true, defaultMode = 0o644 } = options;
	let mode = defaultMode;
	let existed = true;
	try {
		mode = (await fsp.stat(filePath)).mode & 0o7777;
	} catch (error) {
		if (!isEnoent(error)) throw error;
		existed = false;
	}
	await atomicWriteBytes(filePath, data, mode, fsync, existed);
}

/**
 * Serialize `data` as pretty-printed JSON (2-space indent, trailing newline)
 * and write it to `filePath` atomically via {@link atomicWriteFile}. The
 * trailing newline keeps the file POSIX-clean and diff-friendly. Use this for
 * any on-disk JSON registry or config so every writer produces byte-identical
 * formatting instead of each caller hand-rolling `JSON.stringify(...) + "\n"`.
 */
export async function atomicWriteJson(
	filePath: string,
	data: unknown,
	options: AtomicWriteOptions = {},
): Promise<void> {
	await atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`, options);
}

/**
 * The producer form of {@link atomicWriteFile}: instead of handing over bytes,
 * you get the temp path and write to it however you like (a streaming writer, a
 * Native Windows staging protects the payload before this callback runs. A
 * later durability or cleanup error can still occur after publication.
 *
 * Use this only when the payload is produced by something that writes to a path
 * rather than returning bytes. When you already have the bytes, call
 * {@link atomicWriteFile}; it routes through here.
 *
 * @example
 * ```ts
 * await atomicWriteFileWith(archivePath, tmpPath => writeArchive(tmpPath, format, entries));
 * ```
 */
export async function atomicWriteFileWith(
	filePath: string,
	write: (tempPath: string) => Promise<void>,
	options: AtomicWriteOptions & {
		/**
		 * Reopen the finished temp file and fsync it before the rename. Defaults
		 * to `true`, which is what a path writer needs: it closes its own fd, so
		 * the owner must flush the bytes. {@link atomicWriteFile} passes `false`
		 * because it already fsyncs its own write handle (the Windows-correct way).
		 */
		fsyncTempFile?: boolean;
	} = {},
): Promise<void> {
	await atomicWriteFileWithImpl(filePath, { kind: "path", write }, options);
}

type AtomicTempWriter =
	| { kind: "handle"; write: (handle: fsp.FileHandle) => Promise<void> }
	| { kind: "path"; write: (tempPath: string) => Promise<void> };

interface AtomicWriteInternalOptions extends AtomicWriteOptions {
	fsyncTempFile?: boolean;
}

async function atomicWriteFileWithImpl(
	filePath: string,
	writer: AtomicTempWriter,
	options: AtomicWriteInternalOptions,
): Promise<void> {
	const {
		fsync = true,
		fsyncTempFile = true,
		mode = 0o600,
		retryRename = false,
	} = options;
	const { target, viaSymlink } = await resolveWriteTarget(filePath);
	const dir = path.dirname(target);
	if (!viaSymlink) await fsp.mkdir(dir, { recursive: true });

	const { handle, tmpPath, stage } = await reserveTempFile(dir, path.basename(target), mode, target);
	try {
		if (writer.kind === "handle") {
			await closingAfter(() => writer.write(handle), () => handle.close());
		} else {
			await handle.close();
			await fillTempFromPath(writer.write, tmpPath, mode, fsync && fsyncTempFile);
		}
		assertRegularFileTarget(await fsp.lstat(tmpPath), tmpPath);
		await assertReplaceableTarget(target);
		if (stage) pendingWindowsStages.delete(stage);
		await renameTempOverTarget(tmpPath, target, retryRename, stage);
		if (stage) {
			const cleanup = await stage.native.cleanup();
			if (cleanup.errorCode !== 0) throw windowsOutcomeError({ ...cleanup, state: "published" }, target, stage);
		} else pendingTemps.delete(tmpPath);
	} catch (error) {
		if (stage) {
			error = withWindowsPublicationState(error, stage, target);
			if (stage.publicationState === "unpublished") {
				try {
					const cleanup = await stage.native.cleanup();
					if (cleanup.errorCode !== 0) throw windowsOutcomeError(cleanup, target, stage);
				} catch (cleanupError) {
					pendingWindowsStages.delete(stage);
					throw new AggregateError([error, cleanupError], `Write failed for ${target}; native stage remains at ${stage.directory}`);
				}
			}
			pendingWindowsStages.delete(stage);
		} else {
			pendingTemps.delete(tmpPath);
			await fsp.rm(tmpPath, { force: true, recursive: true }).catch(() => {});
		}
		throw withTargetInMessage(error, target, tmpPath);
	}
	if (fsync) {
		try {
			await fsyncDirEntry(dir);
		} catch (error) {
			const committed = new Error(`Write to ${target} was published, but directory durability failed.`, { cause: error }) as WindowsOutcomeError;
			committed.publicationState = "published";
			throw committed;
		}
	}
}

/**
 * Lets a path producer write the reserved temp, then takes the entry it left over: it must be a
 * regular file, and it gets `mode` under the umask and, when `flush` is set, an fsync.
 */
async function fillTempFromPath(
	write: (tempPath: string) => Promise<void>,
	tmpPath: string,
	mode: number,
	flush: boolean,
): Promise<void> {
	await write(tmpPath);
	// The producer owns only the bytes, never the type or permissions of
	// the staging entry. A directory or link must not become the target.
	assertRegularFileTarget(await fsp.lstat(tmpPath), tmpPath);
	const handle = await fsp.open(tmpPath, "r+");
	await closingAfter(
		async () => {
			await handle.chmod(process.platform === "win32" ? mode : mode & ~process.umask());
			if (flush) await handle.sync();
		},
		() => handle.close(),
	);
}

/**
 * Blocking twin of {@link atomicWriteFile} with identical crash-safety and
 * symlink semantics. Use only where the call site cannot be async (for example
 * a synchronous config accessor); prefer the async form everywhere else.
 */
export function atomicWriteFileSync(
	filePath: string,
	data: string | NodeJS.ArrayBufferView,
	options: AtomicWriteSyncOptions = {},
): void {
	const { mode = 0o600, fsync = true } = options;
	const { target, viaSymlink } = resolveWriteTargetSync(filePath);
	const dir = path.dirname(target);
	if (!viaSymlink) fs.mkdirSync(dir, { recursive: true });

	const { fd, tmpPath, stage } = reserveTempFileSync(dir, path.basename(target), mode, target);
	try {
		closingAfterSync(
			() => {
				fs.writeFileSync(fd, data);
				if (fsync) fs.fsyncSync(fd);
			},
			() => fs.closeSync(fd),
		);
		assertRegularFileTarget(fs.lstatSync(tmpPath), tmpPath);
		assertReplaceableTargetSync(target);
		if (stage) pendingWindowsStages.delete(stage);
		renameTempOverTargetSync(tmpPath, target, stage);
		if (stage) {
			const cleanup = stage.native.cleanupSync();
			if (cleanup.errorCode !== 0) throw windowsOutcomeError({ ...cleanup, state: "published" }, target, stage);
		} else pendingTemps.delete(tmpPath);
	} catch (error) {
		if (stage) {
			error = withWindowsPublicationState(error, stage, target);
			if (stage.publicationState === "unpublished") {
				try {
					const cleanup = stage.native.cleanupSync();
					if (cleanup.errorCode !== 0) throw windowsOutcomeError(cleanup, target, stage);
				} catch (cleanupError) {
					pendingWindowsStages.delete(stage);
					throw new AggregateError([error, cleanupError], `Write failed for ${target}; native stage remains at ${stage.directory}`);
				}
			}
			pendingWindowsStages.delete(stage);
		} else {
			try { removeTempSync(tmpPath); } catch {}
		}
		throw withTargetInMessage(error, target, tmpPath);
	}
	if (fsync) {
		try {
			fsyncDirEntrySync(dir);
		} catch (error) {
			const committed = new Error(`Write to ${target} was published, but directory durability failed.`, { cause: error }) as WindowsOutcomeError;
			committed.publicationState = "published";
			throw committed;
		}
	}
}

/** Blocking twin of {@link renameTempOverTarget}; see that function for the reasoning. */
function renameTempOverTargetSync(tmpPath: string, target: string, stage?: WindowsStage): void {
	if (process.platform === "win32") {
		if (!stage) throw new Error("Windows publication requires its owned native stage");
		stage.publicationState = "recovery-required";
		const outcome = stage.native.publishSync(path.toNamespacedPath(path.resolve(target)));
		stage.publicationState = outcome.state;
		if (outcome.errorCode !== 0) throw windowsOutcomeError(outcome, target, stage);
	} else {
		fs.renameSync(tmpPath, target);
	}
}

/** Synchronous twin of {@link fsyncDirEntry}. */
export function fsyncDirEntrySync(dir: string): void {
	let dirFd: number;
	try {
		dirFd = fs.openSync(dir, "r");
	} catch (error) {
		if (isDirectoryFsyncUnsupported(error)) return;
		throw error;
	}
	closingAfterSync(
		() => {
			try {
				fs.fsyncSync(dirFd);
			} catch (error) {
				rethrowUnlessDirectoryFsyncUnsupported(error);
			}
		},
		() => fs.closeSync(dirFd),
	);
}
