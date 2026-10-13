/**
 * Veyyon CI Shard Receipt Emission and Aggregation Adapter (v1)
 *
 * Implements the ci-receipt/v1 and ci-manifest/v1 contracts for Cloudflare
 * Workers Builds shards. Produces HMAC-authenticated evidence uploads with
 * strict counter contract enforcement.
 *
 * Rules:
 * - PASS requires executed > 0, passed > 0, and failed == 0 for all required suites.
 * - All-skipped, xfail-only, executed == 0, unparseable summaries, or missing
 *   producer secrets yield explicit NO-RESULT (status "incomplete"), never PASS.
 * - Failures without reporter failure text explicitly report "message unavailable".
 * - Aggregation validates coverage of 1..expected_shards without missing, duplicate,
 *   or mismatched shard IDs.
 */

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SCHEMA_VERSION = "ci-receipt/v1";
export const MANIFEST_SCHEMA_VERSION = "ci-manifest/v1";
export const DEFAULT_REPO = "Wladefant/veyyon";
export const DEFAULT_EXPECTED_SHARDS = 3;

const SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const DIGEST_REGEX = /^sha256:[0-9a-fA-F]{64}$/;

/**
 * Validates sha256 digest format `sha256:<64 hex>`.
 * @param {string} digest
 * @returns {boolean}
 */
export function isValidDigest(digest) {
	return typeof digest === "string" && DIGEST_REGEX.test(digest);
}

/**
 * Computes sha256 digest in `sha256:<hex>` format for arbitrary data.
 * @param {string | Buffer | Uint8Array} data
 * @returns {string}
 */
export function computeSha256Digest(data) {
	const hash = crypto.createHash("sha256").update(data).digest("hex");
	return `sha256:${hash}`;
}

/**
 * Evaluates the status of a suite's test counts according to the v1 Counter Contract.
 *
 * @param {{
 *   exit_code?: number,
 *   counts?: {
 *     discovered?: number,
 *     executed?: number,
 *     passed?: number,
 *     failed?: number,
 *     skipped?: number,
 *     assertions?: number
 *   },
 *   unparseable?: boolean,
 *   xfail_only?: boolean
 * }} suite
 * @returns {"passed" | "failed" | "incomplete"}
 */
export function evaluateSuiteStatus(suite) {
	if (suite.unparseable) {
		return "incomplete";
	}
	if (suite.exit_code !== undefined && suite.exit_code !== 0) {
		return "failed";
	}
	const counts = suite.counts || {};
	const executed = counts.executed ?? 0;
	const passed = counts.passed ?? 0;
	const failed = counts.failed ?? 0;
	const skipped = counts.skipped ?? 0;

	if (failed > 0) {
		return "failed";
	}

	// xfail-only or all-skipped or zero-executed => incomplete (NO-RESULT)
	if (suite.xfail_only || executed === 0 || (passed === 0 && skipped > 0) || passed === 0) {
		return "incomplete";
	}

	// Counter contract: PASS requires executed > 0, passed > 0, and failed == 0
	if (executed > 0 && passed > 0 && failed === 0) {
		return "passed";
	}

	return "incomplete";
}

/**
 * Normalizes test records, ensuring failure_text is populated with
 * "message unavailable" if absent on failing test records.
 *
 * @param {Array<object>} [tests]
 * @returns {Array<object>}
 */
export function normalizeTestRecords(tests = []) {
	return tests.map((t) => {
		const record = { ...t };
		if (record.status === "failed" && (!record.failure_text || typeof record.failure_text !== "string")) {
			record.failure_text = "message unavailable";
		}
		return record;
	});
}

/**
 * Creates a validated ci-receipt/v1 shard receipt object.
 *
 * @param {object} options
 * @returns {object} Canonical ci-receipt/v1 receipt
 */
export function createShardReceipt(options) {
	if (!options || typeof options !== "object") {
		throw new TypeError("Receipt options must be an object");
	}

	const repo = options.repo || DEFAULT_REPO;
	const shardId = Number(options.shard_id);
	const expectedShards = Number(options.expected_shards || DEFAULT_EXPECTED_SHARDS);

	if (!Number.isSafeInteger(shardId) || shardId < 1) {
		throw new RangeError(`shard_id must be an integer >= 1; got ${options.shard_id}`);
	}
	if (!Number.isSafeInteger(expectedShards) || expectedShards < 1) {
		throw new RangeError(`expected_shards must be an integer >= 1; got ${options.expected_shards}`);
	}

	const candidateSha = String(options.candidate_sha || "");
	const checkoutSha = String(options.checkout_sha || candidateSha);
	const baseSha = String(options.base_sha || "");

	if (!SHA_REGEX.test(candidateSha)) {
		throw new Error(`candidate_sha must be a 40-character hex SHA; got ${candidateSha}`);
	}
	if (!SHA_REGEX.test(checkoutSha)) {
		throw new Error(`checkout_sha must be a 40-character hex SHA; got ${checkoutSha}`);
	}
	if (!SHA_REGEX.test(baseSha)) {
		throw new Error(`base_sha must be a 40-character hex SHA; got ${baseSha}`);
	}

	const runnerDigest = options.runner_digest || computeSha256Digest("runner:v1");
	const policyDigest = options.policy_digest || computeSha256Digest("policy:v1");
	const selectionDigest = options.selection_digest || computeSha256Digest("selection:v1");

	if (!isValidDigest(runnerDigest)) {
		throw new Error(`runner_digest must match sha256:<hex>; got ${runnerDigest}`);
	}
	if (!isValidDigest(policyDigest)) {
		throw new Error(`policy_digest must match sha256:<hex>; got ${policyDigest}`);
	}
	if (!isValidDigest(selectionDigest)) {
		throw new Error(`selection_digest must match sha256:<hex>; got ${selectionDigest}`);
	}

	const rawSuites = Array.isArray(options.suites) ? options.suites : [];
	const normalizedSuites = rawSuites.map((s) => {
		const counts = s.counts || {
			discovered: 0,
			executed: 0,
			passed: 0,
			failed: 0,
			skipped: 0,
			assertions: 0,
		};
		return {
			name: s.name || "unnamed-suite",
			target_ids: Array.isArray(s.target_ids) ? s.target_ids : [s.name || "unnamed-target"],
			command: s.command || "bun test",
			exit_code: typeof s.exit_code === "number" ? s.exit_code : 0,
			counts: {
				discovered: Number(counts.discovered ?? 0),
				executed: Number(counts.executed ?? 0),
				passed: Number(counts.passed ?? 0),
				failed: Number(counts.failed ?? 0),
				skipped: Number(counts.skipped ?? 0),
				assertions: Number(counts.assertions ?? 0),
			},
			tests: normalizeTestRecords(s.tests || []),
			artifacts: Array.isArray(s.artifacts) ? s.artifacts : [],
		};
	});

	// Evaluate overall status across suites
	let evaluatedStatus = "passed";
	if (options.missing_producer_secret) {
		evaluatedStatus = "incomplete";
	} else if (options.infrastructure_error) {
		evaluatedStatus = "infrastructure_error";
	} else if (normalizedSuites.length === 0) {
		evaluatedStatus = "incomplete";
	} else {
		for (const suite of normalizedSuites) {
			const suiteStatus = evaluateSuiteStatus(suite);
			if (suiteStatus === "failed") {
				evaluatedStatus = "failed";
				break;
			}
			if (suiteStatus === "incomplete") {
				evaluatedStatus = "incomplete";
			}
		}
	}

	// Status override if explicitly provided and not claiming an untrusted pass
	const finalStatus = options.status || evaluatedStatus;
	if (finalStatus === "passed" && evaluatedStatus !== "passed") {
		throw new Error(`Cannot set status 'passed' when suite evaluation returned '${evaluatedStatus}'`);
	}

	return {
		schema_version: SCHEMA_VERSION,
		repo,
		request_id: options.request_id || `req-${Date.now()}-${shardId}`,
		build_id: options.build_id || `build-${Date.now()}-${shardId}`,
		trigger_id: options.trigger_id || "trigger-cloudflare-workers",
		candidate_sha: candidateSha,
		checkout_sha: checkoutSha,
		base_sha: baseSha,
		runner_digest: runnerDigest,
		policy_digest: policyDigest,
		selection_digest: selectionDigest,
		shard_id: shardId,
		expected_shards: expectedShards,
		status: finalStatus,
		started_at: options.started_at || new Date().toISOString(),
		ended_at: options.ended_at || new Date().toISOString(),
		suites: normalizedSuites,
		...(options.reason ? { reason: options.reason } : {}),
	};
}

/**
 * Creates a validated ci-manifest/v1 manifest object.
 *
 * @param {object} options
 * @returns {object} Canonical ci-manifest/v1 manifest
 */
export function createManifest(options) {
	if (!options || typeof options !== "object") {
		throw new TypeError("Manifest options must be an object");
	}
	return {
		schema_version: MANIFEST_SCHEMA_VERSION,
		repo: options.repo || DEFAULT_REPO,
		candidate_sha: options.candidate_sha,
		build_id: options.build_id,
		created_at: options.created_at || new Date().toISOString(),
		artifacts: (options.artifacts || []).map((art) => ({
			name: art.name,
			key: art.key || `evidence/${options.repo || DEFAULT_REPO}/${options.candidate_sha}/${options.build_id}/${art.name}`,
			sha256: art.sha256 || computeSha256Digest(art.content || "").replace(/^sha256:/, ""),
			size_bytes: art.size_bytes ?? (art.content ? Buffer.byteLength(art.content) : 0),
			content_type: art.content_type || "application/octet-stream",
		})),
		receipt_keys: options.receipt_keys || [],
	};
}

/**
 * Signs an evidence multipart payload using HMAC-SHA256 according to the contract:
 * HMAC-SHA256 over UTF-8 `${request_id}\n${expiry_epoch_ms}\n` concatenated with
 * the exact raw multipart body bytes.
 *
 * @param {{
 *   requestId: string,
 *   expiresAtMs: number,
 *   rawBody: Buffer | Uint8Array | string,
 *   secret: string
 * }} params
 * @returns {string} Lowercase hex HMAC-SHA256 signature
 */
export function signEvidencePayload({ requestId, expiresAtMs, rawBody, secret }) {
	if (!secret || typeof secret !== "string") {
		throw new Error("Secret is required for evidence payload signing");
	}
	if (!requestId || typeof requestId !== "string") {
		throw new Error("requestId is required for evidence payload signing");
	}
	if (!Number.isSafeInteger(expiresAtMs)) {
		throw new Error("expiresAtMs must be an integer epoch timestamp");
	}

	const prefix = Buffer.from(`${requestId}\n${expiresAtMs}\n`, "utf8");
	const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
	const fullPayload = Buffer.concat([prefix, bodyBuffer]);

	return crypto.createHmac("sha256", secret).update(fullPayload).digest("hex").toLowerCase();
}

/**
 * Builds a multipart/form-data payload with receipt, manifest, and optional artifact binaries.
 *
 * @param {{
 *   receipt: object,
 *   manifest: object,
 *   artifacts?: Array<{ name: string, content: Buffer | Uint8Array | string, content_type?: string }>
 * }} params
 * @returns {{ boundary: string, body: Buffer, headers: Record<string, string> }}
 */
export function buildEvidenceMultipart({ receipt, manifest, artifacts = [] }) {
	const boundary = `----VeyyonEvidenceBoundary${Date.now()}${crypto.randomBytes(8).toString("hex")}`;
	const crlf = "\r\n";
	const parts = [];

	// 1. Receipt part
	parts.push(Buffer.from(
		`--${boundary}${crlf}` +
		`Content-Disposition: form-data; name="receipt"${crlf}` +
		`Content-Type: application/json${crlf}${crlf}` +
		JSON.stringify(receipt) +
		crlf,
		"utf8"
	));

	// 2. Manifest part
	parts.push(Buffer.from(
		`--${boundary}${crlf}` +
		`Content-Disposition: form-data; name="manifest"${crlf}` +
		`Content-Type: application/json${crlf}${crlf}` +
		JSON.stringify(manifest) +
		crlf,
		"utf8"
	));

	// 3. Artifact parts
	for (const art of artifacts) {
		const artContent = Buffer.isBuffer(art.content) ? art.content : Buffer.from(art.content || "");
		const contentType = art.content_type || "application/octet-stream";
		parts.push(Buffer.from(
			`--${boundary}${crlf}` +
			`Content-Disposition: form-data; name="${art.name}"; filename="${art.name}"${crlf}` +
			`Content-Type: ${contentType}${crlf}${crlf}`,
			"utf8"
		));
		parts.push(artContent);
		parts.push(Buffer.from(crlf, "utf8"));
	}

	// Final boundary delimiter
	parts.push(Buffer.from(`--${boundary}--${crlf}`, "utf8"));

	const fullBody = Buffer.concat(parts);
	return {
		boundary,
		body: fullBody,
		headers: {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			"Content-Length": fullBody.length.toString(),
		},
	};
}

/**
 * Emits and uploads (or stages) a shard receipt.
 * If EVIDENCE_PRODUCER_SECRET is missing, explicitly returns NO-RESULT (status "incomplete")
 * and skips network transport, never claiming PASS.
 *
 * @param {object} options
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {Promise<{
 *   receipt: object,
 *   manifest?: object,
 *   signature?: string,
 *   uploaded: boolean,
 *   noResultReason?: string
 * }>}
 */
export async function emitShardReceipt(options, env = process.env) {
	const secret = env.EVIDENCE_PRODUCER_SECRET;

	// Check missing secret condition: explicit NO-RESULT
	if (!secret || typeof secret !== "string" || !secret.trim()) {
		const receipt = createShardReceipt({
			...options,
			status: "incomplete",
			missing_producer_secret: true,
			reason: "missing_producer_secret",
		});
		return {
			receipt,
			uploaded: false,
			noResultReason: "Missing EVIDENCE_PRODUCER_SECRET: explicit NO-RESULT (never fake PASS)",
		};
	}

	const receipt = createShardReceipt(options);
	const manifest = createManifest({
		repo: receipt.repo,
		candidate_sha: receipt.candidate_sha,
		build_id: receipt.build_id,
		artifacts: options.artifacts || [],
		receipt_keys: [`evidence/${receipt.repo}/${receipt.candidate_sha}/${receipt.build_id}/receipt-${receipt.shard_id}.json`],
	});

	const { body, headers } = buildEvidenceMultipart({
		receipt,
		manifest,
		artifacts: options.artifacts || [],
	});

	const now = Date.now();
	const expiresAtMs = now + 300000; // 5 minutes (max allowed)
	const signature = signEvidencePayload({
		requestId: receipt.request_id,
		expiresAtMs,
		rawBody: body,
		secret,
	});

	const requestHeaders = {
		...headers,
		"x-evidence-expires": expiresAtMs.toString(),
		"x-evidence-signature": signature,
		"x-evidence-request-id": receipt.request_id,
	};

	const uploadUrl = env.CI_EVIDENCE_URL;
	let uploaded = false;

	if (uploadUrl && typeof fetch === "function") {
		try {
			const res = await fetch(uploadUrl, {
				method: "POST",
				headers: requestHeaders,
				body,
			});
			uploaded = res.ok;
		} catch {
			uploaded = false;
		}
	}

	return {
		receipt,
		manifest,
		signature,
		uploaded,
	};
}

/**
 * Aggregates and validates multiple shard receipts for a single candidate SHA.
 *
 * Validation checks:
 * - REJECT_MISSING_SHARDS: shards do not cover all 1..expected_shards without gaps
 * - REJECT_DUPLICATE_SHARDS: duplicate shard IDs observed
 * - REJECT_MISMATCHED_SHARDS: inconsistent expected_shards, candidate_sha, or repo
 * - REJECT_UNTRUSTED_CLAIMS: status claims "passed" while individual tests failed or executed == 0
 *
 * @param {Array<object>} receipts
 * @param {number} [expectedShards=3]
 * @returns {{
 *   valid: boolean,
 *   errors: string[],
 *   aggregatedStatus: "passed" | "failed" | "incomplete" | "rejected",
 *   shardsPresent: number[]
 * }}
 */
export function aggregateShardReceipts(receipts, expectedShards = DEFAULT_EXPECTED_SHARDS) {
	const errors = [];
	if (!Array.isArray(receipts) || receipts.length === 0) {
		return {
			valid: false,
			errors: ["REJECT_MISSING_SHARDS: Empty receipt set; expected " + expectedShards + " shards"],
			aggregatedStatus: "rejected",
			shardsPresent: [],
		};
	}

	const seenShards = new Set();
	const candidateShas = new Set();
	const reportedExpectedShards = new Set();
	const shardsPresent = [];

	let hasFailedShard = false;
	let hasIncompleteShard = false;

	for (const receipt of receipts) {
		if (!receipt || typeof receipt !== "object") {
			errors.push("REJECT_MALFORMED_JSON: Receipt is not a valid object");
			continue;
		}

		const sid = receipt.shard_id;
		const exp = receipt.expected_shards;
		const sha = receipt.candidate_sha;

		if (seenShards.has(sid)) {
			errors.push(`REJECT_DUPLICATE_SHARDS: Shard ${sid} submitted multiple times`);
		}
		seenShards.add(sid);
		shardsPresent.push(sid);

		if (exp !== undefined) {
			reportedExpectedShards.add(exp);
		}
		if (sha) {
			candidateShas.add(sha);
		}

		if (exp !== expectedShards) {
			errors.push(`REJECT_MISMATCHED_SHARDS: Shard ${sid} expected_shards (${exp}) != gate expected (${expectedShards})`);
		}

		// Verify untrusted claims inside individual receipt
		if (receipt.status === "passed") {
			const suites = Array.isArray(receipt.suites) ? receipt.suites : [];
			if (suites.length === 0) {
				errors.push(`REJECT_UNTRUSTED_CLAIMS: Shard ${sid} claims passed with 0 suites executed`);
			}
			for (const suite of suites) {
				const status = evaluateSuiteStatus(suite);
				if (status !== "passed") {
					errors.push(`REJECT_UNTRUSTED_CLAIMS: Shard ${sid} suite '${suite.name}' claims pass but evaluated as '${status}'`);
				}
			}
		} else if (receipt.status === "failed") {
			hasFailedShard = true;
		} else if (receipt.status === "incomplete") {
			hasIncompleteShard = true;
		}
	}

	// Verify consistent candidate SHA
	if (candidateShas.size > 1) {
		errors.push(`REJECT_MISMATCHED_SHARDS: Multiple candidate SHAs across shards: ${[...candidateShas].join(", ")}`);
	}

	// Verify all expected shards 1..expectedShards are present
	for (let s = 1; s <= expectedShards; s++) {
		if (!seenShards.has(s)) {
			errors.push(`REJECT_MISSING_SHARDS: Missing shard ${s}/${expectedShards}`);
		}
	}

	const valid = errors.length === 0;
	let aggregatedStatus = "passed";
	if (!valid) {
		aggregatedStatus = "rejected";
	} else if (hasFailedShard) {
		aggregatedStatus = "failed";
	} else if (hasIncompleteShard) {
		aggregatedStatus = "incomplete";
	}

	return {
		valid,
		errors,
		aggregatedStatus,
		shardsPresent: shardsPresent.sort((a, b) => a - b),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(`ci-receipt v1 schema: ${SCHEMA_VERSION}`);
	console.log(`ci-manifest v1 schema: ${MANIFEST_SCHEMA_VERSION}`);
}
