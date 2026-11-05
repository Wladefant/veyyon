/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against the artifacts directories of every active
 * session. Unlike agent://, artifacts are raw text with no JSON extraction.
 *
 * URL form:
 * - artifact://<id> - Full artifact content
 * - artifact://<id>?session=<executionSessionId> - Explicit source session
 * - artifact://<id>?session=<executionSessionId>&view=metadata - Availability without content
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import { formatBoundedList } from "@veyyon/utils/format";
import { isEnoent } from "@veyyon/utils/fs-error";
import { AgentRegistry } from "../registry/agent-registry";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Filesystem location for a session artifact, resolved without materializing its content. */
export interface ResolvedArtifactFile {
	id: string;
	path: string;
	size: number;
	sessionId?: string;
}

export class ArtifactResolutionError extends Error {
	constructor(readonly status: "missing" | "ambiguous" | "unavailable", message: string) {
		super(message);
		this.name = "ArtifactResolutionError";
	}
}

function requestedSession(url: InternalUrl): string | undefined {
	const values = url.searchParams.getAll("session");
	if (values.length === 0) return undefined;
	if (values.length !== 1 || !/^[A-Za-z0-9_.:-]{1,128}$/.test(values[0])) {
		throw new Error("artifact:// session must be one valid execution session ID");
	}
	return values[0];
}

/** Select an owner before looking for its numeric artifact; an absent ID never changes owner. */
function artifactScope(url: InternalUrl, context?: ResolveContext): { dirs: string[]; sessionId?: string } {
	const requested = requestedSession(url);
	const caller = context?.localProtocolOptions?.getSessionId?.() ?? undefined;
	const pinned = context?.localProtocolOptions?.getArtifactsDir?.() ?? undefined;
	if (requested === undefined) {
		return { dirs: pinned ? [pinned] : artifactsDirsFromRegistry(), sessionId: pinned ? caller : undefined };
	}
	if (requested === caller && pinned) return { dirs: [pinned], sessionId: requested };
	const dirs = new Set<string>();
	for (const ref of AgentRegistry.global().list()) {
		const manager = ref.session?.sessionManager;
		if (manager?.getSessionId() !== requested) continue;
		const directory = manager.getArtifactsDir();
		if (directory) dirs.add(directory);
	}
	if (dirs.size === 0) {
		throw new ArtifactResolutionError("unavailable", "The source execution session is unavailable; resume its owner to read this artifact");
	}
	if (dirs.size !== 1) {
		throw new ArtifactResolutionError("ambiguous", "The source execution session maps to multiple artifact stores");
	}
	return { dirs: [...dirs], sessionId: requested };
}

function parseArtifactId(url: InternalUrl): string {
	const id = url.rawHost || url.hostname;
	if (!id) {
		throw new Error("artifact:// URL requires a numeric ID: artifact://0");
	}
	if (!/^\d+$/.test(id)) {
		throw new Error(`artifact:// ID must be numeric, got: ${id}`);
	}
	return id;
}

/** Resolve an `artifact://` URL to its backing file without reading artifact bytes. */
export async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const id = parseArtifactId(url);

	const { dirs, sessionId } = artifactScope(url, context);

	if (dirs.length === 0) {
		throw new ArtifactResolutionError("unavailable", "No session - artifacts unavailable");
	}

	const matches: string[] = [];
	let anyDirExists = false;
	const availableIds = new Set<string>();

	for (const dir of dirs) {
		let files: string[];
		try {
			files = await fs.readdir(dir);
			anyDirExists = true;
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		const found = files.filter(f => f.startsWith(`${id}.`));
		if (found.length > 0) {
			matches.push(...found.map(match => path.join(dir, match)));
			continue;
		}
		for (const f of files) {
			const m = f.match(/^(\d+)\./);
			if (m) availableIds.add(m[1]);
		}
	}

	if (!anyDirExists) {
		throw new ArtifactResolutionError("unavailable", "No artifacts directory found");
	}

	// A legacy caller without owner context may scan several stores, but a collision
	// (including duplicate IDs within one store) never picks an enumeration winner.
	if (matches.length > 1) {
		throw new ArtifactResolutionError("ambiguous",
			`Artifact ${id} is ambiguous: ${matches.length} files match the selected owner set. ` +
				`Artifact ids are per-session counters, so the id alone cannot say which one you mean. ` +
				`Use artifact://${id}?session=<execution-session-id> or re-read it from its owner.`,
		);
	}

	const foundPath = matches[0];
	if (!foundPath) {
		const newestFirst = Array.from(availableIds).sort((a, b) => Number(b) - Number(a));
		throw new ArtifactResolutionError("missing", `Artifact ${id} not found in the selected owner. Available: ${formatBoundedList(newestFirst)}`);
	}

	const handle = await fs.open(foundPath, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) {
			throw new ArtifactResolutionError("unavailable", `Artifact ${id} resolved to a directory or special file`);
		}
		return { id, path: foundPath, size: stat.size, sessionId };
	} finally {
		await handle.close();
	}
}

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const views = url.searchParams.getAll("view");
		if (views.length > 1 || (views.length === 1 && views[0] !== "metadata")) {
			throw new Error("artifact:// view must be metadata when provided");
		}
		if (views[0] === "metadata") {
			const id = parseArtifactId(url);
			const sessionId = requestedSession(url) ?? context?.localProtocolOptions?.getSessionId?.() ?? null;
			let metadata: object;
			try {
				const artifact = await resolveArtifactFile(url, context);
				metadata = { version: 1, status: "available", id, sessionId: artifact.sessionId ?? null,
					size: artifact.size, inlineAvailable: artifact.size <= MAX_INLINE_ARTIFACT_BYTES };
			} catch (error) {
				if (error instanceof ArtifactResolutionError) {
					metadata = { version: 1, status: error.status, id, sessionId, detail: error.message };
				} else if (error instanceof Error && "code" in error) {
					metadata = { version: 1, status: "unavailable", id, sessionId, detail: "Artifact storage could not be inspected" };
				} else throw error;
			}
			const content = JSON.stringify(metadata, null, 2);
			return { url: url.href, content, contentType: "application/json", size: Buffer.byteLength(content, "utf8") };
		}
		const artifact = await resolveArtifactFile(url, context);

		// Path-only callers (search/grep, bash URL expansion) never touch the
		// artifact bytes. Return the resource shape so those flows keep working
		// on artifacts of any size — only content materialization is gated.
		if (context?.pathOnly) {
			return {
				url: url.href,
				content: "",
				contentType: "text/plain",
				size: artifact.size,
				sourcePath: artifact.path,
			};
		}

		if (artifact.size > MAX_INLINE_ARTIFACT_BYTES) {
			throw new Error(
				`Artifact ${artifact.id} is ${artifact.size} bytes; full internal resolution is blocked. Use read selectors such as ${url.href}:1-3000 or ${url.href}:raw:1-3000, and use the artifact file path for search/copy workflows: ${artifact.path}`,
			);
		}

		const content = await Bun.file(artifact.path).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: artifact.size,
			sourcePath: artifact.path,
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const name of await artifactFileNamesFromRegistry()) {
			const m = name.match(/^(\d+)\./);
			if (m) ids.add(m[1]!);
		}
		return Array.from(ids)
			.sort((a, b) => Number(a) - Number(b))
			.map(value => ({ value }));
	}
}

