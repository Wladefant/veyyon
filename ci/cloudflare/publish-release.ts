#!/usr/bin/env bun
/**
 * Publishes the Cloudflare-built distribution as a GitHub Release, over the REST API only.
 *
 * One Cloudflare build cannot hold the whole distribution (20 minute limit, small disk), so the
 * release is assembled by several builds that share one DRAFT release:
 *
 *   upload    A part build (windows, linux-x64, linux-arm64) uploads the manifest assets it
 *             produced into the draft of VEYYON_RELEASE_TAG, creating the draft when absent.
 *   finalize  A last build proves the draft holds exactly the manifest (names, sizes, GitHub
 *             sha256 digests against the checksum sidecars), publishes it, then runs the repo's
 *             own `scripts/release.ts verify-assets <tag>` against the public release. A failure
 *             there puts the release back to draft and fails the build.
 *
 * Environment:
 *   VEYYON_RELEASE_TOKEN       required. Fine-grained token: contents:write on this repository only.
 *   VEYYON_RELEASE_TAG         required. A published release of the tag is never touched.
 *   VEYYON_RELEASE_SHA         required. 40-hex commit; every part must agree on it.
 *   VEYYON_RELEASE_PRERELEASE  "1" marks the release as a pre-release (default "0").
 *   VEYYON_RELEASE_PUBLISH     finalize only: "1" publishes after verification, else the draft stays.
 *   VEYYON_RELEASE_REPO        default Wladefant/veyyon.
 * The token is read once and never printed.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertPublishedReleaseAssets, REQUIRED_RELEASE_ASSET_NAMES } from "../../scripts/release-policy";

const repoRoot = join(import.meta.dir, "..", "..");
const binariesDir = join(repoRoot, "packages", "coding-agent", "binaries");

const command = process.argv[2];
if (command !== "upload" && command !== "finalize") throw new Error("Usage: publish-release.ts upload|finalize");

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
	body: string | null;
	upload_url: string;
	assets: ReleaseAsset[];
}

const base = `https://api.github.com/repos/${repo}`;
const releaseBody = `Built on Cloudflare Workers Builds from ${sha}.`;

async function api(method: string, url: string, body?: unknown, raw?: Uint8Array): Promise<Response> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "veyyon-cf-release",
	};
	let payload: BodyInit | undefined;
	if (raw) {
		headers["Content-Type"] = "application/octet-stream";
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

/** Releases of the repo carrying this tag, drafts included (drafts are invisible to the by-tag endpoint). */
async function releasesForTag(): Promise<Release[]> {
	const found: Release[] = [];
	for (let page = 1; page <= 10; page++) {
		const batch = await json<Release[]>(await api("GET", `${base}/releases?per_page=100&page=${page}`), "list releases");
		found.push(...batch.filter(release => release.tag_name === tag));
		if (batch.length < 100) break;
	}
	return found;
}

/** The one draft of the tag; creates it when absent. A published release or a draft of another commit aborts. */
async function ensureDraft(): Promise<Release> {
	const existing = await releasesForTag();
	const published = existing.find(release => !release.draft);
	if (published) throw new Error(`release ${tag} is already published; refusing to touch it`);
	const drafts = existing.sort((a, b) => a.id - b.id);
	let draft = drafts[0];
	if (!draft) {
		draft = await json<Release>(
			await api("POST", `${base}/releases`, {
				tag_name: tag,
				target_commitish: sha,
				name: tag,
				draft: true,
				prerelease,
				generate_release_notes: false,
				body: releaseBody,
			}),
			"create draft release",
		);
		console.log(`Created draft release ${draft.id} for ${tag}.`);
		// Two parts can create at the same moment: the lowest id is the shared draft, the other one is removed.
		const after = (await releasesForTag()).sort((a, b) => a.id - b.id);
		if (after[0] && after[0].id !== draft.id) {
			await api("DELETE", `${base}/releases/${draft.id}`);
			draft = after[0];
			console.log(`Another part created the draft first; using ${draft.id}.`);
		}
	}
	if (draft.body !== releaseBody) throw new Error(`draft ${draft.id} belongs to another commit; delete it and rebuild`);
	return draft;
}

async function sha256OfAsset(asset: ReleaseAsset): Promise<string> {
	return createHash("sha256").update(await downloadAsset(asset)).digest("hex");
}

if (command === "upload") {
	const localNames = new Set(readdirSync(binariesDir));
	const names = REQUIRED_RELEASE_ASSET_NAMES.filter(name => localNames.has(name));
	if (names.length === 0) throw new Error("no manifest assets found in the local distribution");
	for (const name of names) {
		if (name.endsWith(".sha256")) continue;
		if (!names.includes(`${name}.sha256`)) throw new Error(`${name} has no checksum sidecar`);
		const digest = createHash("sha256").update(readFileSync(join(binariesDir, name))).digest("hex");
		const sidecar = readFileSync(join(binariesDir, `${name}.sha256`), "utf8").trim().split(/\s+/)[0];
		if (sidecar !== digest) throw new Error(`checksum sidecar for ${name} does not match its file`);
	}
	const draft = await ensureDraft();
	const uploadBase = draft.upload_url.replace(/\{.*$/, "");
	for (const name of names) {
		const bytes = readFileSync(join(binariesDir, name));
		const size = statSync(join(binariesDir, name)).size;
		await withRetry(`upload ${name}`, 3, async () => {
			const current = await json<Release>(await api("GET", `${base}/releases/${draft.id}`), "read draft");
			const stale = current.assets.find(asset => asset.name === name);
			if (stale) await api("DELETE", `${base}/releases/assets/${stale.id}`);
			const asset = await json<ReleaseAsset>(
				await api("POST", `${uploadBase}?name=${encodeURIComponent(name)}`, undefined, bytes),
				`upload ${name}`,
			);
			if (asset.size !== size) throw new Error(`${name}: uploaded ${asset.size} bytes, expected ${size}`);
		});
		console.log(`Uploaded ${name} (${size} bytes).`);
	}
	console.log(`PART_UPLOADED: ${names.length} assets on draft ${draft.id} for ${tag}.`);
	process.exit(0);
}

// finalize
const drafts = (await releasesForTag()).filter(release => release.draft);
if (drafts.length !== 1) throw new Error(`expected exactly one draft for ${tag}, found ${drafts.length}`);
const draft = await json<Release>(await api("GET", `${base}/releases/${drafts[0].id}`), "read draft");
if (draft.body !== releaseBody) throw new Error(`draft ${draft.id} belongs to another commit`);
assertPublishedReleaseAssets(draft.assets.map(asset => asset.name));
const byName = new Map(draft.assets.map(asset => [asset.name, asset] as const));
for (const asset of draft.assets) {
	if (asset.state !== "uploaded") throw new Error(`${asset.name} is in state ${asset.state}`);
	if (asset.name.endsWith(".sha256")) continue;
	const sidecar = byName.get(`${asset.name}.sha256`);
	if (!sidecar) throw new Error(`${asset.name} has no checksum sidecar`);
	const expected = new TextDecoder().decode(await downloadAsset(sidecar)).trim().split(/\s+/)[0];
	const actual = asset.digest ? asset.digest.replace(/^sha256:/, "") : await sha256OfAsset(asset);
	if (actual !== expected) throw new Error(`${asset.name}: GitHub digest ${actual} differs from its sidecar ${expected}`);
}
console.log(`DRAFT_VERIFIED: ${draft.assets.length} assets match the manifest and their sidecars on draft ${draft.id}.`);

if (!publish) {
	console.log(`RELEASE_DRAFT_READY: ${tag} left as a draft (VEYYON_RELEASE_PUBLISH is not 1).`);
	process.exit(0);
}

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

/** Raw bytes of a release asset. GitHub answers with a redirect to storage, which must not receive the token. */
async function downloadAsset(asset: ReleaseAsset): Promise<Uint8Array> {
	const first = await fetch(`${base}/releases/assets/${asset.id}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream", "User-Agent": "veyyon-cf-release" },
		redirect: "manual",
		signal: AbortSignal.timeout(120_000),
	});
	const location = first.headers.get("location");
	const res = location ? await fetch(location, { signal: AbortSignal.timeout(120_000) }) : first;
	if (!res.ok) throw new Error(`download ${asset.name} failed: HTTP ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}
