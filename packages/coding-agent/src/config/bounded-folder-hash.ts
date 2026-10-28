import { createHash, type Hash } from "node:crypto";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface BoundedFolderLimits {
	maxDepth: number;
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

export interface BoundedFolderFile {
	relativePath: string;
	absolutePath: string;
	size: number;
}

const HASH_READ_CHUNK_BYTES = 64 * 1024;

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Scan every regular file in a tree without exclusions. */
export async function scanBoundedFolder(
	folderRoot: string,
	containmentRoot: string,
	limits: BoundedFolderLimits,
	requireChildrenInsideFolder = true,
): Promise<BoundedFolderFile[] | null> {
	const files: BoundedFolderFile[] = [];
	let totalBytes = 0;
	const ancestors = new Set<string>();
	async function walk(current: string, relative: string, depth: number): Promise<boolean> {
		if (depth > limits.maxDepth) return false;
		let realCurrent: string;
		let entries: Dirent[];
		try {
			realCurrent = await fs.realpath(current);
			if (!inside(containmentRoot, realCurrent) || ancestors.has(realCurrent)) return false;
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			return false;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		ancestors.add(realCurrent);
		for (const entry of entries) {
			const source = path.join(current, entry.name);
			const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
			let real: string;
			let stat;
			try {
				real = await fs.realpath(source);
				if (!inside(containmentRoot, real) || (requireChildrenInsideFolder && !inside(folderRoot, real))) return false;
				stat = await fs.stat(real);
			} catch {
				return false;
			}
			if (stat.isDirectory()) {
				if (!(await walk(source, childRelative, depth + 1))) return false;
			} else if (stat.isFile()) {
				if (files.length >= limits.maxFiles || stat.size > limits.maxFileBytes) return false;
				totalBytes += stat.size;
				if (totalBytes > limits.maxTotalBytes) return false;
				files.push({ relativePath: childRelative, absolutePath: real, size: stat.size });
			} else return false;
		}
		ancestors.delete(realCurrent);
		return true;
	}
	if (!(await walk(folderRoot, "", 0))) return null;
	files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
	return files;
}

/** Hash files returned by the bounded scanner using the supplied domain. */
export async function hashBoundedFolder(
	folderRoot: string,
	containmentRoot: string,
	limits: BoundedFolderLimits,
	domain: string,
): Promise<{ hash: string; files: BoundedFolderFile[] } | null> {
	const files = await scanBoundedFolder(folderRoot, containmentRoot, limits);
	if (!files) return null;
	const hash = createHash("sha256");
	hash.update(`${domain}\0`);
	for (const file of files) {
		hash.update(`file:${Buffer.byteLength(file.relativePath)}:${file.relativePath}:${file.size}:`);
		if (!(await hashFolderFile(hash, file))) return null;
	}
	return { hash: hash.digest("hex"), files };
}

async function hashFolderFile(hash: Hash, file: BoundedFolderFile): Promise<boolean> {
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(file.absolutePath, "r");
		const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK_BYTES);
		let size = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			size += bytesRead;
			if (size > file.size) return false;
			hash.update(buffer.subarray(0, bytesRead));
		}
		if (size !== file.size) return false;
		hash.update("\0");
		return true;
	} catch {
		return false;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}
