import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@veyyon/utils/fs-error";
import type { InternalResource } from "./types";

/**
 * True when `targetPath` is `rootPath` itself or a descendant of it. This is the
 * single owner of the internal-URL root-containment predicate, shared by the
 * `local://`, `vault://`, `memory://`, and `skill://` handlers so their escape
 * checks cannot drift apart. Paths are compared verbatim: resolve them with
 * `path.resolve` first if they may be relative or contain `..` segments.
 */
export function isWithinRoot(targetPath: string, rootPath: string): boolean {
	return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

/**
 * Throw a scheme-specific "escapes root" error when `targetPath` is not within
 * `rootPath`. `scheme` is the URL scheme label (e.g. "local"), producing the
 * message `"<scheme>:// URL escapes <scheme> root"`.
 */
export function ensureWithinRoot(targetPath: string, rootPath: string, scheme: string): void {
	if (!isWithinRoot(targetPath, rootPath)) {
		throw new Error(`${scheme}:// URL escapes ${scheme} root`);
	}
}

/**
 * The real path of `targetPath` under `resolvedRoot`, itself a real path. The target, the real
 * path of its parent and its own real path must each lie within the root, so neither a `..`
 * segment nor a symlinked file or directory reaches outside it; an escape throws the scheme's
 * {@link ensureWithinRoot} error. Returns null when the target does not exist.
 */
export async function realPathWithinRoot(
	targetPath: string,
	resolvedRoot: string,
	scheme: string,
): Promise<string | null> {
	ensureWithinRoot(targetPath, resolvedRoot, scheme);
	try {
		ensureWithinRoot(await fs.realpath(path.dirname(targetPath)), resolvedRoot, scheme);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	let realTargetPath: string;
	try {
		realTargetPath = await fs.realpath(targetPath);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	ensureWithinRoot(realTargetPath, resolvedRoot, scheme);
	return realTargetPath;
}

/**
 * Builds a text resource for a filesystem directory resolved by an internal URL handler.
 *
 * The resource is flagged immutable so the read tool never mints hashline edit
 * anchors against a directory listing — only file resources from the same
 * handler stay editable.
 */
export async function buildDirectoryResource(
	url: string,
	directoryPath: string,
	notes?: string[],
): Promise<InternalResource> {
	const entries = await fs.readdir(directoryPath, { withFileTypes: true });
	entries.sort((a, b) => {
		const directoryOrder = Number(b.isDirectory()) - Number(a.isDirectory());
		return directoryOrder || a.name.localeCompare(b.name);
	});
	const content =
		entries.length === 0
			? "(empty directory)"
			: entries.map(e => `${e.name}${e.isDirectory() ? "/" : ""}`).join("\n");
	return {
		url,
		content,
		contentType: "text/plain",
		size: Buffer.byteLength(content, "utf-8"),
		sourcePath: directoryPath,
		immutable: true,
		...(notes ? { notes } : {}),
	};
}
