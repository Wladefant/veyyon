#!/usr/bin/env bun
/**
 * Publishes the Cloudflare-built distribution as a GitHub Release, over the REST API only.
 *
 * Order is the safety property: create a DRAFT, upload every manifest asset, prove the draft
 * carries exactly the manifest (names, sizes, sha256 digests), and only then publish. After
 * publication the repo's own `scripts/release.ts verify-assets <tag>` runs against the public
 * release; a failure there puts the release back to draft and fails the build.
 *
 * Inputs (environment):
 *   VEYYON_RELEASE_TOKEN     required. Fine-grained token: contents:write on this repository only.
 *   VEYYON_RELEASE_TAG       required. A re-run replaces an existing DRAFT of the tag; a published
 *                            release of the tag is never touched.
 *   VEYYON_RELEASE_SHA       required. 40-hex commit the release is cut from.
 *   VEYYON_RELEASE_PRERELEASE  "1" marks the release as a pre-release (default "0").
 *   VEYYON_RELEASE_PUBLISH   "1" publishes after verification; otherwise the draft is left in place.
 *   VEYYON_RELEASE_REPO      default Wladefant/veyyon.
 * The token is read once and never printed.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertPublishedReleaseAssets, REQUIRED_RELEASE_ASSET_NAMES } from "../../scripts/release-policy";

const repoRoot = join(import.meta.dir, "..", "..");
const binariesDir = join(repoRoot, "packages", "coding-agent", "binaries");

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const token = requireEnv("VEYYON_RELEASE_TOKEN");
const tag = requireEnv("VEYYON_RELEASE_TAG");
const sha = requireEnv("VEYYON_RELEASE_SHA");
const repo = process.env.VEYYON_RELEASE_REPO?.trim() || "Wladefant/veyyon";
const prerelease = process.env.VEYYON_RELEASE_PRERELEASE === "1";
const publish = process.env.VEYYON_RELEASE_PUBLISH === "1";
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("VEYYON_RELEASE_SHA must be 40 hex characters");
if (!/^[A-Za-z0-9._-]+$/.test(tag)) throw new Error(`release tag ${JSON.stringify(tag)} has unsupported characters`);

interface ReleaseAsset {
	id: number;
	name: string;
	size: number;
	state: string;
	digest?: string | null;
}
interface Release {
	id: number;
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	upload_url: string;
	assets: ReleaseAsset[];
}

async function api(method: string, url: string, body?: unknown, raw?: Uint8Array, contentType?: string): Promise<Response> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "veyyon-cf-release",
	};
	let payload: BodyInit | undefined;
	if (raw) {
		headers["Content-Type"] = contentType ?? "application/octet-stream";
		payload = raw;
	} else if (body !== undefined) {
		headers["Content-Type"] = "application/json";
		payload = JSON.stringify(body);
	}
	return fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(300_000) });
}

async function json<T>(res: Response, what: string): Promise<T> {
	if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
	return (await res.json()) as T;
}

async function withRetry<T>(what: string, attempts: number, fn: () => Promise<T>): Promise<T> {
	let last: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			last = error;
			console.error(`${what}: attempt ${attempt}/${attempts} failed: ${error instanceof Error ? error.message : error}`);
			if (attempt < attempts) await Bun.sleep(attempt * 3000);
		}
	}
	throw last;
}

const base = `https://api.github.com/repos/${repo}`;

/** Every release of the repo, drafts included (drafts are invisible to the by-tag endpoint). */
async function allReleases(): Promise<Release[]> {
	const found: Release[] = [];
	for (let page = 1; page <= 10; page++) {
		const batch = await json<Release[]>(await api("GET", `${base}/releases?per_page=100&page=${page}`), "list releases");
		found.push(...batch);
		if (batch.length < 100) break;
	}
	return found;
}

// 1. Local files: exactly the manifest, nothing else is uploaded.
const localNames = new Set(readdirSync(binariesDir));
const missingLocal = REQUIRED_RELEASE_ASSET_NAMES.filter(name => !localNames.has(name));
if (missingLocal.length > 0) throw new Error(`local distribution is incomplete: ${missingLocal.join(", ")}`);
const localDigests = new Map<string, string>();
for (const name of REQUIRED_RELEASE_ASSET_NAMES) {
	localDigests.set(name, createHash("sha256").update(readFileSync(join(binariesDir, name))).digest("hex"));
}
for (const name of REQUIRED_RELEASE_ASSET_NAMES) {
	if (name.endsWith(".sha256")) continue;
	const sidecar = readFileSync(join(binariesDir, `${name}.sha256`), "utf8").trim().split(/\s+/)[0];
	if (sidecar !== localDigests.get(name)) throw new Error(`checksum sidecar for ${name} does not match its file`);
}
console.log(`Local distribution holds all ${REQUIRED_RELEASE_ASSET_NAMES.length} manifest assets.`);

// 2. Draft: refuse a published tag, replace a stale draft of ours.
for (const existing of await allReleases()) {
	if (existing.tag_name !== tag) continue;
	if (!existing.draft) throw new Error(`release ${tag} is already published; refusing to touch it`);
	await withRetry(`delete stale draft ${existing.id}`, 3, async () => {
		const res = await api("DELETE", `${base}/releases/${existing.id}`);
		if (res.status !== 204) throw new Error(`HTTP ${res.status}`);
	});
	console.log(`Replaced stale draft release ${existing.id} for ${tag}.`);
}
const draft = await json<Release>(
	await api("POST", `${base}/releases`, {
		tag_name: tag,
		target_commitish: sha,
		name: tag,
		draft: true,
		prerelease,
		generate_release_notes: false,
		body: `Built on Cloudflare Workers Builds from ${sha}.`,
	}),
	"create draft release",
);
console.log(`Created draft release ${draft.id} for ${tag}.`);

// 3. Upload.
const uploadBase = draft.upload_url.replace(/\{.*$/, "");
for (const name of REQUIRED_RELEASE_ASSET_NAMES) {
	const bytes = readFileSync(join(binariesDir, name));
	const size = statSync(join(binariesDir, name)).size;
	await withRetry(`upload ${name}`, 3, async () => {
		const current = await json<Release>(await api("GET", `${base}/releases/${draft.id}`), "read draft");
		const partial = current.assets.find(asset => asset.name === name);
		if (partial) await api("DELETE", `${base}/releases/assets/${partial.id}`);
		const asset = await json<ReleaseAsset>(
			await api("POST", `${uploadBase}?name=${encodeURIComponent(name)}`, undefined, bytes),
			`upload ${name}`,
		);
		if (asset.size !== size) throw new Error(`${name}: uploaded ${asset.size} bytes, expected ${size}`);
	});
	console.log(`Uploaded ${name} (${size} bytes).`);
}

// 4. Verify the draft carries exactly the manifest, with matching sizes and digests.
const verified = await json<Release>(await api("GET", `${base}/releases/${draft.id}`), "read draft for verification");
assertPublishedReleaseAssets(verified.assets.map(asset => asset.name));
for (const asset of verified.assets) {
	if (asset.state !== "uploaded") throw new Error(`${asset.name} is in state ${asset.state}`);
	if (asset.size !== statSync(join(binariesDir, asset.name)).size) throw new Error(`${asset.name} size differs from local`);
	if (asset.digest && asset.digest !== `sha256:${localDigests.get(asset.name)}`) {
		throw new Error(`${asset.name} digest on GitHub differs from the local build`);
	}
}
console.log(`DRAFT_VERIFIED: ${verified.assets.length} assets match the manifest on draft ${draft.id}.`);

if (!publish) {
	console.log(`RELEASE_DRAFT_READY: ${tag} left as a draft (VEYYON_RELEASE_PUBLISH is not 1).`);
	process.exit(0);
}

// 5. Publish, then run the repo's own verify-assets against the public release.
await json<Release>(await api("PATCH", `${base}/releases/${draft.id}`, { draft: false, prerelease }), "publish release");
console.log(`Published release ${tag}.`);
const proc = Bun.spawn(["bun", "scripts/release.ts", "verify-assets", tag], {
	cwd: repoRoot,
	env: { ...process.env, GH_TOKEN: token, GH_REPO: repo },
	stdout: "inherit",
	stderr: "inherit",
});
if ((await proc.exited) !== 0) {
	await api("PATCH", `${base}/releases/${draft.id}`, { draft: true });
	throw new Error(`verify-assets failed for ${tag}; release returned to draft`);
}
console.log(`VERIFY_ASSETS_PASSED: ${tag}`);
