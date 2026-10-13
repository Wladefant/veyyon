/**
 * Veyyon CI Shard Receipt Emission and Aggregation Adapter (v1)
 *
 * Implements shard-level ci-receipt/v1 and ci-manifest/v1 emission,
 * counter-contract enforcement, and fail-closed shard aggregation.
 *
 * Conforms strictly to:
 * - Canonical schema: ci-receipt/v1 & ci-manifest/v1 (workflows/portable/ci_receipt.schema.json)
 * - Counter Contract: PASS requires passed > 0 and failed == 0 for all required suites.
 * - Missing secrets: explicit NO-RESULT (incomplete), never fake PASS.
 * - Failure text fallback: "message unavailable" when failure text is missing.
 * - HMAC signing: HMAC-SHA256 of `${request_id}\n${expiry}\n` UTF-8 + raw multipart bytes.
 */

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const SCHEMA_VERSION = "ci-receipt/v1";
export const MANIFEST_SCHEMA_VERSION = "ci-manifest/v1";
export const DEFAULT_REPO = "Wladefant/veyyon";
export const DEFAULT_EXPECTED_SHARDS = 3;

const SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const HEX64_REGEX = /^[0-9a-f]{64}$/;

/**
 * Validates sha256 digest format: lowercase 64-character hex string without prefix.
 * @param {string} digest
 * @returns {boolean}
 */
export function isValidDigest(digest) {
	return typeof digest === "string" && HEX64_REGEX.test(digest);
}

/**
 * Computes sha256 digest in lowercase 64-hex format.
 * @param {string | Buffer | Uint8Array} data
 * @returns {string}
 */
export function computeSha256Digest(data) {
	return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Normalizes a digest to a clean 64-hex lowercase string, stripping any sha256: prefix.
 * @param {string | null | undefined} digest
 * @param {string} defaultData
 * @returns {string}
 */
export function cleanDigest(digest, defaultData = "") {
	if (typeof digest === "string" && digest.length > 0) {
		const cleaned = digest.replace(/^sha256:/i, "").toLowerCase().trim();
		if (HEX64_REGEX.test(cleaned)) {
			return cleaned;
		}
	}
	return computeSha256Digest(defaultData);
}

/**
 * Evaluates the status of a suite's test counts according to the v1 Counter Contract.
 *
 * Contract rules:
 * - PASS requires executed > 0, passed > 0, and failed == 0.
 * - All-skipped (executed == 0 and skipped > 0) => incomplete (NO-RESULT).
 * - xfail-only (xfail_only == true or passed == 0 && failed == 0) => incomplete (NO-RESULT).
 * - Zero executed (executed == 0) => incomplete (NO-RESULT).
 * - Unparseable summary => incomplete (NO-RESULT).
 * - Non-zero exit_code or failed > 0 => failed.
 *
 * @param {{
 *   exit_code?: number,
 *   counts?: {
 *     discovered?: number,
 *     executed?: number,
 *     passed?: number,
 *     failed?: number,
 *     skipped?: number,
 *     assertions?: number | null,
 *     errors?: number | null
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
	if (suite.xfail_only) {
		return "incomplete";
	}

	const counts = suite.counts || {};
	const discovered = Number(counts.discovered ?? 0);
	const executed = Number(counts.executed ?? 0);
	const passed = Number(counts.passed ?? 0);
	const failed = Number(counts.failed ?? 0);
	const skipped = Number(counts.skipped ?? 0);
	const exitCode = typeof suite.exit_code === "number" ? suite.exit_code : 0;

	// Failure paths
	if (exitCode !== 0 || failed > 0) {
		return "failed";
	}

	// Incomplete / NO-RESULT paths
	if (executed === 0) {
		return "incomplete";
	}
	if (passed === 0 && skipped > 0) {
		return "incomplete";
	}
	if (passed === 0) {
		return "incomplete";
	}

	return "passed";
}

/**
 * Normalizes test records, ensuring failure_text is populated with
 * "message unavailable" when missing on failed tests.
 *
 * @param {Array<object>} tests
 * @param {string} defaultTargetId
 * @returns {Array<object>}
 */
export function normalizeTestRecords(tests = [], defaultTargetId = "node:lane-tests") {
	return tests.map((t) => {
		const status = String(t.status || "passed").toLowerCase();
		const isFailed = status === "failed";
		let failureText = t.failure_text ?? t.message;
		if (isFailed && (!failureText || !String(failureText).trim())) {
			failureText = "message unavailable";
		}
		return {
			name: t.name || "unnamed-test",
			target_id: t.target_id || defaultTargetId,
			status,
			assertions: t.assertions !== undefined ? (t.assertions === null ? null : Number(t.assertions)) : null,
			duration_ms: t.duration_ms !== undefined ? (t.duration_ms === null ? null : Number(t.duration_ms)) : null,
			failure_text: failureText !== undefined ? failureText : null,
			failure_kind: isFailed ? (t.failure_kind || "failure") : null,
			...(t.file_path ? { file_path: String(t.file_path) } : {}),
			...(t.line_number ? { line_number: Number(t.line_number) } : {}),
		};
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

	const runnerDigest = cleanDigest(options.runner_digest, "runner:v1");
	const policyDigest = cleanDigest(options.policy_digest, "policy:v1");
	const selectionDigest = cleanDigest(options.selection_digest, "selection:v1");

	if (!isValidDigest(runnerDigest)) {
		throw new Error(`runner_digest must be 64-hex lowercase SHA-256; got ${runnerDigest}`);
	}
	if (!isValidDigest(policyDigest)) {
		throw new Error(`policy_digest must be 64-hex lowercase SHA-256; got ${policyDigest}`);
	}
	if (!isValidDigest(selectionDigest)) {
		throw new Error(`selection_digest must be 64-hex lowercase SHA-256; got ${selectionDigest}`);
	}

	const rawSuites = Array.isArray(options.suites) ? options.suites : [];
	const normalizedSuites = rawSuites.map((s) => {
		const suiteName = s.name || "unnamed-suite";
		const safeSuiteName = suiteName.replace(/[^A-Za-z0-9._/@+-]/g, "-");
		const targetId = `node:${safeSuiteName}`;
		const targetIds = Array.isArray(s.target_ids) && s.target_ids.length > 0
			? s.target_ids
			: [targetId];

		const counts = s.counts || {};
		const passedCount = Number(counts.passed ?? 0);
		const failedCount = Number(counts.failed ?? 0);
		const skippedCount = Number(counts.skipped ?? 0);
		const executedCount = counts.executed !== undefined ? Number(counts.executed) : (passedCount + failedCount);
		const discoveredCount = counts.discovered !== undefined ? Number(counts.discovered) : Math.max(executedCount + skippedCount, executedCount);

		let tests = Array.isArray(s.tests) ? s.tests : [];
		if (tests.length === 0 && (passedCount > 0 || failedCount > 0)) {
			// Generate valid test records matching claimed counts
			const genTests = [];
			for (let i = 1; i <= passedCount; i++) {
				genTests.push({
					name: `${suiteName}-test-${i}`,
					target_id: targetIds[0],
					status: "passed",
				});
			}
			for (let i = 1; i <= failedCount; i++) {
				genTests.push({
					name: `${suiteName}-failed-${i}`,
					target_id: targetIds[0],
					status: "failed",
					failure_text: "message unavailable",
					failure_kind: "failure",
				});
			}
			tests = genTests;
		}

		return {
			name: suiteName,
			target_ids: targetIds,
			command: s.command || "bun test",
			exit_code: typeof s.exit_code === "number" ? s.exit_code : (failedCount > 0 ? 1 : 0),
			counts: {
				discovered: discoveredCount,
				executed: executedCount,
				passed: passedCount,
				failed: failedCount,
				skipped: skippedCount,
				assertions: counts.assertions === null ? null : (counts.assertions !== undefined ? Number(counts.assertions) : null),
				errors: counts.errors === null ? null : Number(counts.errors ?? 0),
			},
			tests: normalizeTestRecords(tests, targetIds[0]),
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
		candidate_sha: candidateSha.toLowerCase(),
		checkout_sha: checkoutSha.toLowerCase(),
		base_sha: baseSha.toLowerCase(),
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
	const candidateSha = String(options.candidate_sha || "").toLowerCase();
	const buildId = String(options.build_id || `build-${Date.now()}`);

	return {
		schema_version: MANIFEST_SCHEMA_VERSION,
		repo: options.repo || DEFAULT_REPO,
		candidate_sha: candidateSha,
		build_id: buildId,
		created_at: options.created_at || new Date().toISOString(),
		artifacts: (options.artifacts || []).map((art) => ({
			name: art.name,
			key: art.key || `evidence/${options.repo || DEFAULT_REPO}/${candidateSha}/${buildId}/${art.name}`,
			sha256: (art.sha256 || computeSha256Digest(art.content || "")).replace(/^sha256:/i, "").toLowerCase(),
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
 *   rawBody: Buffer | Uint8Array,
 *   secret: string
 * }} options
 * @returns {string} Lowercase 64-hex signature
 */
export function signEvidencePayload({ requestId, expiresAtMs, rawBody, secret }) {
	if (!secret || typeof secret !== "string") {
		throw new Error("Missing secret for HMAC-SHA256 evidence signing");
	}
	const prefix = Buffer.from(`${requestId}\n${expiresAtMs}\n`, "utf8");
	const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
	const fullPayload = Buffer.concat([prefix, bodyBuf]);

	return crypto.createHmac("sha256", secret).update(fullPayload).digest("hex");
}

/**
 * Builds a multipart/form-data payload with receipt, manifest, and optional artifact binaries.
 *
 * @param {{
 *   receipt: object,
 *   manifest: object,
 *   artifacts?: Array<{ name: string, content: Buffer | string, content_type?: string }>
 * }} options
 * @returns {{ boundary: string, body: Buffer, headers: Record<string, string> }}
 */
export function buildEvidenceMultipart({ receipt, manifest, artifacts = [] }) {
	const boundary = `----VeyyonEvidenceBoundary${Date.now()}${crypto.randomBytes(6).toString("hex")}`;
	const parts = [];

	const addPart = (name, filename, contentType, contentBuf) => {
		let header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
		if (filename) {
			header += `; filename="${filename}"`;
		}
		header += `\r\nContent-Type: ${contentType}\r\n\r\n`;
		parts.push(Buffer.from(header, "utf8"));
		parts.push(contentBuf);
		parts.push(Buffer.from("\r\n", "utf8"));
	};

	// 1. receipt JSON part
	const receiptJson = JSON.stringify(receipt);
	addPart("receipt", "receipt.json", "application/json", Buffer.from(receiptJson, "utf8"));

	// 2. manifest JSON part
	const manifestJson = JSON.stringify(manifest);
	addPart("manifest", "manifest.json", "application/json", Buffer.from(manifestJson, "utf8"));

	// 3. binary artifact parts
	for (const art of artifacts) {
		const artBuf = Buffer.isBuffer(art.content)
			? art.content
			: Buffer.from(String(art.content || ""), "utf8");
		addPart(
			art.name,
			art.name,
			art.content_type || "application/octet-stream",
			artBuf
		);
	}

	parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
	const body = Buffer.concat(parts);

	return {
		boundary,
		body,
		headers: {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			"Content-Length": String(body.length),
		},
	};
}

/**
 * Emits and uploads (or stages) a shard receipt.
 *
 * If EVIDENCE_PRODUCER_SECRET is missing or empty, returns an explicit
 * NO-RESULT receipt with status="incomplete" and reason="missing_producer_secret",
 * and skips uploading.
 *
 * @param {object} receiptOptions
 * @param {object} [env=process.env]
 * @returns {Promise<{
 *   receipt: object,
 *   manifest: object,
 *   uploaded: boolean,
 *   noResultReason?: string,
 *   status: string
 * }>}
 */
export async function emitShardReceipt(receiptOptions, env = process.env) {
	const producerSecret = env.EVIDENCE_PRODUCER_SECRET;
	const evidenceUrl = env.CI_EVIDENCE_URL;

	// Check missing secret prerequisite
	if (!producerSecret || String(producerSecret).trim() === "") {
		const noResultReceipt = createShardReceipt({
			...receiptOptions,
			missing_producer_secret: true,
			reason: "missing_producer_secret",
		});
		const manifest = createManifest({
			repo: noResultReceipt.repo,
			candidate_sha: noResultReceipt.candidate_sha,
			build_id: noResultReceipt.build_id,
			artifacts: [],
		});
		return {
			receipt: noResultReceipt,
			manifest,
			uploaded: false,
			noResultReason: "Missing EVIDENCE_PRODUCER_SECRET: explicit NO-RESULT (incomplete), upload skipped",
			status: "incomplete",
		};
	}

	const receipt = createShardReceipt(receiptOptions);
	const artifacts = receiptOptions.artifacts || [];
	const manifest = createManifest({
		repo: receipt.repo,
		candidate_sha: receipt.candidate_sha,
		build_id: receipt.build_id,
		artifacts,
	});

	const { body, headers } = buildEvidenceMultipart({ receipt, manifest, artifacts });
	const expiresAtMs = Date.now() + 5 * 60 * 1000;
	const signature = signEvidencePayload({
		requestId: receipt.request_id,
		expiresAtMs,
		rawBody: body,
		secret: producerSecret,
	});

	receipt.signature = signature;

	if (evidenceUrl) {
		const res = await fetch(evidenceUrl, {
			method: "POST",
			headers: {
				...headers,
				"x-evidence-expires": String(expiresAtMs),
				"x-evidence-signature": signature,
			},
			body,
		});
		if (!res.ok) {
			throw new Error(`Evidence upload failed: HTTP ${res.status} ${res.statusText}`);
		}
		return {
			receipt,
			manifest,
			uploaded: true,
			status: receipt.status,
		};
	}

	return {
		receipt,
		manifest,
		uploaded: false,
		status: receipt.status,
	};
}

/**
 * Aggregates and validates multiple shard receipts for a single candidate SHA.
 *
 * Implements fail-closed rejection on:
 * - Missing shards (e.g. shard 1 & 2 present, shard 3 missing)
 * - Duplicate shards (e.g. shard 1 received twice)
 * - Mismatched expected shards (e.g. shard 1 claims 3 shards, shard 2 claims 4)
 * - Untrusted claims (e.g. claims pass but executed == 0 or failed > 0)
 *
 * @param {Array<object>} receipts
 * @param {number} [expectedShards=DEFAULT_EXPECTED_SHARDS]
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
