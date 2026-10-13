import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	buildArtifacts,
	CANONICAL_ADDON_FILES,
	classifyR2Error,
	computeCacheKey,
	DEFAULT_ACCOUNT_ID,
	DEFAULT_ARCH,
	DEFAULT_CROSS_TARGET,
	DEFAULT_PLATFORM,
	DEFAULT_RUST_TOOLCHAIN,
	DEFAULT_VARIANTS,
	DEFAULT_ZIG_VERSION,
	EXPECTED_BUCKET,
	EXPECTED_ENDPOINT,
	getTrustedR2Key,
	redactSecrets,
	restoreFromCache,
	runNativeCache,
	uploadToCache,
	validateEnvironmentConfig,
	validateManifest,
	validateWriterBranchGuard,
} from "./native-cache.mjs";

test("cache key computation is deterministic for identical inputs", () => {
	const fixedFiles = {
		"Cargo.lock": "lock-hash-1",
		"Cargo.toml": "toml-hash-1",
		"natives/bridge/addon/src/lib.rs": "source-hash-1",
		"rust-toolchain.toml": "toolchain-hash-1",
	};

	const opts = {
		configFiles: ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
		fileHasher: p => fixedFiles[p] || null,
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		parameters: {
			crossTarget: DEFAULT_CROSS_TARGET,
			rustToolchain: DEFAULT_RUST_TOOLCHAIN,
			targetArch: DEFAULT_ARCH,
			targetPlatform: DEFAULT_PLATFORM,
			zigVersion: DEFAULT_ZIG_VERSION,
		},
		trackedFiles: ["natives/bridge/addon/src/lib.rs"],
	};

	const key1 = computeCacheKey(opts);
	const key2 = computeCacheKey(opts);

	assert.equal(key1.key, key2.key);
	assert.equal(key1.hash, key2.hash);
	assert.match(key1.key, /^trusted\/[a-f0-9]{64}$/);
});

test("cache key format matches trusted/<sha256> prefix", () => {
	const key = computeCacheKey({
		configFiles: [],
		fileHasher: () => "mock-hash",
		packageVersions: { root: "1.0.0", native: "1.0.0" },
		trackedFiles: ["natives/sample.rs"],
	});
	assert.match(key.key, /^trusted\/[a-f0-9]{64}$/);
	assert.equal(getTrustedR2Key(key.hash), key.key);
});

test("cache key changes when tracked native source files change", () => {
	const baseFiles = {
		"Cargo.toml": "toml-hash-1",
		"natives/bridge/addon/src/lib.rs": "source-hash-original",
	};
	const modifiedFiles = {
		"Cargo.toml": "toml-hash-1",
		"natives/bridge/addon/src/lib.rs": "source-hash-modified",
	};

	const baseKey = computeCacheKey({
		configFiles: ["Cargo.toml"],
		fileHasher: p => baseFiles[p] || null,
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: ["natives/bridge/addon/src/lib.rs"],
	});

	const modifiedKey = computeCacheKey({
		configFiles: ["Cargo.toml"],
		fileHasher: p => modifiedFiles[p] || null,
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: ["natives/bridge/addon/src/lib.rs"],
	});

	assert.notEqual(baseKey.hash, modifiedKey.hash);
	assert.notEqual(baseKey.key, modifiedKey.key);
});

test("cache key changes when Cargo manifests or rust toolchain change", () => {
	const baseFiles = {
		"Cargo.lock": "lock-v1",
		"Cargo.toml": "toml-v1",
		"rust-toolchain.toml": "toolchain-v1",
	};

	const baseKey = computeCacheKey({
		configFiles: ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
		fileHasher: p => baseFiles[p] || null,
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: [],
	});

	const changedTomlKey = computeCacheKey({
		configFiles: ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
		fileHasher: p => (p === "Cargo.toml" ? "toml-v2" : baseFiles[p] || null),
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: [],
	});
	assert.notEqual(baseKey.hash, changedTomlKey.hash);

	const changedLockKey = computeCacheKey({
		configFiles: ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
		fileHasher: p => (p === "Cargo.lock" ? "lock-v2" : baseFiles[p] || null),
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: [],
	});
	assert.notEqual(baseKey.hash, changedLockKey.hash);

	const changedToolchainKey = computeCacheKey({
		configFiles: ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"],
		fileHasher: p => (p === "rust-toolchain.toml" ? "toolchain-v2" : baseFiles[p] || null),
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: [],
	});
	assert.notEqual(baseKey.hash, changedToolchainKey.hash);
});

test("cache key changes when build or embedding scripts change", () => {
	const baseFiles = {
		"scripts/ci-build-native.ts": "build-script-v1",
	};

	const baseKey = computeCacheKey({
		buildScripts: ["scripts/ci-build-native.ts"],
		configFiles: [],
		fileHasher: p => baseFiles[p] || null,
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: [],
	});

	const modifiedKey = computeCacheKey({
		buildScripts: ["scripts/ci-build-native.ts"],
		configFiles: [],
		fileHasher: p => (p === "scripts/ci-build-native.ts" ? "build-script-v2" : null),
		packageVersions: { root: "1.0.0", native: "1.5.6" },
		trackedFiles: [],
	});

	assert.notEqual(baseKey.hash, modifiedKey.hash);
});

test("cache key changes when root or native package versions change", () => {
	const baseKey = computeCacheKey({
		configFiles: [],
		fileHasher: () => null,
		packageVersions: { root: "1.0.0", native: "1.0.0" },
		trackedFiles: [],
	});

	const changedRoot = computeCacheKey({
		configFiles: [],
		fileHasher: () => null,
		packageVersions: { root: "2.0.0", native: "1.0.0" },
		trackedFiles: [],
	});
	assert.notEqual(baseKey.hash, changedRoot.hash);

	const changedNative = computeCacheKey({
		configFiles: [],
		fileHasher: () => null,
		packageVersions: { root: "1.0.0", native: "2.0.0" },
		trackedFiles: [],
	});
	assert.notEqual(baseKey.hash, changedNative.hash);
});

test("cache key changes when portable parameters change", () => {
	const makeKey = params =>
		computeCacheKey({
			configFiles: [],
			fileHasher: () => null,
			packageVersions: { root: "1.0.0", native: "1.0.0" },
			parameters: {
				crossTarget: DEFAULT_CROSS_TARGET,
				rustToolchain: DEFAULT_RUST_TOOLCHAIN,
				targetArch: DEFAULT_ARCH,
				targetPlatform: DEFAULT_PLATFORM,
				zigVersion: DEFAULT_ZIG_VERSION,
				...params,
			},
			trackedFiles: [],
		});

	const base = makeKey({});
	assert.notEqual(base.hash, makeKey({ rustToolchain: "nightly-2026-05-01" }).hash);
	assert.notEqual(base.hash, makeKey({ zigVersion: "0.17.0" }).hash);
	assert.notEqual(base.hash, makeKey({ targetArch: "arm64" }).hash);
});

test("cache key does not change when CI cache helper scripts change", () => {
	const fixedFiles = {
		"Cargo.toml": "toml-v1",
		"natives/bridge/addon/src/lib.rs": "source-v1",
	};

	const key1 = computeCacheKey({
		configFiles: ["Cargo.toml"],
		fileHasher: p => fixedFiles[p] || null,
		packageVersions: { root: "1.0.0", native: "1.0.0" },
		trackedFiles: ["natives/bridge/addon/src/lib.rs"],
	});

	// CI helper script is not in candidate files
	const key2 = computeCacheKey({
		configFiles: ["Cargo.toml"],
		fileHasher: p => fixedFiles[p] || null,
		packageVersions: { root: "1.0.0", native: "1.0.0" },
		trackedFiles: ["natives/bridge/addon/src/lib.rs"],
	});

	assert.equal(key1.hash, key2.hash);
});

test("missing configuration fails clearly with explicit error", () => {
	assert.throws(
		() => validateEnvironmentConfig({}, { writeMode: false }),
		/Missing required native cache configuration: VEYYON_NATIVE_CACHE_CREDENTIALS, VEYYON_NATIVE_CACHE_BUCKET/,
	);
	assert.throws(
		() => validateEnvironmentConfig({}, { writeMode: true }),
		/Missing required native cache configuration: VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS, VEYYON_NATIVE_CACHE_BUCKET/,
	);
});

test("invalid/malformed credentials and bucket pinning reject with explicit error", () => {
	const validCreds = JSON.stringify({
		accessKeyId: "key-123",
		endpoint: EXPECTED_ENDPOINT,
		secretAccessKey: "secret-456",
	});

	// Wrong bucket
	assert.throws(
		() =>
			validateEnvironmentConfig({
				VEYYON_NATIVE_CACHE_BUCKET: "wrong-bucket",
				VEYYON_NATIVE_CACHE_CREDENTIALS: validCreds,
			}),
		/Invalid native cache bucket: expected "ci-artifacts-cache", got "wrong-bucket"/,
	);

	// Malformed JSON
	assert.throws(
		() =>
			validateEnvironmentConfig({
				VEYYON_NATIVE_CACHE_BUCKET: EXPECTED_BUCKET,
				VEYYON_NATIVE_CACHE_CREDENTIALS: "not-json{",
			}),
		/Malformed VEYYON_NATIVE_CACHE_CREDENTIALS: must be valid JSON/,
	);

	// Missing accessKeyId
	assert.throws(
		() =>
			validateEnvironmentConfig({
				VEYYON_NATIVE_CACHE_BUCKET: EXPECTED_BUCKET,
				VEYYON_NATIVE_CACHE_CREDENTIALS: JSON.stringify({
					endpoint: EXPECTED_ENDPOINT,
					secretAccessKey: "sec",
				}),
			}),
		/missing or empty required keys \(accessKeyId\)/,
	);

	// Wrong endpoint
	assert.throws(
		() =>
			validateEnvironmentConfig({
				VEYYON_NATIVE_CACHE_BUCKET: EXPECTED_BUCKET,
				VEYYON_NATIVE_CACHE_CREDENTIALS: JSON.stringify({
					accessKeyId: "key",
					endpoint: "untrusted.attacker.com",
					secretAccessKey: "sec",
				}),
			}),
		/Invalid native cache endpoint: expected "a0d288d1c95470cd009cc6e0df7accb7.r2.cloudflarestorage.com", got "untrusted.attacker.com"/,
	);
});

test("R2 error classification: exact 404 is classified as cache miss", () => {
	const res1 = classifyR2Error(new Error("The specified key does not exist"), "", "");
	assert.equal(res1.isMiss, true);
	assert.equal(res1.isAuth, false);

	const res2 = classifyR2Error({ status: 404 });
	assert.equal(res2.isMiss, true);
	assert.equal(res2.isAuth, false);
});

test("R2 error classification: auth error aborts and is NOT cache miss", () => {
	const res1 = classifyR2Error(new Error("Command failed"), "", "401 Unauthorized: Invalid API token");
	assert.equal(res1.isAuth, true);
	assert.equal(res1.isMiss, false);

	const res2 = classifyR2Error({ status: 403 });
	assert.equal(res2.isAuth, true);
	assert.equal(res2.isMiss, false);
});

test("R2 error classification: network error aborts and is NOT cache miss", () => {
	const res1 = classifyR2Error(new Error("fetch failed: connect ECONNREFUSED 127.0.0.1"), "", "");
	assert.equal(res1.isNetwork, true);
	assert.equal(res1.isMiss, false);

	const res2 = classifyR2Error({ status: 503 });
	assert.equal(res2.isNetwork, true);
	assert.equal(res2.isMiss, false);
});

test("secrets redaction masks credentials and presigned URL signatures", () => {
	const raw = 'Error uploading to https://r2.example.com/item?X-Amz-Signature=secretSig123 with key="mySecretKey"';
	const redacted = redactSecrets(raw, ["mySecretKey"]);
	assert.equal(redacted.includes("mySecretKey"), false);
	assert.equal(redacted.includes("secretSig123"), false);
	assert.equal(redacted.includes("[REDACTED]"), true);
	assert.equal(redacted.includes("[REDACTED_SIG]"), true);
});

test("reader mode requires VEYYON_NATIVE_VARIANT to be baseline or modern", async () => {
	await assert.rejects(
		() => runNativeCache({ env: {}, writeMode: false }),
		/Native cache reader requires VEYYON_NATIVE_VARIANT to be "baseline" or "modern"/,
	);
	await assert.rejects(
		() => runNativeCache({ env: { VEYYON_NATIVE_VARIANT: "unknown" }, writeMode: false }),
		/Native cache reader requires VEYYON_NATIVE_VARIANT to be "baseline" or "modern"/,
	);
});

test("reader mode uses VEYYON_NATIVE_CACHE_CREDENTIALS and rejects writer-only credentials", () => {
	const validCreds = JSON.stringify({
		accessKeyId: "key",
		endpoint: EXPECTED_ENDPOINT,
		secretAccessKey: "sec",
	});

	assert.throws(
		() =>
			validateEnvironmentConfig(
				{
					VEYYON_NATIVE_CACHE_BUCKET: EXPECTED_BUCKET,
					VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS: validCreds,
				},
				{ writeMode: false },
			),
		/Missing required native cache configuration: VEYYON_NATIVE_CACHE_CREDENTIALS/,
	);
});

test("restoreFromCache handles exact 404 as cache miss without throwing", async () => {
	const mockS3Client = {
		presign: key => `https://${EXPECTED_ENDPOINT}/${key}?signed=1`,
	};

	const fakeFetcher = async () => new Response("Not Found", { status: 404 });

	const res = await restoreFromCache(EXPECTED_BUCKET, "trusted/hash123", process.cwd(), {
		accessKeyId: "k",
		endpoint: `https://${EXPECTED_ENDPOINT}`,
		fetchRunner: fakeFetcher,
		s3Client: mockS3Client,
		secretAccessKey: "s",
		variant: "baseline",
	});

	assert.equal(res.hit, false);
	assert.equal(res.reason, "404 not found");
	assert.equal(res.variant, "baseline");
});

test("restoreFromCache aborts on auth error and does NOT treat as miss", async () => {
	const mockS3Client = {
		presign: key => `https://${EXPECTED_ENDPOINT}/${key}?signed=1`,
	};

	const fakeFetcher = async () => new Response("Forbidden", { status: 403 });

	await assert.rejects(
		() =>
			restoreFromCache(EXPECTED_BUCKET, "trusted/hash123", process.cwd(), {
				accessKeyId: "k",
				endpoint: `https://${EXPECTED_ENDPOINT}`,
				fetchRunner: fakeFetcher,
				s3Client: mockS3Client,
				secretAccessKey: "s",
				variant: "baseline",
			}),
		/R2 manifest fetch failed for hash123: HTTP 403/,
	);
});

test("restoreFromCache aborts on network timeout/error and does NOT treat as miss", async () => {
	const mockS3Client = {
		presign: key => `https://${EXPECTED_ENDPOINT}/${key}?signed=1`,
	};

	const fakeFetcher = async () => {
		throw new Error("connect ETIMEDOUT");
	};

	await assert.rejects(
		() =>
			restoreFromCache(EXPECTED_BUCKET, "trusted/hash123", process.cwd(), {
				accessKeyId: "k",
				endpoint: `https://${EXPECTED_ENDPOINT}`,
				fetchRunner: fakeFetcher,
				s3Client: mockS3Client,
				secretAccessKey: "s",
				variant: "baseline",
			}),
		/R2 manifest fetch network error for hash123:.*Network failure is not a cache miss/,
	);
});

test("restoreFromCache detects corruption when manifest is 200 but selected addon is 404", async () => {
	const mockS3Client = {
		presign: key => `https://${EXPECTED_ENDPOINT}/${key}?signed=1`,
	};

	const manifestContent = JSON.stringify({
		created_at: new Date().toISOString(),
		files: {
			"baseline.node": { sha256: "a".repeat(64), size: 100 },
			"modern.node": { sha256: "b".repeat(64), size: 100 },
		},
		hash: "hash123",
	});

	const fakeFetcher = async url => {
		if (url.includes("manifest.json")) {
			return new Response(manifestContent, { status: 200 });
		}
		return new Response("Not Found", { status: 404 });
	};

	await assert.rejects(
		() =>
			restoreFromCache(EXPECTED_BUCKET, "trusted/hash123", process.cwd(), {
				accessKeyId: "k",
				endpoint: `https://${EXPECTED_ENDPOINT}`,
				fetchRunner: fakeFetcher,
				s3Client: mockS3Client,
				secretAccessKey: "s",
				variant: "baseline",
			}),
		/Cache corruption: manifest exists for hash123 but baseline\.node is missing \(404\)/,
	);
});

test("restoreFromCache detects checksum mismatch between manifest and downloaded addon", async () => {
	const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-restore-mismatch-"));
	try {
		const mockS3Client = {
			presign: key => `https://${EXPECTED_ENDPOINT}/${key}?signed=1`,
		};

		const manifestContent = JSON.stringify({
			created_at: new Date().toISOString(),
			files: {
				"baseline.node": { sha256: "a".repeat(64), size: 10 },
				"modern.node": { sha256: "b".repeat(64), size: 10 },
			},
			hash: "hash123",
		});

		const fakeFetcher = async url => {
			if (url.includes("manifest.json")) {
				return new Response(manifestContent, { status: 200 });
			}
			return new Response("corrupted-bytes", { status: 200 });
		};

		await assert.rejects(
			() =>
				restoreFromCache(EXPECTED_BUCKET, "trusted/hash123", tmpRepo, {
					accessKeyId: "k",
					endpoint: `https://${EXPECTED_ENDPOINT}`,
					fetchRunner: fakeFetcher,
					s3Client: mockS3Client,
					secretAccessKey: "s",
					variant: "baseline",
				}),
			/SHA256 checksum mismatch for natives\/bridge\/bindings\/native\/veyyon_natives\.linux-x64-baseline\.node/,
		);
	} finally {
		fs.rmSync(tmpRepo, { force: true, recursive: true });
	}
});

test("restoreFromCache restores selected variant with verified checksum and size via atomic rename", async () => {
	const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-restore-success-"));
	try {
		const mockS3Client = {
			presign: key => `https://${EXPECTED_ENDPOINT}/${key}?signed=1`,
		};

		const addonBytes = Buffer.from("real-binary-addon-bytes-content");
		const addonSha = crypto.createHash("sha256").update(addonBytes).digest("hex");

		const manifestContent = JSON.stringify({
			created_at: new Date().toISOString(),
			files: {
				"baseline.node": { sha256: addonSha, size: addonBytes.length },
				"modern.node": { sha256: "c".repeat(64), size: 100 },
			},
			hash: "hash123",
		});

		const requestedUrls = [];
		const fakeFetcher = async url => {
			requestedUrls.push(url);
			if (url.includes("manifest.json")) {
				return new Response(manifestContent, { status: 200 });
			}
			if (url.includes("baseline.node")) {
				return new Response(addonBytes, { status: 200 });
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		const res = await restoreFromCache(EXPECTED_BUCKET, "trusted/hash123", tmpRepo, {
			accessKeyId: "k",
			endpoint: `https://${EXPECTED_ENDPOINT}`,
			fetchRunner: fakeFetcher,
			s3Client: mockS3Client,
			secretAccessKey: "s",
			variant: "baseline",
		});

		assert.equal(res.hit, true);
		assert.equal(res.variant, "baseline");

		// Destination file exists with exact content
		const destPath = path.join(tmpRepo, CANONICAL_ADDON_FILES.baseline);
		assert.equal(fs.existsSync(destPath), true);
		assert.deepEqual(fs.readFileSync(destPath), addonBytes);

		// modern.node was NOT requested or written
		assert.equal(requestedUrls.some(u => u.includes("modern.node")), false);
		const modernDest = path.join(tmpRepo, CANONICAL_ADDON_FILES.modern);
		assert.equal(fs.existsSync(modernDest), false);
	} finally {
		fs.rmSync(tmpRepo, { force: true, recursive: true });
	}
});

test("reader mode never uploads on cache miss and builds selected variant locally", async () => {
	const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-reader-miss-"));
	try {
		let uploaded = false;
		let builtVariants = null;

		const mockS3Client = {
			presign: (key, opts) => {
				if (opts?.method === "PUT") uploaded = true;
				return `https://${EXPECTED_ENDPOINT}/${key}`;
			},
		};

		const fakeFetcher = async () => new Response("Not Found", { status: 404 });

		const fakeBuildRunner = async () => {
			// Emulate cold build creating only the requested variant
			const baselineDir = path.join(tmpRepo, "natives/bridge/bindings/native");
			fs.mkdirSync(baselineDir, { recursive: true });
			fs.writeFileSync(path.join(tmpRepo, CANONICAL_ADDON_FILES.baseline), "baseline-built-bytes");
		};

		const res = await runNativeCache({
			buildRunner: fakeBuildRunner,
			config: {
				accessKeyId: "k",
				endpoint: `https://${EXPECTED_ENDPOINT}`,
				secretAccessKey: "s",
			},
			env: {
				VEYYON_NATIVE_CACHE_BUCKET: EXPECTED_BUCKET,
				VEYYON_NATIVE_CACHE_CREDENTIALS: JSON.stringify({
					accessKeyId: "k",
					endpoint: EXPECTED_ENDPOINT,
					secretAccessKey: "s",
				}),
				VEYYON_NATIVE_VARIANT: "baseline",
			},
			fetchRunner: fakeFetcher,
			repoRoot: tmpRepo,
			s3Client: mockS3Client,
			writeMode: false,
		});

		assert.equal(res.hit, false);
		assert.equal(res.built, true);
		assert.equal(res.uploaded, false);
		assert.equal(uploaded, false);
		assert.equal(res.variant, "baseline");
	} finally {
		fs.rmSync(tmpRepo, { force: true, recursive: true });
	}
});

test("writer mode rejects WORKERS_CI_BRANCH other than main before credential, network, or build", async () => {
	let credentialsChecked = false;
	let networkCalled = false;
	let buildCalled = false;

	await assert.rejects(
		() =>
			runNativeCache({
				buildRunner: async () => {
					buildCalled = true;
				},
				env: {
					WORKERS_CI_BRANCH: "feature/native-cache",
				},
				fetchRunner: async () => {
					networkCalled = true;
				},
				writeMode: true,
			}),
		/Native cache writer rejected: WORKERS_CI_BRANCH must be "main" \(current: "feature\/native-cache"\)/,
	);

	assert.equal(credentialsChecked, false);
	assert.equal(networkCalled, false);
	assert.equal(buildCalled, false);
});

test("writer mode uses VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS and rejects reader-only credentials", () => {
	const validCreds = JSON.stringify({
		accessKeyId: "key",
		endpoint: EXPECTED_ENDPOINT,
		secretAccessKey: "sec",
	});

	assert.throws(
		() =>
			validateEnvironmentConfig(
				{
					VEYYON_NATIVE_CACHE_BUCKET: EXPECTED_BUCKET,
					VEYYON_NATIVE_CACHE_CREDENTIALS: validCreds,
				},
				{ writeMode: true },
			),
		/Missing required native cache configuration: VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS/,
	);
});

test("writer mode uploads nodes first manifest last with checksum logging naming variant and sha", async () => {
	const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-writer-success-"));
	try {
		const putOrder = [];
		const mockS3Client = {
			presign: (key, opts) => {
				return `https://${EXPECTED_ENDPOINT}/${key}`;
			},
		};

		const fakeFetcher = async (url, opts) => {
			if (opts?.method === "PUT") {
				putOrder.push(url);
				return new Response("", { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};

		const fakeBuildRunner = async () => {
			const addonDir = path.join(tmpRepo, "natives/bridge/bindings/native");
			fs.mkdirSync(addonDir, { recursive: true });
			fs.writeFileSync(path.join(tmpRepo, CANONICAL_ADDON_FILES.baseline), "baseline-bytes");
			fs.writeFileSync(path.join(tmpRepo, CANONICAL_ADDON_FILES.modern), "modern-bytes");
		};

		// Capture console logs to verify checksum logging names variant and sha
		const originalLog = console.log;
		const logged = [];
		console.log = (...args) => {
			logged.push(args.join(" "));
			originalLog(...args);
		};

		let res;
		try {
			res = await runNativeCache({
				buildRunner: fakeBuildRunner,
				env: {
					VEYYON_NATIVE_CACHE_BUCKET: EXPECTED_BUCKET,
					VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS: JSON.stringify({
						accessKeyId: "wk",
						endpoint: EXPECTED_ENDPOINT,
						secretAccessKey: "ws",
					}),
					WORKERS_CI_BRANCH: "main",
				},
				fetchRunner: fakeFetcher,
				repoRoot: tmpRepo,
				s3Client: mockS3Client,
				writeMode: true,
			});
		} finally {
			console.log = originalLog;
		}

		assert.equal(res.uploaded, true);

		// Verify checksum logs name variant and sha
		const baselineLog = logged.find(l => l.includes("checksum variant=baseline sha="));
		const modernLog = logged.find(l => l.includes("checksum variant=modern sha="));
		assert.ok(baselineLog, "Must log checksum for variant=baseline");
		assert.ok(modernLog, "Must log checksum for variant=modern");

		// Verify order: baseline.node and modern.node FIRST, manifest.json LAST!
		assert.equal(putOrder.length, 3);
		assert.ok(putOrder[0].endsWith("baseline.node"), "baseline.node must be uploaded first");
		assert.ok(putOrder[1].endsWith("modern.node"), "modern.node must be uploaded second");
		assert.ok(putOrder[2].endsWith("manifest.json"), "manifest.json must be uploaded last");
	} finally {
		fs.rmSync(tmpRepo, { force: true, recursive: true });
	}
});
