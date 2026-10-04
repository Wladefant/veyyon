/**
 * Session-scoped artifact storage for truncated tool outputs.
 *
 * Artifacts are stored in a directory alongside the session file,
 * accessible via artifact:// URLs.
 */

import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFileSync, atomicWriteFileWith } from "@veyyon/utils/atomic-write";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";

/**
 * Sanitize a tool name for safe use as the middle segment of the artifact
 * filename (`${id}.${toolType}.log`). Built-in tool names are fixed, but MCP,
 * extension, and RPC-host tool names are arbitrary and may contain path
 * separators (`/`, `\`) or traversal sequences (`..`) that would otherwise let
 * a spilled artifact escape the artifacts directory. Collapse everything
 * outside `[A-Za-z0-9_-]` to `_`, and cap the length so an arbitrarily long
 * name cannot overflow the filesystem's filename limit (ENAMETOOLONG). Fall
 * back to `tool` when nothing survives.
 */
function sanitizeToolType(toolType: string): string {
	const sanitized = toolType
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.slice(0, 64)
		.replace(/^_+|_+$/g, "");
	return sanitized.length > 0 ? sanitized : "tool";
}

/**
 * Publish one artifact payload, whole or not at all.
 *
 * `artifact://<id>` and `agent://<id>` resolve an artifact by SCANNING the
 * artifacts directory — nothing compares the file against what was meant to be
 * written. So a write that stopped short would leave a truncated file that still
 * resolved as a complete result, and a rewrite of the same path destroyed the
 * previous bytes before it knew whether the new ones would land.
 *
 * The payload is staged on a hidden sibling, checked against its own byte count
 * and on-disk size, and only then renamed into place; any failure removes the
 * staging file and leaves the destination exactly as it was. The rename itself
 * comes from `@veyyon/utils/atomic-write`, which owns the Windows
 * replace-existing recovery, so this adds no second atomic-write implementation.
 *
 * @returns the verified UTF-8 byte count.
 */
export async function writeArtifactAtomically(path: string, content: string): Promise<number> {
	const expectedBytes = Buffer.byteLength(content);
	await atomicWriteFileWith(path, async tempPath => {
		const writtenBytes = await Bun.write(tempPath, content);
		if (writtenBytes !== expectedBytes) {
			throw new Error(`Artifact write incomplete: wrote ${writtenBytes} of ${expectedBytes} bytes`);
		}
		const onDiskBytes = Bun.file(tempPath).size;
		if (onDiskBytes !== expectedBytes) {
			throw new Error(`Artifact size mismatch: found ${onDiskBytes} of ${expectedBytes} bytes`);
		}
		// Read the payload back through the same reader a resolver uses, so a file
		// the buffers accept but the filesystem cannot return fails here rather than
		// reaching the caller as a short artifact.
		await Bun.file(tempPath).slice(0, Math.min(expectedBytes, 1)).arrayBuffer();
	});
	return expectedBytes;
}

export function writeArtifactAtomicallySync(path: string, content: string): number {
	const expectedBytes = Buffer.byteLength(content);
	atomicWriteFileSync(path, content);
	return expectedBytes;
}

/**
 * Manages artifact storage for a session.
 *
 * Artifacts are stored with sequential IDs in the session's artifact directory.
 * The directory is created lazily on first write.
 *
 * Agents do not own their own `ArtifactManager`. The parent's instance is
 * adopted via `SessionManager.adoptArtifactManager`, so the whole parent +
 * agent tree shares one ID space and one directory.
 */
export class ArtifactManager {
	#nextId = 0;
	readonly #dir: string;
	#dirCreated = false;
	#initPromise: Promise<void> | null = null;
	#idsInitialized = false;

	/**
	 * @param dir Directory that will hold artifact files. Created lazily on first save.
	 */
	constructor(dir: string) {
		this.#dir = dir;
	}

	/**
	 * Artifact directory path.
	 * Directory may not exist until first artifact is saved.
	 */
	get dir(): string {
		return this.#dir;
	}

	async #ensureDir(): Promise<void> {
		if (!this.#dirCreated) {
			await fs.mkdir(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		// Memoize the first-use scan so it runs exactly once. Concurrent callers
		// share the in-flight promise instead of each re-seeding #nextId across
		// the readdir yield in #scanExistingIds (which would hand duplicate ids).
		this.#initPromise ??= this.#scanExistingIds();
		await this.#initPromise;
		this.#idsInitialized = true;
	}

	#ensureDirSync(): void {
		if (!this.#dirCreated) {
			fsSync.mkdirSync(this.#dir, { recursive: true });
			this.#dirCreated = true;
		}
		if (!this.#idsInitialized) {
			this.#scanExistingIdsSync();
			this.#idsInitialized = true;
			this.#initPromise ??= Promise.resolve();
		}
	}

	#scanExistingIdsSync(): void {
		let maxId = -1;
		try {
			const files = fsSync.readdirSync(this.#dir);
			for (const file of files) {
				const match = file.match(/^(\d+)\..*\.log$/);
				if (match) {
					const id = parseInt(match[1], 10);
					if (id > maxId) maxId = id;
				}
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Artifact directory could not be read; truncated tool outputs are unreachable", {
					dir: this.#dir,
					error: errorMessage(err),
				});
			}
		}
		this.#nextId = Math.max(this.#nextId, maxId + 1);
	}

	/**
	 * Scan existing artifact files to find the next available ID.
	 * This ensures we don't overwrite artifacts when resuming a session.
	 */
	async #scanExistingIds(): Promise<void> {
		const files = await this.listFiles();
		let maxId = -1;
		for (const file of files) {
			// Files are named: {id}.{toolType}.log
			const match = file.match(/^(\d+)\..*\.log$/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxId) maxId = id;
			}
		}
		this.#nextId = Math.max(this.#nextId, maxId + 1);
	}

	/**
	 * Claim a sequential ID across managers and processes. Keep the hidden
	 * reservation after publication: a failed save must not recycle its ID.
	 */
	allocateId(): number {
		fsSync.mkdirSync(this.#dir, { recursive: true });
		for (;;) {
			const id = this.#nextId++;
			try {
				fsSync.mkdirSync(path.join(this.#dir, `.artifact-id-${id}`));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw error;
			}
			return id;
		}
	}

	/**
	 * Allocate a new artifact path and ID without writing content.
	 *
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 */
	async allocatePath(toolType: string): Promise<{ id: string; path: string }> {
		await this.#ensureDir();
		const id = String(this.allocateId());
		const filename = `${id}.${sanitizeToolType(toolType)}.log`;
		return { id, path: path.join(this.#dir, filename) };
	}

	/**
	 * Save content as an artifact and return the artifact ID.
	 *
	 * @param content Full content to save
	 * @param toolType Tool name for file extension (e.g., "bash", "read")
	 * @returns Artifact ID (numeric string)
	 */
	async save(content: string, toolType: string): Promise<string> {
		const { id, path } = await this.allocatePath(toolType);
		await writeArtifactAtomically(path, content);
		return id;
	}

	/**
	 * Synchronously allocate a new artifact path and ID without writing content.
	 */
	allocatePathSync(toolType: string): { id: string; path: string } {
		this.#ensureDirSync();
		const id = String(this.allocateId());
		const filename = `${id}.${sanitizeToolType(toolType)}.log`;
		return { id, path: path.join(this.#dir, filename) };
	}

	/**
	 * Synchronously save content as an artifact and return the artifact ID.
	 */
	saveSync(content: string, toolType: string): string {
		const { id, path: targetPath } = this.allocatePathSync(toolType);
		writeArtifactAtomicallySync(targetPath, content);
		return id;
	}

	/**
	 * Check if an artifact exists.
	 * @param id Artifact ID (numeric string)
	 */
	async exists(id: string): Promise<boolean> {
		const files = await this.listFiles();
		return files.some(f => f.startsWith(`${id}.`));
	}

	/**
	 * List all artifact files in the directory.
	 *
	 * A directory that does not exist is an empty list: no output has been truncated into an artifact
	 * yet. A directory that exists and cannot be read is reported, because the artifacts are what an
	 * `artifact://` URL resolves against, so an empty list there means every truncated tool output in
	 * the session becomes unreachable with nothing saying why.
	 */
	async listFiles(): Promise<string[]> {
		try {
			return (await fs.readdir(this.#dir)).filter(file => !file.startsWith(".artifact-id-"));
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Artifact directory could not be read; truncated tool outputs are unreachable", {
					dir: this.#dir,
					error: errorMessage(err),
				});
			}
			return [];
		}
	}

	/**
	 * Get the full path to an artifact file.
	 * Returns null if artifact doesn't exist.
	 *
	 * @param id Artifact ID (numeric string)
	 */
	async getPath(id: string): Promise<string | null> {
		const files = await this.listFiles();
		const match = files.find(f => f.startsWith(`${id}.`));
		return match ? path.join(this.#dir, match) : null;
	}
}
