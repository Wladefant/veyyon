/**
 * Project skill trust: folder-level executable trust for agent skills.
 *
 * A project skill is not an isolated markdown file: it is a folder containing
 * instructions (`SKILL.md`), executable scripts, prompt templates and asset files.
 * Trusting only `SKILL.md` would allow an attacker to modify executable scripts
 * or resources in the same folder without invalidating trust.
 *
 * Folder hashing:
 * - The entire containing skill folder is scanned recursively.
 * - Every nested file is included with its relative path and content.
 * - Directories named `node_modules` or `.git` are not scanned. A file with
 *   either name is still hashed.
 * - Files are deterministically sorted by their relative path.
 * - Framed domain-separated hashing (`veyyon:project-skill:v1\0`) ensures
 *   the digest is unambiguous and never collides with raw single-file hashes.
 * - File content is streamed into the digest, never held whole in memory.
 * - An old single-file trust record is invalidated naturally as "changed".
 * - Any script or asset change revokes trust automatically.
 * - Symlinks escaping the project root or forming cycles are rejected.
 * - A folder over any {@link PROJECT_SKILL_LIMITS} bound is not trusted; the scan
 *   stops and nothing is approved for it.
 * - The trust store is keyed by the real relative POSIX path of `SKILL.md`.
 */
import { createHash, type Hash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { ProjectExecutable } from "./project-trust";

export const PROJECT_SKILL_HASH_DOMAIN = "veyyon:project-skill:v1";

/**
 * Bounds on one skill folder. A folder that exceeds any bound is not trusted, so an
 * approval never covers bytes the scan did not read.
 */
export const PROJECT_SKILL_LIMITS = {
	/** Nested directory levels below the skill folder. */
	maxDepth: 8,
	/** Files in the skill folder, excluding skipped directories. */
	maxFiles: 256,
	/** Size of any one file. */
	maxFileBytes: 1024 * 1024,
	/** Sum of every file's size. */
	maxTotalBytes: 16 * 1024 * 1024,
} as const;

/** Directories that are never scanned: dependency trees and VCS metadata. */
const SKIPPED_DIRECTORY_NAMES: Record<string, true> = { ".git": true, node_modules: true };

const HASH_READ_CHUNK_BYTES = 64 * 1024;

export interface ProjectSkillSnapshot extends ProjectExecutable {
	content: string;
}

interface SkillFolderFile {
	relativePath: string;
	/** Real path of the file, verified to lie inside the project root. */
	absolutePath: string;
	/** Size from the scan. A read that disagrees means the file changed under the scan. */
	size: number;
}

/**
 * Describe one candidate project skill, or null when it is not valid,
 * not readable, outside the project root, or larger than {@link PROJECT_SKILL_LIMITS}.
 *
 * Returns a {@link ProjectExecutable} keyed by the real project-relative path
 * of `SKILL.md`, with an opaque domain-separated hash of the entire containing
 * skill folder.
 */
export async function describeProjectSkill(
	absolutePath: string,
	canonicalRoot: string,
): Promise<ProjectSkillSnapshot | null> {
	const resolved = path.resolve(absolutePath);

	let resolvedStat: Stats;
	try {
		resolvedStat = await fs.stat(resolved);
	} catch {
		return null;
	}

	let skillFile: string;
	let skillDir: string;

	if (resolvedStat.isDirectory()) {
		skillFile = path.join(resolved, "SKILL.md");
		skillDir = resolved;
	} else if (resolvedStat.isFile()) {
		if (path.basename(resolved).toLowerCase() !== "skill.md") {
			return null;
		}
		skillFile = resolved;
		skillDir = path.dirname(resolved);
	} else {
		return null;
	}

	// Verify SKILL.md exists and is a regular file
	try {
		const fileStat = await fs.stat(skillFile);
		if (!fileStat.isFile()) return null;
	} catch {
		return null;
	}

	// Resolve real paths
	let realSkillFile: string;
	let realSkillDir: string;
	try {
		realSkillFile = await fs.realpath(skillFile);
		realSkillDir = await fs.realpath(skillDir);
	} catch (err) {
		logger.warn("project skill trust: failed to resolve realpath", {
			skillFile,
			skillDir,
			error: errorMessage(err),
		});
		return null;
	}

	// Verify paths are inside canonicalRoot
	const relSkillFile = path.relative(canonicalRoot, realSkillFile);
	if (relSkillFile === "" || relSkillFile.startsWith("..") || path.isAbsolute(relSkillFile)) {
		logger.warn("project skill trust: skill file escapes project root", {
			path: skillFile,
			realPath: realSkillFile,
			canonicalRoot,
		});
		return null;
	}

	const relSkillDir = path.relative(canonicalRoot, realSkillDir);
	if (relSkillDir === "" || relSkillDir.startsWith("..") || path.isAbsolute(relSkillDir)) {
		logger.warn("project skill trust: skill directory escapes project root", {
			path: skillDir,
			realPath: realSkillDir,
			canonicalRoot,
		});
		return null;
	}

	// Scan metadata only: paths and sizes, bounded. Content is streamed below.
	const files: SkillFolderFile[] = [];
	let totalBytes = 0;
	const visitedAncestors = new Set<string>();

	function refuseOverLimit(limit: string, details: Record<string, unknown>): false {
		logger.warn(`project skill trust: skill folder exceeds ${limit}, not trusted`, details);
		return false;
	}

	async function collectFiles(currentDir: string, currentDirRel: string, depth: number): Promise<boolean> {
		if (depth > PROJECT_SKILL_LIMITS.maxDepth) {
			return refuseOverLimit("the maximum directory depth", {
				dir: currentDir,
				maxDepth: PROJECT_SKILL_LIMITS.maxDepth,
			});
		}

		let realCurrent: string;
		try {
			realCurrent = await fs.realpath(currentDir);
		} catch (err) {
			logger.warn("project skill trust: unreadable directory in skill folder", {
				dir: currentDir,
				error: errorMessage(err),
			});
			return false;
		}

		const relFromRoot = path.relative(canonicalRoot, realCurrent);
		if (relFromRoot === "" || relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
			logger.warn("project skill trust: directory escapes project root", {
				dir: currentDir,
				target: realCurrent,
				canonicalRoot,
			});
			return false;
		}

		if (visitedAncestors.has(realCurrent)) {
			logger.warn("project skill trust: symlink cycle detected in skill folder", {
				dir: currentDir,
				target: realCurrent,
			});
			return false;
		}

		let entries: Dirent[];
		try {
			entries = await fs.readdir(currentDir, { withFileTypes: true });
		} catch (err) {
			logger.warn("project skill trust: failed to read directory", {
				dir: currentDir,
				error: errorMessage(err),
			});
			return false;
		}

		entries.sort((a, b) => a.name.localeCompare(b.name));

		visitedAncestors.add(realCurrent);

		for (const entry of entries) {
			const entryPath = path.join(currentDir, entry.name);
			const entryRel = currentDirRel ? `${currentDirRel}/${entry.name}` : entry.name;

			let realEntry: string;
			try {
				realEntry = await fs.realpath(entryPath);
			} catch (err) {
				logger.warn("project skill trust: unreadable entry or broken symlink in skill folder", {
					entry: entryPath,
					error: errorMessage(err),
				});
				return false;
			}

			const entryRelFromRoot = path.relative(canonicalRoot, realEntry);
			if (entryRelFromRoot === "" || entryRelFromRoot.startsWith("..") || path.isAbsolute(entryRelFromRoot)) {
				logger.warn("project skill trust: entry escapes project root", {
					entry: entryPath,
					target: realEntry,
					canonicalRoot,
				});
				return false;
			}

			let stat: Stats;
			try {
				stat = await fs.stat(realEntry);
			} catch (err) {
				logger.warn("project skill trust: failed to stat entry", {
					entry: entryPath,
					error: errorMessage(err),
				});
				return false;
			}

			if (stat.isDirectory()) {
				if (SKIPPED_DIRECTORY_NAMES[entry.name] === true) continue;
				const success = await collectFiles(entryPath, entryRel, depth + 1);
				if (!success) return false;
			} else if (stat.isFile()) {
				if (files.length >= PROJECT_SKILL_LIMITS.maxFiles) {
					return refuseOverLimit("the maximum file count", {
						dir: currentDir,
						maxFiles: PROJECT_SKILL_LIMITS.maxFiles,
					});
				}
				if (stat.size > PROJECT_SKILL_LIMITS.maxFileBytes) {
					return refuseOverLimit("the maximum file size", {
						file: entryPath,
						size: stat.size,
						maxFileBytes: PROJECT_SKILL_LIMITS.maxFileBytes,
					});
				}
				totalBytes += stat.size;
				if (totalBytes > PROJECT_SKILL_LIMITS.maxTotalBytes) {
					return refuseOverLimit("the maximum total size", {
						dir: currentDir,
						maxTotalBytes: PROJECT_SKILL_LIMITS.maxTotalBytes,
					});
				}
				files.push({ relativePath: entryRel, absolutePath: realEntry, size: stat.size });
			} else {
				logger.warn("project skill trust: unsupported file type", { path: entryPath });
				return false;
			}
		}

		visitedAncestors.delete(realCurrent);
		return true;
	}

	const collected = await collectFiles(skillDir, "", 0);
	if (!collected) {
		return null;
	}

	// Deterministic sort by relative path
	files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

	// Prefer the exact hashed path; only Windows falls back to case-insensitive lookup.
	const definitionName = path.basename(skillFile);
	const definition =
		files.find(file => file.relativePath === definitionName) ??
		(process.platform === "win32"
			? files.find(file => file.relativePath.toLowerCase() === definitionName.toLowerCase())
			: undefined);
	if (!definition) return null;

	// Framed domain-separated hash, streamed file by file in sorted order.
	const hash = createHash("sha256");
	hash.update(`${PROJECT_SKILL_HASH_DOMAIN}\0`);
	let definitionContent = "";
	for (const file of files) {
		hash.update(`file:${Buffer.byteLength(file.relativePath)}:${file.relativePath}:${file.size}:`);
		const content = await hashSkillFolderFile(hash, file, file === definition);
		if (content === null) {
			logger.warn("project skill trust: skill folder changed while it was being hashed", {
				file: file.absolutePath,
			});
			return null;
		}
		if (file === definition) definitionContent = content.toString("utf8");
	}
	const folderHash = hash.digest("hex");

	const relativeSkillFile = relSkillFile.split(path.sep).join("/");
	return {
		absolutePath: path.resolve(skillFile),
		relativePath: relativeSkillFile,
		hash: folderHash,
		content: definitionContent,
	};
}

/**
 * Stream one file into `hash` and return its bytes when `keep` is set.
 *
 * Returns null when the file's size differs from the scan's, meaning it changed
 * between the scan and the read. The caller must then refuse the folder.
 */
async function hashSkillFolderFile(hash: Hash, file: SkillFolderFile, keep: boolean): Promise<Buffer | null> {
	const handle = await fs.open(file.absolutePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK_BYTES);
		const kept: Buffer[] = [];
		let readBytes = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			readBytes += bytesRead;
			if (readBytes > file.size) return null;
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			if (keep) kept.push(Buffer.from(chunk));
		}
		if (readBytes !== file.size) return null;
		hash.update("\0");
		return Buffer.concat(kept);
	} finally {
		await handle.close();
	}
}
