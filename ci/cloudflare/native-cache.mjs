#!/usr/bin/env bun

/**
 * Bounded R2 native artifact cache for Cloudflare Workers CI.
 *
 * Uses Bun.S3Client presigned GET/PUT with streaming file transfer
 * to fetch or populate native build artifacts based on content-addressed SHA256 key.
 * Stores 3 R2 objects under trusted/<hash>/:
 * - baseline.node
 * - modern.node
 * - manifest.json
 */

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Pinned / default configuration
export const DEFAULT_ACCOUNT_ID = "a0d288d1c95470cd009cc6e0df7accb7";
export const EXPECTED_ENDPOINT = "a0d288d1c95470cd009cc6e0df7accb7.r2.cloudflarestorage.com";
export const EXPECTED_BUCKET = "ci-artifacts-cache";
export const DEFAULT_PLATFORM = "linux";
export const DEFAULT_ARCH = "x64";
export const DEFAULT_CROSS_TARGET = "x86_64-unknown-linux-gnu.2.17";
export const DEFAULT_VARIANTS = "baseline modern";
export const DEFAULT_ZIG_VERSION = "0.16.0";
export const DEFAULT_RUST_TOOLCHAIN = "nightly-2026-04-29";
export const DEFAULT_FETCH_TIMEOUT_MS = 60000;

export const CANONICAL_ADDON_FILES = Object.assign(
	[
		"natives/bridge/bindings/native/veyyon_natives.linux-x64-baseline.node",
		"natives/bridge/bindings/native/veyyon_natives.linux-x64-modern.node",
	],
	{
		baseline: "natives/bridge/bindings/native/veyyon_natives.linux-x64-baseline.node",
		modern: "natives/bridge/bindings/native/veyyon_natives.linux-x64-modern.node",
	},
);

export function getTrustedR2Key(key) {
	if (!key || typeof key !== "string") return "trusted/";
	return key.startsWith("trusted/") ? key : `trusted/${key}`;
}

export function validateWriterBranchGuard(env = process.env, options = {}) {
	const branch = options.branch || env.WORKERS_CI_BRANCH;
	if (branch !== "main") {
		throw new Error(
			`Native cache writer rejected: WORKERS_CI_BRANCH must be "main" (current: "${branch || "unset"}"). Writer cannot run on PR branch.`,
		);
	}
}

export function validateEnvironmentConfig(env = process.env, options = {}) {
	const writeMode = Boolean(options.writeMode || options === true);
	const credsVar = writeMode
		? "VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS"
		: "VEYYON_NATIVE_CACHE_CREDENTIALS";

	const missing = [];
	if (!env[credsVar]) missing.push(credsVar);
	if (!env.VEYYON_NATIVE_CACHE_BUCKET) missing.push("VEYYON_NATIVE_CACHE_BUCKET");
	if (missing.length > 0) {
		throw new Error(
			`Missing required native cache configuration: ${missing.join(", ")}. Provide ${credsVar} and VEYYON_NATIVE_CACHE_BUCKET.`,
		);
	}

	const bucket = String(env.VEYYON_NATIVE_CACHE_BUCKET).trim();
	if (bucket !== EXPECTED_BUCKET) {
		throw new Error(`Invalid native cache bucket: expected "${EXPECTED_BUCKET}", got "${bucket}".`);
	}

	let creds;
	try {
		creds = typeof env[credsVar] === "object" && env[credsVar] !== null
			? env[credsVar]
			: JSON.parse(env[credsVar]);
	} catch {
		throw new Error(`Malformed ${credsVar}: must be valid JSON.`);
	}
	if (!creds || typeof creds !== "object") throw new Error(`Malformed ${credsVar}: must be a JSON object.`);

	const missingKeys = ["accessKeyId", "secretAccessKey", "endpoint"].filter(k => !creds[k]?.trim?.());
	if (missingKeys.length > 0) {
		throw new Error(`Malformed ${credsVar}: missing or empty required keys (${missingKeys.join(", ")}).`);
	}

	let endpointHost;
	try {
		const raw = creds.endpoint.trim();
		endpointHost = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
	} catch {
		throw new Error(`Malformed ${credsVar}: endpoint is not a valid URL or hostname.`);
	}

	if (endpointHost !== EXPECTED_ENDPOINT) {
		throw new Error(`Invalid native cache endpoint: expected "${EXPECTED_ENDPOINT}", got "${endpointHost}".`);
	}

	return {
		accessKeyId: creds.accessKeyId.trim(),
		secretAccessKey: creds.secretAccessKey.trim(),
		endpoint: `https://${EXPECTED_ENDPOINT}`,
		bucket: EXPECTED_BUCKET,
		credentials: {
			accessKeyId: creds.accessKeyId.trim(),
			secretAccessKey: creds.secretAccessKey.trim(),
			endpoint: `https://${EXPECTED_ENDPOINT}`,
		},
		writeMode,
	};
}

export function redactSecrets(text, secrets = []) {
	if (!text) return "";
	let str = String(text);
	const toMask = Array.isArray(secrets) ? secrets : [secrets];
	for (const s of toMask) {
		if (s && typeof s === "string") str = str.replaceAll(s, "[REDACTED]");
	}
	return str
		.replace(/[?&]X-Amz-[^&\s"']+/gi, "[REDACTED_SIG]")
		.replace(/("secretAccessKey"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2')
		.replace(/("accessKeyId"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

export function classifyR2Error(error, stdout = "", stderr = "") {
	const status = error?.status ?? error?.statusCode;
	if (status === 404) return { isAuth: false, isMiss: true, isNetwork: false, message: "Object not found (404)" };
	if (status === 401 || status === 403) return { isAuth: true, isMiss: false, isNetwork: false, message: `Authentication/authorization failed (${status})` };
	if (status >= 500 && status <= 599) return { isAuth: false, isMiss: false, isNetwork: true, message: `Server error (${status})` };

	const combined = `${error?.message || ""} ${stdout} ${stderr}`;
	if (/401|403|unauthorized|access\s*denied|forbidden|invalid\s+token|invalid\s+signature/i.test(combined)) {
		return { isAuth: true, isMiss: false, isNetwork: false, message: "Authentication/authorization failed" };
	}
	if (/404|NoSuchKey|does\s+not\s+exist|not\s+found/i.test(combined)) {
		return { isAuth: false, isMiss: true, isNetwork: false, message: "Object not found (404)" };
	}
	return { isAuth: false, isMiss: false, isNetwork: true, message: combined.trim() || "Network/server connection failed" };
}

export function listTrackedNativeFiles(repoRoot) {
	try {
		const gitCmd = process.platform === "win32" ? "git.exe" : "git";
		const res = child_process.spawnSync(gitCmd, ["ls-files", "natives"], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 10000,
			windowsHide: true,
		});
		if (res.status === 0 && res.stdout.trim()) {
			return res.stdout.trim().split(/\r?\n/).map(p => p.trim().replace(/\\/g, "/")).filter(Boolean).sort();
		}
	} catch {}

	const nativesDir = path.join(repoRoot, "natives");
	return fs.existsSync(nativesDir) ? walkDir(nativesDir, repoRoot) : [];
}

function walkDir(dir, repoRoot) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "target" && entry.name !== ".git") {
			out.push(...walkDir(full, repoRoot));
		} else if (entry.isFile()) {
			out.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
		}
	}
	return out.sort();
}

function canonicalStringify(val) {
	if (val === null || typeof val !== "object") return JSON.stringify(val);
	if (Array.isArray(val)) return `[${val.map(canonicalStringify).join(",")}]`;
	const keys = Object.keys(val).sort();
	return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(val[k])}`).join(",")}}`;
}

export function computeCacheKey(options = {}) {
	const repoRoot = options.repoRoot || process.cwd();
	const env = options.env || process.env;

	const parameters = {
		crossTarget: options.parameters?.crossTarget || env.CROSS_TARGET || DEFAULT_CROSS_TARGET,
		rustToolchain: options.parameters?.rustToolchain || env.RUST_TOOLCHAIN || DEFAULT_RUST_TOOLCHAIN,
		targetArch: options.parameters?.targetArch || env.TARGET_ARCH || DEFAULT_ARCH,
		targetPlatform: options.parameters?.targetPlatform || env.TARGET_PLATFORM || DEFAULT_PLATFORM,
		zigVersion: options.parameters?.zigVersion || env.ZIG_VERSION || DEFAULT_ZIG_VERSION,
	};

	const packageVersions = { ...options.packageVersions };
	if (!packageVersions.root) {
		try {
			packageVersions.root = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version || "0.0.0";
		} catch {
			packageVersions.root = "0.0.0";
		}
	}
	if (!packageVersions.native) {
		try {
			packageVersions.native = JSON.parse(
				fs.readFileSync(path.join(repoRoot, "natives/bridge/bindings/package.json"), "utf8"),
			).version || "0.0.0";
		} catch {
			packageVersions.native = "0.0.0";
		}
	}

	const trackedFiles = options.trackedFiles || listTrackedNativeFiles(repoRoot);
	const configFiles = options.configFiles || [
		"Cargo.toml",
		"Cargo.lock",
		"rust-toolchain.toml",
		".cargo/config",
		".cargo/config.toml",
	];
	const buildScripts = options.buildScripts || [
		"scripts/ci-build-native.ts",
		"natives/bridge/bindings/scripts/build-native.ts",
		"natives/bridge/bindings/scripts/embed-native.ts",
		"natives/bridge/bindings/scripts/native-portability.ts",
		"natives/bridge/bindings/scripts/embedded-metadata.ts",
		"natives/bridge/bindings/scripts/gen-enums.ts",
		"natives/bridge/bindings/scripts/ensure-native.ts",
	];

	const fileHasher = options.fileHasher || (relPath => {
		try {
			return crypto.createHash("sha256").update(fs.readFileSync(path.join(repoRoot, relPath))).digest("hex");
		} catch {
			return null;
		}
	});

	const fileHashes = {};
	const allFiles = Array.from(new Set([...trackedFiles, ...configFiles, ...buildScripts])).sort();
	for (const rel of allFiles) {
		const h = fileHasher(rel);
		if (h) fileHashes[rel] = h;
	}

	const composite = { fileHashes, packageVersions, parameters };
	const hash = crypto.createHash("sha256").update(canonicalStringify(composite)).digest("hex");
	return { hash, key: `trusted/${hash}`, composite };
}

export function validateManifest(manifestInput, expectedHash) {
	let manifest;
	try {
		manifest = typeof manifestInput === "string" ? JSON.parse(manifestInput) : manifestInput;
	} catch (err) {
		throw new Error(`Invalid manifest JSON: ${err.message}`);
	}
	if (!manifest || typeof manifest !== "object") throw new Error("Manifest must be a non-null JSON object");

	const expectedClean = expectedHash.replace(/^trusted\//, "");
	const manifestClean = (manifest.hash || manifest.key || "").replace(/^trusted\//, "");
	if (manifestClean !== expectedClean) {
		throw new Error(`Manifest hash mismatch: expected "${expectedClean}", got "${manifestClean}"`);
	}
	if (!manifest.files || typeof manifest.files !== "object") {
		throw new Error("Manifest must contain a 'files' object");
	}

	for (const expected of ["baseline.node", "modern.node"]) {
		const entry = manifest.files[expected];
		if (!entry) throw new Error(`Manifest missing entry for canonical file: ${expected}`);
		if (!entry.sha256 || typeof entry.sha256 !== "string" || entry.sha256.length !== 64) {
			throw new Error(`Manifest entry for ${expected} has invalid sha256 hash`);
		}
		if (typeof entry.size !== "number" || entry.size <= 0) {
			throw new Error(`Manifest entry for ${expected} has invalid size: ${entry.size}`);
		}
	}
	return manifest;
}

export function createS3Client(config, options = {}) {
	if (options.s3Client) return options.s3Client;
	const Client = options.S3Client || globalThis.Bun?.S3Client;
	if (!Client) throw new Error("Bun.S3Client is required for native cache S3 operations.");
	return new Client({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		bucket: config.bucket || EXPECTED_BUCKET,
		endpoint: config.endpoint || `https://${EXPECTED_ENDPOINT}`,
		region: "auto",
	});
}

export function presignUrl(s3Client, key, options = {}) {
	if (typeof s3Client.presign === "function") return s3Client.presign(key, options);
	if (typeof s3Client.file === "function") {
		const file = s3Client.file(key);
		if (typeof file.presign === "function") return file.presign(options);
	}
	throw new Error("S3Client does not support presign operation");
}

async function streamToFile(res, destPath) {
	if (typeof Bun !== "undefined" && typeof Bun.write === "function") {
		await Bun.write(destPath, res);
	} else if (res.body && typeof res.body.getReader === "function") {
		const { Readable } = await import("node:stream");
		const stream = Readable.fromWeb(res.body);
		await new Promise((resolve, reject) => {
			const out = fs.createWriteStream(destPath);
			stream.pipe(out);
			out.on("finish", resolve);
			out.on("error", reject);
		});
	} else {
		fs.writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
	}
}

function getUploadPayload(filePath) {
	return typeof Bun !== "undefined" && typeof Bun.file === "function"
		? Bun.file(filePath)
		: fs.readFileSync(filePath);
}

export async function buildArtifacts(repoRoot, options = {}) {
	const targetVariants = options.targetVariants || "baseline modern";
	const buildRunner = options.buildRunner || (() => {
		const bunCmd = process.env.BUN_BIN || "bun";
		const buildEnv = {
			...process.env,
			CROSS_TARGET: options.crossTarget || process.env.CROSS_TARGET || DEFAULT_CROSS_TARGET,
			TARGET_ARCH: options.targetArch || process.env.TARGET_ARCH || DEFAULT_ARCH,
			TARGET_PLATFORM: options.targetPlatform || process.env.TARGET_PLATFORM || DEFAULT_PLATFORM,
			TARGET_VARIANTS: targetVariants,
		};
		delete buildEnv.VEYYON_NATIVE_CACHE_CREDENTIALS;
		delete buildEnv.VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS;
		delete buildEnv.CLOUDFLARE_API_TOKEN;

		return new Promise((resolve, reject) => {
			const child = child_process.spawn(bunCmd, ["run", "ci:build:native"], {
				cwd: repoRoot,
				env: buildEnv,
				stdio: "inherit",
				timeout: options.buildTimeout || 600000,
				windowsHide: true,
			});
			child.on("error", reject);
			child.on("close", code => {
				if (code === 0) resolve();
				else reject(new Error(`Native build failed with exit code ${code}`));
			});
		});
	});

	await buildRunner();

	for (const v of targetVariants.split(/\s+/).filter(Boolean)) {
		if (!CANONICAL_ADDON_FILES[v]) continue;
		const absPath = path.join(repoRoot, CANONICAL_ADDON_FILES[v]);
		if (!fs.existsSync(absPath)) throw new Error(`Native build did not emit required artifact: ${CANONICAL_ADDON_FILES[v]}`);
		if (fs.statSync(absPath).size === 0) throw new Error(`Native build emitted 0-byte artifact: ${CANONICAL_ADDON_FILES[v]}`);
	}
	return { variants: targetVariants };
}

export const buildExistingArtifacts = buildArtifacts;

export async function restoreFromCache(bucket, cacheKey, repoRoot, options = {}) {
	const env = options.env || process.env;
	const variant = options.variant || env.VEYYON_NATIVE_VARIANT;
	if (variant !== "baseline" && variant !== "modern") {
		throw new Error(
			`Native cache reader requires VEYYON_NATIVE_VARIANT to be "baseline" or "modern" (current: "${variant || "unset"}").`,
		);
	}

	const config = options.config || {
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		endpoint: options.endpoint || `https://${EXPECTED_ENDPOINT}`,
		bucket: bucket || EXPECTED_BUCKET,
	};
	const s3Client = options.s3Client || createS3Client(config, options);
	const fetcher = options.fetchRunner || fetch;
	const timeoutMs = options.timeout || DEFAULT_FETCH_TIMEOUT_MS;
	const hash = cacheKey.replace(/^trusted\//, "");
	const prefix = `trusted/${hash}`;

	// 1. Fetch manifest.json
	const manifestUrl = presignUrl(s3Client, `${prefix}/manifest.json`, { method: "GET", expiresIn: 3600 });
	let manifestRes;
	try {
		manifestRes = await fetcher(manifestUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		const classified = classifyR2Error(err);
		throw new Error(`R2 manifest fetch network error for ${hash}: ${classified.message}. Network failure is not a cache miss.`);
	}

	if (manifestRes.status === 404) return { hit: false, reason: "404 not found", hash, variant };
	if (!manifestRes.ok) {
		const classified = classifyR2Error(manifestRes);
		throw new Error(`R2 manifest fetch failed for ${hash}: HTTP ${manifestRes.status} (${classified.message}). Exact 404 miss else abort.`);
	}

	const manifest = validateManifest(await manifestRes.text(), hash);
	const expectedFile = `${variant}.node`;
	const fileMeta = manifest.files[expectedFile];
	if (!fileMeta) throw new Error(`Cache corruption: manifest for ${hash} is missing entry for ${expectedFile}`);

	// 2. Fetch selected addon file
	const addonUrl = presignUrl(s3Client, `${prefix}/${expectedFile}`, { method: "GET", expiresIn: 3600 });
	let addonRes;
	try {
		addonRes = await fetcher(addonUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		const classified = classifyR2Error(err);
		throw new Error(`R2 addon fetch network error for ${hash}/${expectedFile}: ${classified.message}. Network failure is not a cache miss.`);
	}

	if (addonRes.status === 404) {
		throw new Error(`Cache corruption: manifest exists for ${hash} but ${expectedFile} is missing (404). Aborting.`);
	}
	if (!addonRes.ok) {
		const classified = classifyR2Error(addonRes);
		throw new Error(`R2 addon fetch failed for ${hash}/${expectedFile}: HTTP ${addonRes.status} (${classified.message}). Exact 404 miss else abort.`);
	}

	const destRelPath = CANONICAL_ADDON_FILES[variant];
	const destAbsPath = path.join(repoRoot, destRelPath);
	const destDir = path.dirname(destAbsPath);
	fs.mkdirSync(destDir, { recursive: true });

	const tmpAbsPath = path.join(destDir, `.veyyon_natives.${variant}.tmp.${process.pid}.${Date.now()}`);
	try {
		await streamToFile(addonRes, tmpAbsPath);
		const downloadedBytes = fs.readFileSync(tmpAbsPath);
		const downloadedSha = crypto.createHash("sha256").update(downloadedBytes).digest("hex");
		if (downloadedSha !== fileMeta.sha256) {
			throw new Error(`SHA256 checksum mismatch for ${destRelPath}: expected ${fileMeta.sha256}, got ${downloadedSha}`);
		}
		if (downloadedBytes.length !== fileMeta.size) {
			throw new Error(`File size mismatch for ${destRelPath}: expected ${fileMeta.size} bytes, got ${downloadedBytes.length} bytes`);
		}
		fs.renameSync(tmpAbsPath, destAbsPath);
	} finally {
		try {
			if (fs.existsSync(tmpAbsPath)) fs.unlinkSync(tmpAbsPath);
		} catch {}
	}

	return { hit: true, hash, variant, restoredFile: destRelPath };
}

export async function uploadToCache(bucket, cacheKey, repoRoot, options = {}) {
	const env = options.env || process.env;
	validateWriterBranchGuard(env, options);

	const config = options.config || {
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		endpoint: options.endpoint || `https://${EXPECTED_ENDPOINT}`,
		bucket: bucket || EXPECTED_BUCKET,
	};
	const s3Client = options.s3Client || createS3Client(config, options);
	const fetcher = options.fetchRunner || fetch;
	const timeoutMs = options.timeout || DEFAULT_FETCH_TIMEOUT_MS;
	const hash = cacheKey.replace(/^trusted\//, "");
	const prefix = `trusted/${hash}`;

	// 1. Build both variants
	await buildArtifacts(repoRoot, { ...options, targetVariants: "baseline modern" });

	// 2. Validate both addon files exist and non-zero size
	const files = {};
	for (const variant of ["baseline", "modern"]) {
		const relPath = CANONICAL_ADDON_FILES[variant];
		const absPath = path.join(repoRoot, relPath);
		if (!fs.existsSync(absPath)) throw new Error(`Native build did not emit required artifact: ${relPath}`);
		const buf = fs.readFileSync(absPath);
		if (buf.length === 0) throw new Error(`Native build emitted 0-byte artifact: ${relPath}`);
		const sha = crypto.createHash("sha256").update(buf).digest("hex");
		console.log(`[native-cache] checksum variant=${variant} sha=${sha}`);
		files[`${variant}.node`] = { absPath, sha256: sha, size: buf.length };
	}

	// 3. Upload validated nodes first
	for (const variant of ["baseline", "modern"]) {
		const filename = `${variant}.node`;
		const meta = files[filename];
		const uploadUrl = presignUrl(s3Client, `${prefix}/${filename}`, { method: "PUT", expiresIn: 3600 });
		let putRes;
		try {
			putRes = await fetcher(uploadUrl, {
				method: "PUT",
				body: getUploadPayload(meta.absPath),
				headers: { "Content-Type": "application/octet-stream" },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			const classified = classifyR2Error(err);
			throw new Error(`R2 upload network error for ${filename}: ${classified.message}. Upload aborted.`);
		}
		if (!putRes.ok) {
			const classified = classifyR2Error(putRes);
			throw new Error(`R2 upload failed for ${filename}: HTTP ${putRes.status} (${classified.message}). Upload aborted.`);
		}
	}

	// 4. Upload manifest last
	const manifest = {
		created_at: new Date().toISOString(),
		files: {
			"baseline.node": { sha256: files["baseline.node"].sha256, size: files["baseline.node"].size },
			"modern.node": { sha256: files["modern.node"].sha256, size: files["modern.node"].size },
		},
		hash,
	};
	const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
	const manifestUploadUrl = presignUrl(s3Client, `${prefix}/manifest.json`, { method: "PUT", expiresIn: 3600 });
	let manifestPutRes;
	try {
		manifestPutRes = await fetcher(manifestUploadUrl, {
			method: "PUT",
			body: manifestBuffer,
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		const classified = classifyR2Error(err);
		throw new Error(`R2 manifest upload network error for ${hash}: ${classified.message}. Upload aborted.`);
	}
	if (!manifestPutRes.ok) {
		const classified = classifyR2Error(manifestPutRes);
		throw new Error(`R2 manifest upload failed for ${hash}: HTTP ${manifestPutRes.status} (${classified.message}). Upload aborted.`);
	}

	return { uploaded: true, hash, files: ["baseline.node", "modern.node"] };
}

export const buildAndUploadCache = uploadToCache;

export async function runNativeCache(options = {}) {
	const repoRoot = options.repoRoot || process.cwd();
	const env = options.env || process.env;
	const writeMode = Boolean(options.writeMode);

	if (writeMode) {
		validateWriterBranchGuard(env, options);
		const config = validateEnvironmentConfig(env, { writeMode: true });
		const { key, hash } = computeCacheKey({ env, repoRoot });
		console.log(`[native-cache] cache key: ${key}`);
		console.log("[native-cache] running native cold build and uploading to trusted cache...");
		await uploadToCache(config.bucket, key, repoRoot, { ...options, config, writeMode });
		console.log(`[native-cache] cold build completed and uploaded to R2: ${key}`);
		return { hit: false, key, hash, uploaded: true };
	}

	const variant = options.variant || env.VEYYON_NATIVE_VARIANT;
	if (variant !== "baseline" && variant !== "modern") {
		throw new Error(
			`Native cache reader requires VEYYON_NATIVE_VARIANT to be "baseline" or "modern" (current: "${variant || "unset"}").`,
		);
	}

	const { key, hash } = computeCacheKey({ env, repoRoot });
	console.log(`[native-cache] cache key: ${key}`);

	const config = validateEnvironmentConfig(env, { writeMode: false });
	const restoreResult = await restoreFromCache(config.bucket, key, repoRoot, {
		...options,
		config,
		variant,
	});

	if (restoreResult.hit) {
		console.log(`[native-cache] cache hit: ${key}`);
		console.log(`[native-cache] restored valid addon file for variant ${variant}: ${restoreResult.restoredFile}`);
		return { hit: true, key, hash, variant, restoredFile: restoreResult.restoredFile };
	}

	console.log(`[native-cache] cache miss: ${key} (${restoreResult.reason})`);
	console.log(`[native-cache] running native cold build for selected variant "${variant}" (reader mode: no upload)...`);
	await buildArtifacts(repoRoot, { ...options, targetVariants: variant });
	console.log(`[native-cache] ready with valid addon file for variant ${variant}: ${CANONICAL_ADDON_FILES[variant]}`);
	return { hit: false, key, hash, variant, uploaded: false, built: true };
}

const isMain =
	(typeof import.meta.main === "boolean" && import.meta.main) ||
	(Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href);

if (isMain) {
	const writeMode = process.argv.includes("--write");
	runNativeCache({ writeMode }).catch(err => {
		console.error(`[native-cache] error: ${redactSecrets(err.message)}`);
		process.exit(1);
	});
}
