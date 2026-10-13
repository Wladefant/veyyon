import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	SCHEMA_VERSION,
	MANIFEST_SCHEMA_VERSION,
	DEFAULT_REPO,
	DEFAULT_EXPECTED_SHARDS,
	isValidDigest,
	computeSha256Digest,
	cleanDigest,
	evaluateSuiteStatus,
	normalizeTestRecords,
	createShardReceipt,
	createManifest,
	signEvidencePayload,
	buildEvidenceMultipart,
	emitShardReceipt,
	aggregateShardReceipts,
} from "./shard-receipt.mjs";
import {
	OBSERVED_SUITE_DURATIONS_SECONDS,
	resolveShardForSuite,
	filterSuitesForShard,
	calculateObservedShardDuration,
} from "./partition-adapter.mjs";
import {
	validateReceiptSyntax,
	validateCiReceipt,
	RejectionCode,
} from "./ci_receipt.mjs";

const readFixture = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const TEST_CANDIDATE_SHA = "56326a39dee8a9c26629b4cedef5563201ad5d85";
const TEST_BASE_SHA = "d19980e65de352e00b952ae20dd4944159907459";

// 1. Shard Receipt Contract & Validation
test("createShardReceipt produces valid ci-receipt/v1 structure conforming to canonical validator", () => {
	const receipt = createShardReceipt({
		repo: DEFAULT_REPO,
		candidate_sha: TEST_CANDIDATE_SHA,
		base_sha: TEST_BASE_SHA,
		shard_id: 1,
		expected_shards: 3,
		suites: [
			{
				name: "health-worker",
				target_ids: ["node:health-worker"],
				counts: { discovered: 2, executed: 2, passed: 2, failed: 0, skipped: 0, assertions: 4, errors: 0 },
				tests: [
					{ name: "test-1", target_id: "node:health-worker", status: "passed" },
					{ name: "test-2", target_id: "node:health-worker", status: "passed" },
				],
			},
		],
	});

	assert.equal(receipt.schema_version, SCHEMA_VERSION);
	assert.equal(receipt.repo, DEFAULT_REPO);
	assert.equal(receipt.candidate_sha, TEST_CANDIDATE_SHA);
	assert.equal(receipt.checkout_sha, TEST_CANDIDATE_SHA);
	assert.equal(receipt.base_sha, TEST_BASE_SHA);
	assert.equal(receipt.shard_id, 1);
	assert.equal(receipt.expected_shards, 3);
	assert.equal(receipt.status, "passed");
	assert.ok(isValidDigest(receipt.runner_digest));
	assert.ok(isValidDigest(receipt.policy_digest));
	assert.ok(isValidDigest(receipt.selection_digest));

	// Test syntax against canonical validator
	const syntaxCheck = validateReceiptSyntax(receipt);
	assert.equal(syntaxCheck.ok, true, syntaxCheck.error);
});

test("createShardReceipt enforces 40-character hex SHA validation", () => {
	assert.throws(
		() => createShardReceipt({
			candidate_sha: "invalid-sha",
			base_sha: TEST_BASE_SHA,
			shard_id: 1,
		}),
		/candidate_sha must be a 40-character hex SHA/
	);
	assert.throws(
		() => createShardReceipt({
			candidate_sha: TEST_CANDIDATE_SHA,
			base_sha: "short",
			shard_id: 1,
		}),
		/base_sha must be a 40-character hex SHA/
	);
});

test("cleanDigest normalizes digests to lowercase 64-hex string", () => {
	const hex = computeSha256Digest("test-digest");
	assert.equal(cleanDigest(`sha256:${hex}`), hex);
	assert.equal(cleanDigest(hex), hex);
	assert.equal(isValidDigest(hex), true);
	assert.equal(isValidDigest(`sha256:${hex}`), false);
});

// 2. Counter Contract Enforcement & Ruling
test("evaluateSuiteStatus: PASS requires passed > 0 and failed == 0", () => {
	assert.equal(
		evaluateSuiteStatus({ counts: { discovered: 10, executed: 10, passed: 10, failed: 0, skipped: 0 } }),
		"passed"
	);
});

test("evaluateSuiteStatus: 1 failed with 0 passed yields FAIL", () => {
	assert.equal(
		evaluateSuiteStatus({ exit_code: 1, counts: { discovered: 1, executed: 1, passed: 0, failed: 1, skipped: 0 } }),
		"failed"
	);
});

test("evaluateSuiteStatus: all-skipped yields incomplete (NO-RESULT)", () => {
	assert.equal(
		evaluateSuiteStatus({ counts: { discovered: 10, executed: 0, passed: 0, failed: 0, skipped: 10 } }),
		"incomplete"
	);
});

test("evaluateSuiteStatus: xfail-only yields incomplete (NO-RESULT)", () => {
	assert.equal(
		evaluateSuiteStatus({ xfail_only: true, counts: { discovered: 5, executed: 0, passed: 0, failed: 0, skipped: 0 } }),
		"incomplete"
	);
});

test("evaluateSuiteStatus: zero executed yields incomplete (NO-RESULT)", () => {
	assert.equal(
		evaluateSuiteStatus({ counts: { discovered: 0, executed: 0, passed: 0, failed: 0, skipped: 0 } }),
		"incomplete"
	);
});

test("evaluateSuiteStatus: unparseable summary yields incomplete (NO-RESULT)", () => {
	assert.equal(
		evaluateSuiteStatus({ unparseable: true, counts: { discovered: 0, executed: 0, passed: 0, failed: 0, skipped: 0 } }),
		"incomplete"
	);
});

test("normalizeTestRecords supplies 'message unavailable' when failing test has no failure_text", () => {
	const records = normalizeTestRecords([
		{ name: "test-one", target_id: "node:test", status: "failed" },
		{ name: "test-two", target_id: "node:test", status: "failed", failure_text: "assertion error" },
		{ name: "test-three", target_id: "node:test", status: "passed" },
	]);
	assert.equal(records[0].failure_text, "message unavailable");
	assert.equal(records[1].failure_text, "assertion error");
	assert.equal(records[2].failure_text, null);
});

// 3. Secret Prerequisite Handling
test("emitShardReceipt returns explicit NO-RESULT when EVIDENCE_PRODUCER_SECRET is missing", async () => {
	const result = await emitShardReceipt(
		{
			candidate_sha: TEST_CANDIDATE_SHA,
			base_sha: TEST_BASE_SHA,
			shard_id: 1,
			suites: [
				{
					name: "health-worker",
					target_ids: ["node:health-worker"],
					counts: { discovered: 1, executed: 1, passed: 1, failed: 0, skipped: 0 },
				},
			],
		},
		{} // Empty env: no EVIDENCE_PRODUCER_SECRET
	);

	assert.equal(result.uploaded, false);
	assert.equal(result.receipt.status, "incomplete");
	assert.equal(result.receipt.reason, "missing_producer_secret");
	assert.match(result.noResultReason, /Missing EVIDENCE_PRODUCER_SECRET: explicit NO-RESULT/);
});

// 4. HMAC Signing & Multipart Packaging
test("signEvidencePayload computes HMAC-SHA256 signature correctly", () => {
	const requestId = "req-12345";
	const expiresAtMs = 1760000000000;
	const body = Buffer.from("test multipart payload bytes", "utf8");
	const secret = "super-secret-producer-key";

	const sig = signEvidencePayload({
		requestId,
		expiresAtMs,
		rawBody: body,
		secret,
	});

	assert.match(sig, /^[0-9a-f]{64}$/);
	const sig2 = signEvidencePayload({
		requestId,
		expiresAtMs,
		rawBody: body,
		secret,
	});
	assert.equal(sig, sig2);
});

test("buildEvidenceMultipart packages receipt, manifest, and artifact parts with headers", () => {
	const receipt = { schema_version: SCHEMA_VERSION, shard_id: 1, status: "passed" };
	const manifest = { schema_version: MANIFEST_SCHEMA_VERSION, artifacts: [] };
	const artifacts = [
		{ name: "junit.xml", content: "<testsuite></testsuite>", content_type: "application/xml" },
	];

	const { boundary, body, headers } = buildEvidenceMultipart({ receipt, manifest, artifacts });
	assert.ok(boundary.startsWith("----VeyyonEvidenceBoundary"));
	assert.ok(body.length > 0);
	assert.ok(headers["Content-Type"].includes(boundary));
	const bodyText = body.toString("utf8");
	assert.ok(bodyText.includes('name="receipt"'));
	assert.ok(bodyText.includes('name="manifest"'));
	assert.ok(bodyText.includes('name="junit.xml"'));
});

// 5. Canonical Validator Execution on Passing Shards
test("passing shard fixtures (1, 2, 3) validate with canonical validator and aggregate to PASSED", async () => {
	const s1 = await readFixture("./fixtures/shard-1-pass.json");
	const s2 = await readFixture("./fixtures/shard-2-pass.json");
	const s3 = await readFixture("./fixtures/shard-3-pass.json");

	// Validate syntax individually
	assert.equal(validateReceiptSyntax(s1).ok, true);
	assert.equal(validateReceiptSyntax(s2).ok, true);
	assert.equal(validateReceiptSyntax(s3).ok, true);

	// Validate aggregation using canonical validator
	const gateResult = validateCiReceipt([s1, s2, s3], {
		expected_shards: 3,
		expected_candidate_sha: TEST_CANDIDATE_SHA,
		expected_base_sha: TEST_BASE_SHA,
		expected_repo: DEFAULT_REPO,
		require_producer_secret: false,
	});

	assert.equal(gateResult.valid, true, gateResult.rejection_reason);
	assert.equal(gateResult.verdict, "PASSED");
	assert.equal(gateResult.passed_tests, 6);
	assert.equal(gateResult.failed_tests, 0);
});

// 6. Fail-Closed Negative Controls
test("negative control: missing shard fixture fails closed with MISSING_SHARDS", async () => {
	const missingShards = await readFixture("./fixtures/missing-shard-receipts.json");
	const gateResult = validateCiReceipt(missingShards, {
		expected_shards: 3,
		expected_candidate_sha: TEST_CANDIDATE_SHA,
		expected_base_sha: TEST_BASE_SHA,
		expected_repo: DEFAULT_REPO,
	});

	assert.equal(gateResult.valid, false);
	assert.equal(gateResult.rejection_code, RejectionCode.MISSING_SHARDS);
});

test("negative control: duplicate shard fixture fails closed with DUPLICATE_SHARDS", async () => {
	const dupShards = await readFixture("./fixtures/duplicate-shard-receipts.json");
	const gateResult = validateCiReceipt(dupShards, {
		expected_shards: 3,
		expected_candidate_sha: TEST_CANDIDATE_SHA,
		expected_base_sha: TEST_BASE_SHA,
		expected_repo: DEFAULT_REPO,
	});

	assert.equal(gateResult.valid, false);
	assert.equal(gateResult.rejection_code, RejectionCode.DUPLICATE_SHARDS);
});

test("negative control: failed-no-reporter-text yields FAILED verdict", async () => {
	const fixture = await readFixture("./fixtures/failed-no-reporter-text.json");
	const gateResult = validateCiReceipt([fixture], {
		expected_shards: 1,
		expected_candidate_sha: TEST_CANDIDATE_SHA,
		expected_base_sha: TEST_BASE_SHA,
		expected_repo: DEFAULT_REPO,
	});

	assert.equal(gateResult.valid, false);
	assert.equal(gateResult.verdict, "FAILED");
	assert.equal(fixture.suites[0].tests[0].failure_text, "message unavailable");
});

test("negative control: error case with failed=1 and errors=1 gives executed=1 (not 2) and yields FAILED", async () => {
	const fixture = await readFixture("./fixtures/failed-error-subset.json");
	const suite = fixture.suites[0];
	assert.equal(suite.counts.failed, 1);
	assert.equal(suite.counts.errors, 1);
	assert.equal(suite.counts.executed, 1); // executed = passed(0) + failed(1) = 1, NOT 2

	const gateResult = validateCiReceipt([fixture], {
		expected_shards: 1,
		expected_candidate_sha: TEST_CANDIDATE_SHA,
		expected_base_sha: TEST_BASE_SHA,
		expected_repo: DEFAULT_REPO,
	});

	assert.equal(gateResult.valid, false);
	assert.equal(gateResult.verdict, "FAILED");
});

test("negative control: no-result-missing-secret yields NO-RESULT", async () => {
	const fixture = await readFixture("./fixtures/no-result-missing-secret.json");
	const gateResult = validateCiReceipt([fixture], {
		expected_shards: 1,
		expected_candidate_sha: TEST_CANDIDATE_SHA,
		expected_base_sha: TEST_BASE_SHA,
		expected_repo: DEFAULT_REPO,
		require_producer_secret: true,
		producer_secret_present: false,
	});

	assert.equal(gateResult.valid, false);
	assert.equal(gateResult.verdict, "NO-RESULT");
	assert.equal(gateResult.rejection_code, RejectionCode.REQUEST_AUTH);
});

test("negative control: all-skipped suite yields NO-RESULT (all-skipped)", async () => {
	const fixture = await readFixture("./fixtures/no-result-all-skipped.json");
	const gateResult = validateCiReceipt([fixture], {
		expected_shards: 1,
		expected_candidate_sha: TEST_CANDIDATE_SHA,
		expected_base_sha: TEST_BASE_SHA,
		expected_repo: DEFAULT_REPO,
	});

	assert.equal(gateResult.valid, false);
	assert.equal(gateResult.verdict, "NO-RESULT");
});

// 7. Partition Adapter Reused Observed Costs
test("partition adapter reuses measured costs from audit log", () => {
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["tests/simulations"], 440.6);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["plugins/hashline"], 379.0);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["packages/ai"], 76.8);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["packages/agent"], 70.6);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["packages/utils"], 40.7);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["health-worker"], 4.5);
});
