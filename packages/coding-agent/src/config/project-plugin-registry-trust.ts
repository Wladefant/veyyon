import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseInstalledPluginsRegistry } from "@veyyon/kernel/loader/plugins/installed-registry";
import type { ProjectFileSnapshot } from "./project-trust";
import { hashBoundedFolder } from "./bounded-folder-hash";

export const PROJECT_PLUGIN_LIMITS = { maxDepth: 8, maxFiles: 256, maxFileBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 } as const;
const PLUGIN_REGISTRY_HASH_DOMAIN = "veyyon:project-plugin-registry:v1";

/** Snapshot the registry and every payload it names, failing closed on unsafe or incomplete trees. */
export async function describeProjectPluginRegistry(
	registryPath: string,
	canonicalRoot: string,
): Promise<(ProjectFileSnapshot & { resolvedContent: string }) | null> {
	let realRegistryPath: string;
	let bytes: Buffer;
	try {
		realRegistryPath = await fs.realpath(registryPath);
		const registryStat = await fs.stat(realRegistryPath);
		if (!registryStat.isFile()) return null;
		const relativeRegistry = path.relative(canonicalRoot, realRegistryPath);
		if (relativeRegistry === "" || relativeRegistry === ".." || relativeRegistry.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRegistry)) return null;
		bytes = await fs.readFile(realRegistryPath);
	} catch {
		return null;
	}
	// Resolve relative entries from the lexical registry location. Consumers use this same
	// absolute path after the hash gate, so they cannot resolve a different payload from cwd.
	const registryDir = path.dirname(path.resolve(registryPath));
	const registry = parseInstalledPluginsRegistry(bytes.toString("utf8"));
	if (!registry) return null;
	const payloads: Array<{ identity: string; hash: string }> = [];
	for (const entries of Object.values(registry.plugins)) {
		if (!Array.isArray(entries)) return null;
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") return null;
			if (entry.installPath === undefined) continue;
			if (typeof entry.installPath !== "string" || entry.installPath.length === 0) return null;
			const resolved = path.resolve(registryDir, entry.installPath);
			let realPath: string;
			try {
				realPath = await fs.realpath(resolved);
			} catch {
				return null;
			}
			const relativePath = path.relative(canonicalRoot, realPath);
			if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;
			const scan = await hashBoundedFolder(realPath, canonicalRoot, PROJECT_PLUGIN_LIMITS, "veyyon:plugin-payload:v1");
			if (!scan) return null;
			entry.installPath = resolved;
			payloads.push({ identity: `${relativePath.split(path.sep).join("/")}\0${realPath}`, hash: scan.hash });
		}
	}
	payloads.sort((a, b) => a.identity.localeCompare(b.identity));
	const hash = createHash("sha256");
	hash.update(`${PLUGIN_REGISTRY_HASH_DOMAIN}\0`);
	hash.update(`registry:${bytes.length}:`);
	hash.update(bytes);
	hash.update("\0");
	for (const payload of payloads) {
		hash.update(`payload:${Buffer.byteLength(payload.identity)}:${payload.identity}:${payload.hash}\0`);
	}
	const registryRelativePath = path.relative(canonicalRoot, realRegistryPath);
	return {
		absolutePath: path.resolve(registryPath),
		relativePath: registryRelativePath.split(path.sep).join("/"),
		resolvedContent: JSON.stringify(registry),
		hash: hash.digest("hex"),
		content: bytes.toString("utf8"),
	};
}
