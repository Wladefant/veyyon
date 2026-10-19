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
 * - Files are deterministically sorted by their relative path.
 * - Framed domain-separated hashing (`veyyon:project-skill:v1\0`) ensures
 *   the digest is unambiguous and never collides with raw single-file hashes.
 * - An old single-file trust record is invalidated naturally as "changed".
 * - Any script or asset change revokes trust automatically.
 * - Symlinks escaping the project root or forming cycles are rejected.
 * - The trust store is keyed by the real relative POSIX path of `SKILL.md`.
 */
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, logger } from "@veyyon/utils";
import type { ProjectExecutable } from "./project-trust";

export const PROJECT_SKILL_HASH_DOMAIN = "veyyon:project-skill:v1";

export interface ProjectSkillSnapshot extends ProjectExecutable {
	content: string;
}

interface SkillFolderFile {
	relativePath: string;
	content: Buffer;
}

/**
 * Describe one candidate project skill, or null when it is not valid,
 * not readable, or outside the project root.
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

	// Collect all files in the skill folder recursively
	const files: SkillFolderFile[] = [];
	const visitedAncestors = new Set<string>();

	async function collectFiles(currentDir: string, currentDirRel: string): Promise<boolean> {
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
				const success = await collectFiles(entryPath, entryRel);
				if (!success) return false;
			} else if (stat.isFile()) {
				let content: Buffer;
				try {
					content = await fs.readFile(realEntry);
				} catch (err) {
					logger.warn("project skill trust: failed to read file", {
						file: entryPath,
						error: errorMessage(err),
					});
					return false;
				}
				files.push({ relativePath: entryRel, content });
			} else {
				logger.warn("project skill trust: unsupported file type", { path: entryPath });
				return false;
			}
		}

		visitedAncestors.delete(realCurrent);
		return true;
	}

	const collected = await collectFiles(skillDir, "");
	if (!collected) {
		return null;
	}

	// Deterministic sort by relative path
	files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

	// Framed domain-separated hash
	const hash = createHash("sha256");
	hash.update(`${PROJECT_SKILL_HASH_DOMAIN}\0`);
	for (const file of files) {
		hash.update(`file:${Buffer.byteLength(file.relativePath)}:${file.relativePath}:${file.content.length}:`);
		hash.update(file.content);
		hash.update("\0");
	}
	const folderHash = hash.digest("hex");

	const relativeSkillFile = relSkillFile.split(path.sep).join("/");
	// Prefer the exact hashed path; only Windows falls back to case-insensitive lookup.
	const definitionName = path.basename(skillFile);
	const definition =
		files.find(file => file.relativePath === definitionName) ??
		(process.platform === "win32"
			? files.find(file => file.relativePath.toLowerCase() === definitionName.toLowerCase())
			: undefined);
	if (!definition) return null;
	return {
		absolutePath: path.resolve(skillFile),
		relativePath: relativeSkillFile,
		hash: folderHash,
		content: definition.content.toString("utf8"),
	};
}
