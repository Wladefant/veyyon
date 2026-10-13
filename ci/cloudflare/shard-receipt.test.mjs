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
	SUITE_SHARD_ASSIGNMENTS,
	resolveShardForSuite,
	isSuiteAssignedToShard,
	filterSuitesForShard,
	partitionAllSuites,
	calculateObservedShardDuration,
} from "./partition-adapter.mjs";

const readFixture = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const TEST_CANDIDATE_SHA = "7ca99eff372d798f5790f1a5b293da41b53fa14e";
const TEST_BASE_SHA = "d19980e65de352e00b952ae20dd4944159907459";

// 1. Shard Receipt Contract & Validation
test("createShardReceipt produces valid ci-receipt/v1 structure", () => {
	const receipt = createShardReceipt({
		repo: DEFAULT_REPO,
		candidate_sha: TEST_CANDIDATE_SHA,
		base_sha: TEST_BASE_SHA,
		shard_id: 1,
		expected_shards: 3,
		suites: [
			{
				name: "health-worker",
				counts: { discovered: 36, executed: 36, passed: 36, failed: 0, skipped: 0, assertions: 72 },
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
	assert.equal(receipt.suites.length, 1);
	assert.equal(receipt.suites[0].name, "health-worker");
	assert.equal(receipt.suites[0].counts.passed, 36);
});

test("createShardReceipt enforces 40-character hex SHA validation", () => {
	assert.throws(
		() => createShardReceipt({
			candidate_sha: "not-a-valid-sha",
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

test("createShardReceipt enforces integer shard_id and expected_shards >= 1", () => {
	assert.throws(
		() => createShardReceipt({
			candidate_sha: TEST_CANDIDATE_SHA,
			base_sha: TEST_BASE_SHA,
			shard_id: 0,
		}),
		/shard_id must be an integer >= 1/
	);
	assert.throws(
		() => createShardReceipt({
			candidate_sha: TEST_CANDIDATE_SHA,
			base_sha: TEST_BASE_SHA,
			shard_id: 1,
			expected_shards: 0,
		}),
		/expected_shards must be an integer >= 1/
	);
});

// 2. Counter Contract Enforcement
test("evaluateSuiteStatus: PASS requires passed > 0 and failed == 0", () => {
	assert.equal(
		evaluateSuiteStatus({ counts: { discovered: 10, executed: 10, passed: 10, failed: 0, skipped: 0 } }),
		"passed"
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

test("evaluateSuiteStatus: non-zero exit_code or failures yields failed", () => {
	assert.equal(
		evaluateSuiteStatus({ exit_code: 1, counts: { discovered: 10, executed: 10, passed: 9, failed: 1, skipped: 0 } }),
		"failed"
	);
	assert.equal(
		evaluateSuiteStatus({ exit_code: 2 }),
		"failed"
	);
});

test("normalizeTestRecords supplies 'message unavailable' when failing test has no failure_text", () => {
	const records = normalizeTestRecords([
		{ name: "test-one", target_id: "pkg", status: "failed" },
		{ name: "test-two", target_id: "pkg", status: "failed", failure_text: "assertion error" },
		{ name: "test-three", target_id: "pkg", status: "passed" },
	]);
	assert.equal(records[0].failure_text, "message unavailable");
	assert.equal(records[1].failure_text, "assertion error");
	assert.equal(records[2].failure_text, undefined);
});

test("createShardReceipt refuses to set status 'passed' when suite evaluation returned incomplete or failed", () => {
	assert.throws(
		() => createShardReceipt({
			candidate_sha: TEST_CANDIDATE_SHA,
			base_sha: TEST_BASE_SHA,
			shard_id: 1,
			status: "passed",
			suites: [
				{
					name: "empty-suite",
					counts: { discovered: 10, executed: 0, passed: 0, failed: 0, skipped: 10 },
				},
			],
		}),
		/Cannot set status 'passed' when suite evaluation returned 'incomplete'/
	);
});

// 3. Secret Prerequisite & Explicit NO-RESULT
test("emitShardReceipt returns explicit NO-RESULT when EVIDENCE_PRODUCER_SECRET is missing", async () => {
	const result = await emitShardReceipt(
		{
			candidate_sha: TEST_CANDIDATE_SHA,
			base_sha: TEST_BASE_SHA,
			shard_id: 1,
			suites: [
				{
					name: "health-worker",
					counts: { discovered: 10, executed: 10, passed: 10, failed: 0, skipped: 0 },
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

// 4. Transport & HMAC Authentication
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

	// Verify deterministic replay
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
	assert.ok(bodyText.includes("<testsuite></testsuite>"));
});

// 5. Partition Adapter Based on Observed Durations
test("partition adapter reuses observed suite execution costs without inventing estimates", () => {
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["tests/simulations"], 440.6);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["plugins/hashline"], 379.0);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["packages/ai"], 76.8);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["packages/agent"], 70.6);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["packages/utils"], 40.7);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["packages/catalog"], 15.0);
	assert.equal(OBSERVED_SUITE_DURATIONS_SECONDS["health-worker"], 4.5);
});

test("resolveShardForSuite assigns suites to expected shards based on observed data", () => {
	assert.equal(resolveShardForSuite("health-worker"), 1);
	assert.equal(resolveShardForSuite("packages/ai"), 1);
	assert.equal(resolveShardForSuite("packages/agent"), 1);
	assert.equal(resolveShardForSuite("packages/utils"), 1);
	assert.equal(resolveShardForSuite("scripts"), 1);

	assert.equal(resolveShardForSuite("plugins/hashline"), 2);
	assert.equal(resolveShardForSuite("plugins/argot"), 2);

	assert.equal(resolveShardForSuite("tests/simulations"), 3);
	assert.equal(resolveShardForSuite("apps/stats"), 3);
	assert.equal(resolveShardForSuite("plugins/mnemopi"), 3);

	// Native bindings allocated to both shard 1 and shard 2 for dual variant proof
	assert.deepEqual(resolveShardForSuite("natives/bridge/bindings"), [1, 2]);
});

test("filterSuitesForShard partitions suite lists correctly", () => {
	const suites = [
		"health-worker",
		"packages/ai",
		"plugins/hashline",
		"tests/simulations",
		"natives/bridge/bindings",
	];
	const shard1Suites = filterSuitesForShard(suites, 1);
	const shard2Suites = filterSuitesForShard(suites, 2);
	const shard3Suites = filterSuitesForShard(suites, 3);

	assert.deepEqual(shard1Suites, ["health-worker", "packages/ai", "natives/bridge/bindings"]);
	assert.deepEqual(shard2Suites, ["plugins/hashline", "natives/bridge/bindings"]);
	assert.deepEqual(shard3Suites, ["tests/simulations"]);
});

test("calculateObservedShardDuration sums observed historical durations", () => {
	const suites = ["health-worker", "packages/ai", "packages/agent"];
	const cost = calculateObservedShardDuration(1, suites);
	const expected = 4.5 + 76.8 + 70.6;
	assert.ok(Math.abs(cost.observedSeconds - expected) < 0.001);
	assert.equal(cost.unmeasuredSuites.length, 0);
});

// 6. Authored Fixture Verification
test("passing shard fixtures (1, 2, 3) validate individually and aggregate to passed", async () => {
	const s1 = await readFixture("./fixtures/shard-1-pass.json");
	const s2 = await readFixture("./fixtures/shard-2-pass.json");
	const s3 = await readFixture("./fixtures/shard-3-pass.json");

	assert.equal(s1.status, "passed");
	assert.equal(s2.status, "passed");
	assert.equal(s3.status, "passed");

	const aggregated = aggregateShardReceipts([s1, s2, s3], 3);
	assert.equal(aggregated.valid, true);
	assert.equal(aggregated.aggregatedStatus, "passed");
	assert.deepEqual(aggregated.shardsPresent, [1, 2, 3]);
	assert.equal(aggregated.errors.length, 0);
});

test("missing shard fixture fails closed with REJECT_MISSING_SHARDS", async () => {
	const missingShards = await readFixture("./fixtures/missing-shard-receipts.json");
	const aggregated = aggregateShardReceipts(missingShards, 3);

	assert.equal(aggregated.valid, false);
	assert.equal(aggregated.aggregatedStatus, "rejected");
	assert.ok(aggregated.errors.some((e) => e.includes("REJECT_MISSING_SHARDS")));
	assert.ok(aggregated.errors.some((e) => e.includes("Missing shard 3/3")));
});

test("duplicate shard fixture fails closed with REJECT_DUPLICATE_SHARDS", async () => {
	const dupShards = await readFixture("./fixtures/duplicate-shard-receipts.json");
	const aggregated = aggregateShardReceipts(dupShards, 3);

	assert.equal(aggregated.valid, false);
	assert.equal(aggregated.aggregatedStatus, "rejected");
	assert.ok(aggregated.errors.some((e) => e.includes("REJECT_DUPLICATE_SHARDS")));
});

test("mismatched shard fixture fails closed with REJECT_MISMATCHED_SHARDS", async () => {
	const mismatchedShards = await readFixture("./fixtures/mismatched-shard-receipts.json");
	const aggregated = aggregateShardReceipts(mismatchedShards, 3);

	assert.equal(aggregated.valid, false);
	assert.equal(aggregated.aggregatedStatus, "rejected");
	assert.ok(aggregated.errors.some((e) => e.includes("REJECT_MISMATCHED_SHARDS")));
});

test("no-result missing secret fixture reports incomplete status", async () => {
	const fixture = await readFixture("./fixtures/no-result-missing-secret.json");
	assert.equal(fixture.status, "incomplete");
	assert.equal(fixture.reason, "missing_producer_secret");
});

test("no-result all skipped fixture reports incomplete status", async () => {
	const fixture = await readFixture("./fixtures/no-result-all-skipped.json");
	assert.equal(fixture.status, "incomplete");
	assert.equal(fixture.reason, "all_tests_skipped");
});

test("no-result xfail only fixture reports incomplete status", async () => {
	const fixture = await readFixture("./fixtures/no-result-xfail-only.json");
	assert.equal(fixture.status, "incomplete");
	assert.equal(fixture.reason, "xfail_only");
});

test("no-result zero executed fixture reports incomplete status", async () => {
	const fixture = await readFixture("./fixtures/no-result-zero-executed.json");
	assert.equal(fixture.status, "incomplete");
	assert.equal(fixture.reason, "zero_executed_tests");
});

test("no-result unparseable fixture reports incomplete status", async () => {
	const fixture = await readFixture("./fixtures/no-result-unparseable.json");
	assert.equal(fixture.status, "incomplete");
	assert.equal(fixture.reason, "unparseable_summary");
});

test("failed no reporter text fixture records 'message unavailable' and failed status", async () => {
	const fixture = await readFixture("./fixtures/failed-no-reporter-text.json");
	assert.equal(fixture.status, "failed");
	assert.equal(fixture.suites[0].tests[0].failure_text, "message unavailable");
});
