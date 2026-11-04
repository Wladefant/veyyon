import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ProtectedCredentialResource {
	owner: string;
	canonicalPath: string;
	kind: "credential" | "sensitive" | "metadata" | "source" | "documentation";
}

const MAX_RESOURCES = 20_000;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const SENSITIVE_CLASSIFICATIONS: Record<string, true | undefined> = {
	credential: true, sensitive_data_artifact: true, credential_or_sensitive_artifact: true, sensitive_snapshot: true,
};

function pathKey(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Reads metadata only. Referenced credential files are never opened by the adapter. */
export async function loadProtectedCredentialMetadata(indexPath: string): Promise<ProtectedCredentialResource[]> {
	const stat = await fs.stat(indexPath);
	if (stat.size > MAX_INDEX_BYTES) throw new Error("Credential resource metadata exceeds its size bound.");
	const data: unknown = JSON.parse(await fs.readFile(indexPath, "utf8"));
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid credential resource metadata.");
	const index = data as Record<string, unknown>;
	const root = typeof index.index_root === "string" ? index.index_root : path.dirname(indexPath);
	const resources: ProtectedCredentialResource[] = [];
	const add = (candidate: unknown, topLevel = false): void => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return;
		const row = candidate as Record<string, unknown>;
		if (typeof row.file !== "string") return;
		const classified = typeof row.classification === "string" && SENSITIVE_CLASSIFICATIONS[row.classification] === true;
		const credentialProvenance = topLevel &&
			(typeof row.bitwarden_item_id === "string" || typeof row.token_name === "string");
		if (!classified && !credentialProvenance) return;
		resources.push({ owner: indexPath, canonicalPath: path.resolve(root, row.file), kind: "credential" });
		if (resources.length > MAX_RESOURCES) throw new Error("Too many protected credential resources.");
	};
	if (Array.isArray(index.entries)) for (const row of index.entries) add(row);
	for (const row of Object.values(index)) add(row, true);
	return resources;
}

/** Only agent reads use this policy. Trusted credential consumers keep their direct filesystem access. */
export async function createProtectedCredentialReadPolicy(
	resources: readonly ProtectedCredentialResource[],
	metadataIndexes: readonly string[] = [],
): Promise<(file: string) => Promise<void>> {
	if (resources.length + metadataIndexes.length > MAX_RESOURCES) throw new Error("Too many protected credential resources.");
	const all = [...resources];
	for (const index of metadataIndexes) all.push(...await loadProtectedCredentialMetadata(index));
	if (all.length > MAX_RESOURCES) throw new Error("Too many protected credential resources.");
	const blocked = new Set<string>();
	for (const resource of all) {
		if (resource.kind !== "credential" && resource.kind !== "sensitive") continue;
		blocked.add(pathKey(resource.canonicalPath));
		try { blocked.add(pathKey(await fs.realpath(resource.canonicalPath))); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	for (const index of metadataIndexes) {
		blocked.delete(pathKey(index));
		try { blocked.delete(pathKey(await fs.realpath(index))); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return async file => {
		let canonical = pathKey(file);
		if (!blocked.has(canonical)) {
			try { canonical = pathKey(await fs.realpath(file)); } catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (blocked.has(canonical)) throw new Error("Plain reads of a protected credential resource are not allowed. Use its metadata or a trusted credential consumer.");
	};
}
