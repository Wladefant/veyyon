/**
 * Canonical ci-receipt/v1 validator and bounded GitHub check renderer for Cloudflare Workers & Node.
 *
 * Implements the exact same schema and fail-closed validation semantics as workflows/portable/ci_receipt.py.
 * Designed for zero-dependency execution in Cloudflare Worker runtime (e.g. CiRequestIndex status writer).
 */

export const CI_RECEIPT_SCHEMA_VERSION = "ci-receipt/v1";
export const CI_MANIFEST_SCHEMA_VERSION = "ci-manifest/v1";

export const SHA40_RE = /^[0-9a-fA-F]{40}$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;

export const VALID_STATUSES = new Set(["passed", "failed", "incomplete", "infrastructure_error"]);
export const VALID_TEST_STATUSES = new Set(["passed", "failed", "skipped", "quarantined"]);
export const VALID_TARGET_SUITES = new Set(["backend", "root", "frontend", "node"]);
export const TARGET_PATH_CHAR_RE = /^[A-Za-z0-9._/@+-]+$/;
export const HIGH_RISK_DOMAINS = new Set(["money", "billing", "auth", "concurrency", "migration"]);

export const GITHUB_MAX_TITLE_CHARS = 255;
export const GITHUB_MAX_SUMMARY_CHARS = 65535;
export const GITHUB_MAX_TEXT_CHARS = 65535;
export const GITHUB_MAX_ANNOTATIONS = 50;

export const SAFE_SUMMARY_MAX_CHARS = 60000;
export const SAFE_TEXT_MAX_CHARS = 60000;
export const MAX_FAILURE_TEXT_CHARS = 2000;

export const OBSERVATION_CHECK_NAME = "ci/receipt-gate (observation)";
export const CANONICAL_CHECK_NAME = "ci/receipt-gate";

export const RejectionCode = Object.freeze({
  MALFORMED_JSON: "MALFORMED_JSON",
  SCHEMA_VIOLATION: "SCHEMA_VIOLATION",
  SHA_MISMATCH: "SHA_MISMATCH",
  CHECKOUT_DRIFT: "CHECKOUT_DRIFT",
  BASE_SHA_MISMATCH: "BASE_SHA_MISMATCH",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  DIGEST_MISMATCH: "digest-mismatch",
  MISSING_SHARDS: "MISSING_SHARDS",
  DUPLICATE_SHARDS: "DUPLICATE_SHARDS",
  SHARD_OUT_OF_BOUNDS: "shard-unknown",
  MISSING_TARGETS: "MISSING_TARGETS",
  ZERO_ASSERTIONS: "ZERO_ASSERTIONS",
  ARTIFACT_MISMATCH: "ARTIFACT_MISMATCH",
  UNTRUSTED_CLAIMS: "UNTRUSTED_CLAIMS",
  UNAPPROVED_QUARANTINE: "UNAPPROVED_QUARANTINE",
  SUITE_EXECUTION_FAILURE: "SUITE_EXECUTION_FAILURE",
  MISSING_EVIDENCE: "MISSING_EVIDENCE",
  NO_RESULT_ALL_SKIPPED: "NO_RESULT_ALL_SKIPPED",
  NO_RESULT_EXECUTED_ZERO: "zero-executed",
  NO_RESULT_XFAIL_ONLY: "NO_RESULT_XFAIL_ONLY",
  NO_RESULT_NO_PARSABLE_SUMMARY: "NO_RESULT_NO_PARSABLE_SUMMARY",
  NO_RESULT_MISSING_PRODUCER_SECRET: "NO_RESULT_MISSING_PRODUCER_SECRET",
  MISSING_TEST_NAME: "MISSING_TEST_NAME",
  EXIT_CODE_MISMATCH: "exit-code-mismatch",
  SUITE_FAILED_UNPARSABLE: "suite-failed-unparsable",
  // Canonical producer contract NO-RESULT reason constants
  SHARD_UNCONFIGURED: "shard-unconfigured",
  SHARD_UNKNOWN: "shard-unknown",
  TARGET_INVALID: "target-invalid",
  REQUEST_UNRESOLVED: "request-unresolved",
  REQUEST_MISMATCH: "request-mismatch",
  REQUEST_AUTH: "request-auth",
  ZERO_EXECUTED: "zero-executed",
});

/**
 * Truncate text strictly to stay within character limits.
 */
export function truncateBounded(text, maxChars, suffix = "\n... [truncated to fit GitHub cap]") {
  if (typeof text !== "string") text = String(text ?? "");
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
}

/**
 * Validate target ID format <suite>:<repo-relative path> per producer contract lines 27-30.
 */
export function validateTargetId(targetId) {
  if (typeof targetId !== "string" || !targetId.includes(":")) {
    return [false, `target '${targetId}' missing '<suite>:<path>' format`];
  }

  const colonIdx = targetId.indexOf(":");
  const suite = targetId.slice(0, colonIdx);
  const path = targetId.slice(colonIdx + 1);

  if (!VALID_TARGET_SUITES.has(suite)) {
    return [false, `target '${targetId}' has invalid suite '${suite}' (must be backend|root|frontend|node)`];
  }

  if (!path || path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes(" ")) {
    return [false, `target path '${path}' is invalid (must not have leading slash, \\, :, or spaces)`];
  }

  if (path.length >= 2 && path[1] === ":" && /^[a-zA-Z]$/.test(path[0])) {
    return [false, `target path '${path}' must not be absolute drive path`];
  }

  if (!TARGET_PATH_CHAR_RE.test(path)) {
    return [false, `target path '${path}' contains disallowed characters (printable ASCII [A-Za-z0-9._/@+-] only)`];
  }

  const segments = path.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === "..") {
      return [false, `target path '${path}' has empty, '.', or '..' traversal segment`];
    }
    if (seg.startsWith("-")) {
      return [false, `target path '${path}' has segment starting with '-'`];
    }
  }

  if (suite === "backend" && !path.startsWith("backend/")) {
    return [false, `backend target path '${path}' must start with 'backend/'`];
  }
  if (suite === "frontend" && !path.startsWith("frontend/")) {
    return [false, `frontend target path '${path}' must start with 'frontend/'`];
  }

  return [true, ""];
}

/**
 * Validate syntax and schema invariants of a raw ci-receipt/v1 object.
 */
export function validateReceiptSyntax(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Receipt must be a JSON object.", receipt: null };
  }

  if (raw.schema_version === undefined || raw.schema_version === null) {
    return { ok: false, error: "Missing required top-level field 'schema_version'.", receipt: null };
  }
  if (raw.schema_version !== CI_RECEIPT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Invalid schema_version '${raw.schema_version}', expected '${CI_RECEIPT_SCHEMA_VERSION}'.`,
      receipt: null,
    };
  }

  const requiredTop = [
    "repo", "request_id", "build_id", "trigger_id", "candidate_sha",
    "checkout_sha", "base_sha", "runner_digest", "policy_digest",
    "selection_digest", "shard_id", "expected_shards", "status",
    "started_at", "ended_at", "suites",
  ];
  for (const field of requiredTop) {
    if (raw[field] === undefined || raw[field] === null) {
      return { ok: false, error: `Missing required top-level field '${field}'.`, receipt: null };
    }
  }

  // Exact SHA-40 validation without whitespace
  for (const shaField of ["candidate_sha", "checkout_sha", "base_sha"]) {
    const val = raw[shaField];
    if (typeof val !== "string" || !SHA40_RE.test(val) || val !== val.trim()) {
      return { ok: false, error: `Field '${shaField}' must be 40-char hex SHA without whitespace, got ${JSON.stringify(val)}.`, receipt: null };
    }
  }

  // Digests: lowercase 64-hex only
  for (const dField of ["runner_digest", "policy_digest", "selection_digest"]) {
    const val = raw[dField];
    if (typeof val !== "string" || !HEX64_RE.test(val) || val !== val.trim()) {
      return { ok: false, error: `Field '${dField}' must be 64-char lowercase hex SHA-256 digest, got ${JSON.stringify(val)}.`, receipt: null };
    }
  }

  // Shard IDs: strict integers, no coercion
  if (typeof raw.shard_id !== "number" || !Number.isInteger(raw.shard_id)) {
    return { ok: false, error: "Field 'shard_id' must be strict integer (shard-unconfigured).", receipt: null };
  }
  if (typeof raw.expected_shards !== "number" || !Number.isInteger(raw.expected_shards)) {
    return { ok: false, error: "Field 'expected_shards' must be strict integer (shard-unconfigured).", receipt: null };
  }

  const shardId = raw.shard_id;
  const expectedShards = raw.expected_shards;

  if (expectedShards < 1) {
    return { ok: false, error: `'expected_shards' must be >= 1, got ${expectedShards} (shard-unconfigured).`, receipt: null };
  }
  if (shardId < 1 || shardId > expectedShards) {
    return { ok: false, error: `'shard_id' ${shardId} is out of bounds for expected ${expectedShards} shards (shard-unknown).`, receipt: null };
  }

  const rawStatus = raw.status;
  if (typeof rawStatus !== "string") {
    return { ok: false, error: "Field 'status' must be string.", receipt: null };
  }
  const status = rawStatus.toLowerCase();
  if (!VALID_STATUSES.has(status)) {
    return { ok: false, error: `Invalid receipt status '${raw.status}'.`, receipt: null };
  }

  if (!Array.isArray(raw.suites) || raw.suites.length === 0) {
    return { ok: false, error: "'suites' must be a non-empty array.", receipt: null };
  }

  const suiteNames = new Set();
  const parsedSuites = [];

  for (let idx = 0; idx < raw.suites.length; idx++) {
    const s = raw.suites[idx];
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      return { ok: false, error: `Suite at index ${idx} is not an object.`, receipt: null };
    }
    const name = String(s.name ?? "").trim();
    if (!name) {
      return { ok: false, error: `Suite at index ${idx} missing required non-empty name.`, receipt: null };
    }
    if (suiteNames.has(name)) {
      return { ok: false, error: `Duplicate suite name '${name}'.`, receipt: null };
    }
    suiteNames.add(name);

    if (!Array.isArray(s.target_ids)) {
      return { ok: false, error: `Suite '${name}' missing required list 'target_ids'.`, receipt: null };
    }
    if (s.target_ids.length === 0) {
      return { ok: false, error: `Suite '${name}' target_ids list is empty (zero-executed).`, receipt: null };
    }

    const seenTargets = new Set();
    for (const tId of s.target_ids) {
      if (typeof tId !== "string") {
        return { ok: false, error: `Suite '${name}' target_id must be string (target-invalid).`, receipt: null };
      }
      if (seenTargets.has(tId)) {
        return { ok: false, error: `Suite '${name}' duplicate target_id '${tId}' (target-invalid).`, receipt: null };
      }
      seenTargets.add(tId);
      const [isValidT, errT] = validateTargetId(tId);
      if (!isValidT) {
        return { ok: false, error: `Suite '${name}' invalid target_id '${tId}': ${errT} (target-invalid).`, receipt: null };
      }
    }

    if (s.command === undefined) {
      return { ok: false, error: `Suite '${name}' missing required field 'command'.`, receipt: null };
    }
    if (typeof s.exit_code !== "number" || !Number.isInteger(s.exit_code)) {
      return { ok: false, error: `Suite '${name}' missing required integer 'exit_code'.`, receipt: null };
    }

    const counts = s.counts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
      return { ok: false, error: `Suite '${name}' missing required object 'counts'.`, receipt: null };
    }
    for (const cField of ["discovered", "executed", "passed", "failed", "skipped"]) {
      const val = counts[cField];
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0) {
        return { ok: false, error: `Suite '${name}' counts.${cField} must be non-negative integer.`, receipt: null };
      }
    }

    if (!("assertions" in counts)) {
      return { ok: false, error: `Suite '${name}' counts missing required nullable field 'assertions'.`, receipt: null };
    }
    if (counts.assertions !== null && (typeof counts.assertions !== "number" || !Number.isInteger(counts.assertions) || counts.assertions < 0)) {
      return { ok: false, error: `Suite '${name}' counts.assertions must be non-negative integer or null.`, receipt: null };
    }

    if (!("errors" in counts)) {
      return { ok: false, error: `Suite '${name}' counts missing required nullable field 'errors'.`, receipt: null };
    }
    if (counts.errors !== null && (typeof counts.errors !== "number" || !Number.isInteger(counts.errors) || counts.errors < 0)) {
      return { ok: false, error: `Suite '${name}' counts.errors must be non-negative integer or null.`, receipt: null };
    }

    if (counts.executed !== (counts.passed + counts.failed)) {
      return {
        ok: false,
        error: `Suite '${name}' counts invariant broken: executed (${counts.executed}) != passed (${counts.passed}) + failed (${counts.failed}).`,
        receipt: null,
      };
    }
    if (counts.errors !== null && counts.errors > counts.failed) {
      return {
        ok: false,
        error: `Suite '${name}' counts.errors (${counts.errors}) > counts.failed (${counts.failed}).`,
        receipt: null,
      };
    }
    if (counts.discovered < (counts.executed + counts.skipped)) {
      return {
        ok: false,
        error: `Suite '${name}' counts invariant broken: discovered (${counts.discovered}) < executed (${counts.executed}) + skipped (${counts.skipped}).`,
        receipt: null,
      };
    }

    const rawTests = Array.isArray(s.tests) ? s.tests : [];
    const parsedTests = [];
    const seenCaseIdentities = new Set();
    const executedTargetIds = new Set();
    let passedRecordsCount = 0;
    let failedRecordsCount = 0;
    let skippedRecordsCount = 0;
    let errorRecordsCount = 0;

    for (let tIdx = 0; tIdx < rawTests.length; tIdx++) {
      const t = rawTests[tIdx];
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        return { ok: false, error: `Suite '${name}' test at index ${tIdx} is not an object.`, receipt: null };
      }
      const tName = typeof t.name === "string" ? t.name.trim() : "";
      if (!tName) {
        return { ok: false, error: `Suite '${name}' test at index ${tIdx} missing required non-empty name.`, receipt: null };
      }
      const tTarget = typeof t.target_id === "string" ? t.target_id.trim() : "";
      if (!tTarget) {
        return { ok: false, error: `Suite '${name}' test at index ${tIdx} missing target_id.`, receipt: null };
      }
      const rawTStatus = typeof t.status === "string" ? t.status.toLowerCase() : "";
      if (!VALID_TEST_STATUSES.has(rawTStatus)) {
        return { ok: false, error: `Suite '${name}' test '${tName}' invalid status '${t.status}'.`, receipt: null };
      }

      const caseId = `${tTarget}::${tName}`;
      if (seenCaseIdentities.has(caseId)) {
        return { ok: false, error: `Suite '${name}' duplicate test case identity '${caseId}'.`, receipt: null };
      }
      seenCaseIdentities.add(caseId);
      executedTargetIds.add(tTarget);

      let failureText = t.failure_text !== undefined && t.failure_text !== null ? String(t.failure_text) : null;
      if (rawTStatus === "failed" && (!failureText || !failureText.trim())) {
        failureText = "message unavailable";
      }

      let failureKind = t.failure_kind || t.kind;
      if (failureKind !== undefined && failureKind !== null) {
        const fkStr = String(failureKind).toLowerCase();
        if (!["failure", "error"].includes(fkStr)) {
          return { ok: false, error: `Suite '${name}' test '${tName}' invalid failure kind '${failureKind}'.`, receipt: null };
        }
        failureKind = fkStr;
        if (failureKind === "error") {
          errorRecordsCount += 1;
        }
      } else if (rawTStatus === "failed") {
        failureKind = "failure";
      } else {
        failureKind = null;
      }

      if (rawTStatus === "passed") passedRecordsCount += 1;
      else if (rawTStatus === "failed") failedRecordsCount += 1;
      else if (rawTStatus === "skipped") skippedRecordsCount += 1;

      parsedTests.push({
        name: tName,
        target_id: tTarget,
        status: rawTStatus,
        duration_ms: t.duration_ms !== undefined && t.duration_ms !== null ? Number(t.duration_ms) : null,
        assertions: t.assertions !== undefined && t.assertions !== null ? Number(t.assertions) : null,
        failure_text: failureText,
        failure_kind: failureKind,
        quarantine: Boolean(t.quarantine),
        file_path: t.file_path ? String(t.file_path) : null,
        line_number: t.line_number ? Number(t.line_number) : null,
      });
    }

    if ((counts.passed > 0 || counts.failed > 0) && rawTests.length === 0) {
      return {
        ok: false,
        error: `Suite '${name}' forged counts: claims passed=${counts.passed}, failed=${counts.failed} but lists 0 test records.`,
        receipt: null,
      };
    }

    if (rawTests.length > 0) {
      if (passedRecordsCount !== counts.passed) {
        return {
          ok: false,
          error: `Suite '${name}' forged counts: claims passed=${counts.passed} but lists ${passedRecordsCount} passed records.`,
          receipt: null,
        };
      }
      if (failedRecordsCount !== counts.failed) {
        return {
          ok: false,
          error: `Suite '${name}' forged counts: claims failed=${counts.failed} but lists ${failedRecordsCount} failed records.`,
          receipt: null,
        };
      }
      if (counts.errors !== null && errorRecordsCount !== counts.errors) {
        return {
          ok: false,
          error: `Suite '${name}' forged counts: claims errors=${counts.errors} but lists ${errorRecordsCount} error records.`,
          receipt: null,
        };
      }
    }

    for (const claimedT of s.target_ids) {
      if (!executedTargetIds.has(claimedT) && (counts.passed > 0 || counts.failed > 0)) {
        return {
          ok: false,
          error: `Suite '${name}' claims target_id '${claimedT}' but executed zero test records for it.`,
          receipt: null,
        };
      }
    }

    const rawArtifacts = Array.isArray(s.artifacts) ? s.artifacts : [];
    const parsedArtifacts = [];
    for (let aIdx = 0; aIdx < rawArtifacts.length; aIdx++) {
      const a = rawArtifacts[aIdx];
      if (!a || typeof a !== "object" || Array.isArray(a)) {
        return { ok: false, error: `Suite '${name}' artifact at index ${aIdx} is not an object.`, receipt: null };
      }
      if (!a.key || !a.sha256 || a.size_bytes === undefined) {
        return { ok: false, error: `Suite '${name}' artifact at index ${aIdx} missing key, sha256, or size_bytes.`, receipt: null };
      }
      const sha = String(a.sha256).toLowerCase();
      if (!HEX64_RE.test(sha)) {
        return { ok: false, error: `Suite '${name}' artifact '${a.key}' sha256 must be 64-hex.`, receipt: null };
      }
      parsedArtifacts.push({
        key: String(a.key),
        sha256: sha,
        size_bytes: Number(a.size_bytes),
        kind: a.kind ? String(a.kind) : "report",
      });
    }

    parsedSuites.push({
      name,
      target_ids: s.target_ids.map(String),
      command: String(s.command),
      exit_code: Number(s.exit_code),
      counts: {
        discovered: counts.discovered,
        executed: counts.executed,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        assertions: counts.assertions,
        errors: counts.errors,
      },
      skip_reasons: Array.isArray(s.skip_reasons) ? s.skip_reasons.map(String) : [],
      artifacts: parsedArtifacts,
      quarantined_tests: Array.isArray(s.quarantined_tests) ? s.quarantined_tests : [],
      tests: parsedTests,
    });
  }

  const parsedReceipt = {
    schema_version: CI_RECEIPT_SCHEMA_VERSION,
    repo: String(raw.repo),
    request_id: String(raw.request_id),
    build_id: String(raw.build_id),
    trigger_id: String(raw.trigger_id),
    candidate_sha: String(raw.candidate_sha).toLowerCase(),
    checkout_sha: String(raw.checkout_sha).toLowerCase(),
    base_sha: String(raw.base_sha).toLowerCase(),
    runner_digest: String(raw.runner_digest).toLowerCase(),
    policy_digest: String(raw.policy_digest).toLowerCase(),
    selection_digest: String(raw.selection_digest).toLowerCase(),
    shard_id: shardId,
    expected_shards: expectedShards,
    status,
    started_at: String(raw.started_at),
    ended_at: String(raw.ended_at),
    suites: parsedSuites,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts : [],
    signature: raw.signature ? String(raw.signature) : null,
  };

  return { ok: true, error: null, receipt: parsedReceipt };
}

/**
 * Aggregate multiple shard receipts into one consolidated Receipt object.
 */
export function aggregateShardReceipts(receipts, expectedShards) {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { ok: false, error: "No shard receipts provided.", receipt: null };
  }
  if (receipts.length !== expectedShards) {
    return { ok: false, error: `Expected ${expectedShards} shard(s), but received ${receipts.length}.`, receipt: null };
  }

  const seenShards = new Set();
  const first = receipts[0];

  for (const r of receipts) {
    if (r.expected_shards !== expectedShards) {
      return {
        ok: false,
        error: `Shard ${r.shard_id} reports expected_shards=${r.expected_shards}, conflicting with caller expected_shards=${expectedShards}.`,
        receipt: null,
      };
    }
    if (r.shard_id < 1 || r.shard_id > expectedShards) {
      return { ok: false, error: `Shard ID ${r.shard_id} is out of bounds for expected ${expectedShards} shards (shard-unknown).`, receipt: null };
    }
    if (seenShards.has(r.shard_id)) {
      return { ok: false, error: `Duplicate receipt for shard ID ${r.shard_id}.`, receipt: null };
    }
    seenShards.add(r.shard_id);

    // Cross-shard identity checks
    if (r.candidate_sha !== first.candidate_sha) {
      return { ok: false, error: `Shard ${r.shard_id} candidate_sha mismatch with shard 1.`, receipt: null };
    }
    if (r.checkout_sha !== first.checkout_sha) {
      return { ok: false, error: `Shard ${r.shard_id} checkout_sha mismatch with shard 1.`, receipt: null };
    }
    if (r.base_sha !== first.base_sha) {
      return { ok: false, error: `Shard ${r.shard_id} base_sha mismatch with shard 1.`, receipt: null };
    }
    if (r.repo !== first.repo) {
      return { ok: false, error: `Shard ${r.shard_id} repo mismatch with shard 1.`, receipt: null };
    }
    if (r.build_id !== first.build_id) {
      return { ok: false, error: `Shard ${r.shard_id} build_id mismatch with shard 1.`, receipt: null };
    }
    if (r.runner_digest !== first.runner_digest) {
      return { ok: false, error: `Shard ${r.shard_id} runner_digest mismatch with shard 1.`, receipt: null };
    }
    if (r.policy_digest !== first.policy_digest) {
      return { ok: false, error: `Shard ${r.shard_id} policy_digest mismatch with shard 1.`, receipt: null };
    }
    if (r.selection_digest !== first.selection_digest) {
      return { ok: false, error: `Shard ${r.shard_id} selection_digest mismatch with shard 1.`, receipt: null };
    }
  }

  // Check missing shards
  for (let i = 1; i <= expectedShards; i++) {
    if (!seenShards.has(i)) {
      return { ok: false, error: `Missing required shard ID ${i}.`, receipt: null };
    }
  }

  const combinedSuites = [];
  const combinedArtifacts = [];
  let overallStatus = "passed";

  for (const r of receipts) {
    combinedSuites.push(...r.suites);
    combinedArtifacts.push(...(r.artifacts || []));
    if (r.status === "infrastructure_error") {
      overallStatus = "infrastructure_error";
    } else if (r.status === "failed" && overallStatus !== "infrastructure_error") {
      overallStatus = "failed";
    } else if (r.status === "incomplete" && !["failed", "infrastructure_error"].includes(overallStatus)) {
      overallStatus = "incomplete";
    }
  }

  const aggregated = {
    schema_version: CI_RECEIPT_SCHEMA_VERSION,
    repo: first.repo,
    request_id: first.request_id,
    build_id: first.build_id,
    trigger_id: first.trigger_id,
    candidate_sha: first.candidate_sha,
    checkout_sha: first.checkout_sha,
    base_sha: first.base_sha,
    runner_digest: first.runner_digest,
    policy_digest: first.policy_digest,
    selection_digest: first.selection_digest,
    shard_id: 1,
    expected_shards: expectedShards,
    status: overallStatus,
    started_at: first.started_at,
    ended_at: receipts[receipts.length - 1].ended_at,
    suites: combinedSuites,
    artifacts: combinedArtifacts,
  };

  return { ok: true, error: null, receipt: aggregated };
}

/**
 * Validate a CI receipt (or shard list) against independently supplied context.
 *
 * Fail-closed gate: untrusted candidate claims are never accepted without verified match.
 */
export function validateCiReceipt(receiptData, context, options = {}) {
  const manifest = options.manifest ?? null;

  if (Boolean(context.request_auth_failed || context.requestAuthFailed)) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.REQUEST_AUTH,
      rejection_reason: "HMAC request signature verification failed (request-auth).",
    };
  }

  if (Boolean(context.request_unresolved || context.requestUnresolved)) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.REQUEST_UNRESOLVED,
      rejection_reason: "Request resolution returned 404 or 409 (request-unresolved).",
    };
  }

  // 1. Ingest input
  let rawShards = [];
  if (typeof receiptData === "string") {
    try {
      const parsed = JSON.parse(receiptData);
      rawShards = Array.isArray(parsed) ? parsed : [parsed];
    } catch (err) {
      return {
        valid: false,
        verdict: "BLOCKED",
        rejection_code: RejectionCode.MALFORMED_JSON,
        rejection_reason: `Failed to parse receipt JSON: ${err.message}`,
      };
    }
  } else if (Array.isArray(receiptData)) {
    rawShards = receiptData;
  } else if (receiptData && typeof receiptData === "object") {
    rawShards = [receiptData];
  } else {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.MALFORMED_JSON,
      rejection_reason: "Receipt input must be JSON string, object, or list of shard objects.",
    };
  }

  if (rawShards.length === 0) {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.MISSING_EVIDENCE,
      rejection_reason: "Receipt payload contains zero shard objects.",
    };
  }

  // 2. Syntax validation
  const parsedShards = [];
  for (const s of rawShards) {
    const { ok, error, receipt } = validateReceiptSyntax(s);
    if (!ok) {
      let code = RejectionCode.SCHEMA_VIOLATION;
      let verdict = "BLOCKED";
      if (error.includes("shard-unconfigured")) {
        code = RejectionCode.SHARD_UNCONFIGURED;
        verdict = "NO-RESULT";
      } else if (error.includes("shard-unknown")) {
        code = RejectionCode.SHARD_UNKNOWN;
        verdict = "NO-RESULT";
      } else if (error.includes("target-invalid")) {
        code = RejectionCode.TARGET_INVALID;
        verdict = "NO-RESULT";
      } else if (error.includes("zero-executed")) {
        code = RejectionCode.ZERO_EXECUTED;
        verdict = "NO-RESULT";
      } else if (error.includes("forged counts")) {
        code = RejectionCode.UNTRUSTED_CLAIMS;
        verdict = "BLOCKED";
      }
      return {
        valid: false,
        verdict,
        rejection_code: code,
        rejection_reason: `Schema validation error: ${error}`,
      };
    }
    parsedShards.push(receipt);
  }

  // 3. Shard aggregation
  let aggregated;
  const expectedShards = context.expected_shards ?? context.expectedShards ?? 1;

  if (parsedShards.length > 1 || expectedShards > 1) {
    const { ok, error, receipt } = aggregateShardReceipts(parsedShards, expectedShards);
    if (!ok) {
      let code = RejectionCode.MISSING_SHARDS;
      let verdict = "BLOCKED";
      if (error.includes("Duplicate")) code = RejectionCode.DUPLICATE_SHARDS;
      else if (error.includes("out of bounds") || error.includes("shard-unknown")) {
        code = RejectionCode.SHARD_UNKNOWN;
        verdict = "NO-RESULT";
      } else if (error.includes("mismatch")) code = RejectionCode.IDENTITY_MISMATCH;
      return {
        valid: false,
        verdict,
        rejection_code: code,
        rejection_reason: `Shard aggregation error: ${error}`,
      };
    }
    aggregated = receipt;
  } else {
    aggregated = parsedShards[0];
    if (aggregated.expected_shards !== expectedShards) {
      return {
        valid: false,
        verdict: "BLOCKED",
        rejection_code: RejectionCode.MISSING_SHARDS,
        rejection_reason: `Receipt reports expected_shards=${aggregated.expected_shards}, conflicting with independent expected_shards=${expectedShards}.`,
      };
    }
  }

  // 4. Git commit & identity checks
  const expCandidate = String(context.expected_candidate_sha ?? context.expectedCandidateSha ?? "").toLowerCase();
  const expBase = String(context.expected_base_sha ?? context.expectedBaseSha ?? "").toLowerCase();
  const expRepo = String(context.expected_repo ?? context.expectedRepo ?? "");
  const expBuildId = String(context.expected_build_id ?? context.expectedBuildId ?? "");
  const expTriggerId = String(context.expected_trigger_id ?? context.expectedTriggerId ?? "");

  if (expCandidate && aggregated.candidate_sha !== expCandidate) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.REQUEST_MISMATCH,
      rejection_reason: `Receipt candidate_sha '${aggregated.candidate_sha}' mismatch with expected '${expCandidate}' (request-mismatch).`,
    };
  }
  if (aggregated.checkout_sha !== aggregated.candidate_sha) {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.CHECKOUT_DRIFT,
      rejection_reason: `Checkout drift: checkout_sha '${aggregated.checkout_sha}' does not match candidate_sha '${aggregated.candidate_sha}'.`,
    };
  }
  if (expBase && aggregated.base_sha !== expBase) {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.BASE_SHA_MISMATCH,
      rejection_reason: `Receipt base_sha '${aggregated.base_sha}' mismatch with expected '${expBase}'.`,
    };
  }
  if (expRepo && aggregated.repo !== expRepo) {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.IDENTITY_MISMATCH,
      rejection_reason: `Receipt repo '${aggregated.repo}' mismatch with expected '${expRepo}'.`,
    };
  }
  if (expBuildId && aggregated.build_id !== expBuildId) {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.IDENTITY_MISMATCH,
      rejection_reason: `Receipt build_id '${aggregated.build_id}' mismatch with expected '${expBuildId}'.`,
    };
  }
  if (expTriggerId && aggregated.trigger_id !== expTriggerId) {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.IDENTITY_MISMATCH,
      rejection_reason: `Receipt trigger_id '${aggregated.trigger_id}' mismatch with expected '${expTriggerId}'.`,
    };
  }

  // 5. Build digest checks
  const expRunner = context.expected_runner_digest ?? context.expectedRunnerDigest;
  const expPolicy = context.expected_policy_digest ?? context.expectedPolicyDigest;
  const expSelection = context.expected_selection_digest ?? context.expectedSelectionDigest;

  if (expRunner && aggregated.runner_digest !== String(expRunner).toLowerCase()) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.DIGEST_MISMATCH,
      rejection_reason: `runner_digest '${aggregated.runner_digest}' mismatch with expected '${expRunner}' (digest-mismatch).`,
    };
  }
  if (expPolicy && aggregated.policy_digest !== String(expPolicy).toLowerCase()) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.DIGEST_MISMATCH,
      rejection_reason: `policy_digest '${aggregated.policy_digest}' mismatch with expected '${expPolicy}' (digest-mismatch).`,
    };
  }
  if (expSelection && aggregated.selection_digest !== String(expSelection).toLowerCase()) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.DIGEST_MISMATCH,
      rejection_reason: `selection_digest '${aggregated.selection_digest}' mismatch with expected '${expSelection}' (digest-mismatch).`,
    };
  }

  // 6. Target coverage
  const requiredTargets = context.required_targets ?? context.requiredTargets ?? [];
  if (requiredTargets.length === 0 && context.require_targets) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.ZERO_EXECUTED,
      rejection_reason: "Empty required_targets array (zero-executed).",
    };
  }

  for (const reqT of requiredTargets) {
    const [isValidReq, errReq] = validateTargetId(reqT);
    if (!isValidReq) {
      return {
        valid: false,
        verdict: "NO-RESULT",
        rejection_code: RejectionCode.TARGET_INVALID,
        rejection_reason: `Invalid required_target '${reqT}': ${errReq} (target-invalid).`,
      };
    }
  }

  if (requiredTargets.length > 0) {
    const executedTargets = new Set();
    for (const s of aggregated.suites) {
      for (const t of s.target_ids) executedTargets.add(t);
    }
    const missingTargets = requiredTargets.filter((t) => !executedTargets.has(t));
    if (missingTargets.length > 0) {
      return {
        valid: false,
        verdict: "BLOCKED",
        rejection_code: RejectionCode.MISSING_TARGETS,
        rejection_reason: `Missing execution for ${missingTargets.length} required target(s): ${missingTargets.slice(0, 5).join(", ")}.`,
      };
    }
  }

  // 7. Collect counts and suite execution checks
  const totalSuites = aggregated.suites.length;
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  let quarantinedTests = 0;
  let totalAssertions = null;
  let hasAnyMeasuredAssertions = false;
  let summedAssertions = 0;

  const requireSecret = Boolean(context.require_producer_secret ?? context.requireProducerSecret);
  const secretPresent = Boolean(context.producer_secret_present ?? context.producerSecretPresent);
  if (requireSecret && (!secretPresent || !aggregated.signature)) {
    return {
      valid: false,
      verdict: "NO-RESULT",
      rejection_code: RejectionCode.REQUEST_AUTH,
      rejection_reason: "No producer/status secret provisioned for receipt verification; explicitly NO-RESULT, never silently PASS (request-auth).",
      total_suites: totalSuites,
      aggregated_receipt: aggregated,
    };
  }

  const failingRecords = [];
  const quarantinedRecords = [];
  const quarantinedTestIds = new Set();

  for (const suite of aggregated.suites) {
    if (suite.exit_code !== 0 && suite.counts.executed === 0 && (!suite.tests || suite.tests.length === 0)) {
      return {
        valid: false,
        verdict: "NO-RESULT",
        rejection_code: RejectionCode.SUITE_FAILED_UNPARSABLE,
        rejection_reason: `Suite '${suite.name}' exit code is ${suite.exit_code} with 0 executed tests (suite-failed-unparsable).`,
        total_suites: totalSuites,
        aggregated_receipt: aggregated,
      };
    }
    if (suite.counts.executed === 0) {
      return {
        valid: false,
        verdict: "NO-RESULT",
        rejection_code: RejectionCode.ZERO_EXECUTED,
        rejection_reason: `Suite '${suite.name}' executed 0 tests (executed=0 yields NO-RESULT; receipt incomplete).`,
        total_suites: totalSuites,
        aggregated_receipt: aggregated,
      };
    }
    if (suite.exit_code !== 0 && suite.counts.failed === 0) {
      return {
        valid: false,
        verdict: "NO-RESULT",
        rejection_code: RejectionCode.EXIT_CODE_MISMATCH,
        rejection_reason: `Suite '${suite.name}' exit code is ${suite.exit_code} but counts.failed is 0 (exit-code-mismatch).`,
        total_suites: totalSuites,
        aggregated_receipt: aggregated,
      };
    }
    if (suite.counts.errors !== null && suite.counts.errors > suite.counts.failed) {
      return {
        valid: false,
        verdict: "BLOCKED",
        rejection_code: RejectionCode.SCHEMA_VIOLATION,
        rejection_reason: `Suite '${suite.name}' counts.errors (${suite.counts.errors}) > counts.failed (${suite.counts.failed}).`,
        total_suites: totalSuites,
        aggregated_receipt: aggregated,
      };
    }
    if (suite.counts.passed === 0 && suite.counts.failed === 0) {
      return {
        valid: false,
        verdict: "NO-RESULT",
        rejection_code: RejectionCode.NO_RESULT_ALL_SKIPPED,
        rejection_reason: `Suite '${suite.name}' has 0 passed tests (all-skipped or xfail-only yields NO-RESULT).`,
        total_suites: totalSuites,
        aggregated_receipt: aggregated,
      };
    }

    totalTests += suite.counts.discovered;
    passedTests += suite.counts.passed;
    failedTests += suite.counts.failed;
    skippedTests += suite.counts.skipped;

    if (suite.counts.assertions !== null) {
      hasAnyMeasuredAssertions = true;
      summedAssertions += suite.counts.assertions;
    }

    for (const q of suite.quarantined_tests) {
      quarantinedRecords.push(q);
      quarantinedTestIds.add(q.test_id || q.target_id);
      quarantinedTests += 1;
    }

    for (const t of suite.tests) {
      if (t.status === "failed") {
        failingRecords.push(t);
      } else if (t.status === "quarantined") {
        quarantinedTestIds.add(t.target_id);
      }
    }
  }

  if (hasAnyMeasuredAssertions) {
    totalAssertions = summedAssertions;
  }

  // 8. Assertions requirement
  const requireNonzero = Boolean(context.require_nonzero_assertions ?? context.requireNonzeroAssertions);
  if (requireNonzero) {
    if (totalAssertions === null || totalAssertions === 0) {
      return {
        valid: false,
        verdict: "BLOCKED",
        rejection_code: RejectionCode.ZERO_ASSERTIONS,
        rejection_reason: totalAssertions === null
          ? "Reporter does not measure assertions (assertions is null); policy requires measured nonzero assertions."
          : "Suite reported 0 assertions across all passing tests (vacuous pass rejected).",
        total_suites: totalSuites,
        total_tests: totalTests,
        passed_tests: passedTests,
        failed_tests: failedTests,
        skipped_tests: skippedTests,
        quarantined_tests: quarantinedTests,
        total_assertions: totalAssertions,
        aggregated_receipt: aggregated,
      };
    }
  }

  // 9. Artifact digest verification
  const expectedDigests = { ...(context.artifact_digests || context.artifactDigests || {}) };
  if (manifest && Array.isArray(manifest.artifacts)) {
    for (const a of manifest.artifacts) {
      if (a.key) expectedDigests[a.key] = a.sha256;
      if (a.name) expectedDigests[a.name] = a.sha256;
    }
  }
  const allReceiptArtifacts = [...(aggregated.artifacts || [])];
  for (const s of aggregated.suites) allReceiptArtifacts.push(...(s.artifacts || []));

  for (const art of allReceiptArtifacts) {
    const expectedSha = expectedDigests[art.key] || expectedDigests[art.key.split("/").pop()];
    if (expectedSha && art.sha256 !== expectedSha.toLowerCase()) {
      return {
        valid: false,
        verdict: "BLOCKED",
        rejection_code: RejectionCode.ARTIFACT_MISMATCH,
        rejection_reason: `Artifact '${art.key}' SHA-256 mismatch with verified manifest.`,
        total_suites: totalSuites,
        total_tests: totalTests,
        passed_tests: passedTests,
        failed_tests: failedTests,
        skipped_tests: skippedTests,
        quarantined_tests: quarantinedTests,
        total_assertions: totalAssertions,
        aggregated_receipt: aggregated,
      };
    }
  }

  // 10. Quarantine policy
  const approvedQ = new Set(context.approved_quarantined_test_ids || context.approvedQuarantinedTestIds || []);
  const unapprovedHighRisk = [];
  for (const q of quarantinedRecords) {
    const testId = q.test_id || q.target_id || "";
    if (approvedQ.has(testId)) continue;
    for (const domain of HIGH_RISK_DOMAINS) {
      if (testId.includes(domain)) {
        unapprovedHighRisk.push(testId);
        break;
      }
    }
  }
  if (unapprovedHighRisk.length > 0) {
    return {
      valid: false,
      verdict: "BLOCKED",
      rejection_code: RejectionCode.UNAPPROVED_QUARANTINE,
      rejection_reason: `Unapproved quarantine of high-risk test(s): ${unapprovedHighRisk.join(", ")}.`,
      total_suites: totalSuites,
      total_tests: totalTests,
      passed_tests: passedTests,
      failed_tests: failedTests,
      skipped_tests: skippedTests,
      quarantined_tests: quarantinedTests,
      total_assertions: totalAssertions,
      aggregated_receipt: aggregated,
    };
  }

  // 11. Suite execution failures & PASS verification
  const suiteFailures = [];
  for (const suite of aggregated.suites) {
    if (suite.exit_code !== 0 || suite.counts.failed > 0) {
      const unquarantinedFails = suite.tests.filter(
        (t) => t.status === "failed" && !quarantinedTestIds.has(t.target_id)
      );
      if (unquarantinedFails.length > 0 || suite.counts.failed > suite.quarantined_tests.length) {
        suiteFailures.push(`${suite.name} (exit ${suite.exit_code}, ${suite.counts.failed} failed)`);
      }
    }
  }

  if (suiteFailures.length > 0) {
    const code = aggregated.status === "passed" ? RejectionCode.UNTRUSTED_CLAIMS : RejectionCode.SUITE_EXECUTION_FAILURE;
    return {
      valid: false,
      verdict: "FAILED",
      rejection_code: code,
      rejection_reason: `Suite execution failures: ${suiteFailures.join(", ")}.`,
      total_suites: totalSuites,
      total_tests: totalTests,
      passed_tests: passedTests,
      failed_tests: failedTests,
      skipped_tests: skippedTests,
      quarantined_tests: quarantinedTests,
      total_assertions: totalAssertions,
      failing_test_records: failingRecords,
      quarantined_test_records: quarantinedRecords,
      aggregated_receipt: aggregated,
    };
  }

  if (aggregated.status !== "passed") {
    return {
      valid: false,
      verdict: "FAILED",
      rejection_code: RejectionCode.SUITE_EXECUTION_FAILURE,
      rejection_reason: `Receipt reported status '${aggregated.status}'.`,
      total_suites: totalSuites,
      total_tests: totalTests,
      passed_tests: passedTests,
      failed_tests: failedTests,
      skipped_tests: skippedTests,
      quarantined_tests: quarantinedTests,
      total_assertions: totalAssertions,
      failing_test_records: failingRecords,
      quarantined_test_records: quarantinedRecords,
      aggregated_receipt: aggregated,
    };
  }

  // All checks passed!
  return {
    valid: true,
    verdict: "PASSED",
    rejection_code: null,
    rejection_reason: null,
    total_suites: totalSuites,
    total_tests: totalTests,
    passed_tests: passedTests,
    failed_tests: failedTests,
    skipped_tests: skippedTests,
    quarantined_tests: quarantinedTests,
    total_assertions: totalAssertions,
    failing_test_records: failingRecords,
    quarantined_test_records: quarantinedRecords,
    aggregated_receipt: aggregated,
  };
}

/**
 * Render check run output strictly within GitHub Checks API caps.
 */
export function renderGithubCheckOutput(result, options = {}) {
  const checkName = options.checkName || options.check_name || CANONICAL_CHECK_NAME;
  const isObservationMode = Boolean(options.isObservationMode ?? options.is_observation_mode ?? false);

  let conclusion;
  if (result.verdict === "PASSED") conclusion = "success";
  else if (result.verdict === "NO-RESULT") conclusion = "neutral";
  else if (result.verdict === "BLOCKED") conclusion = "action_required";
  else conclusion = "failure";

  const displayCheckName = isObservationMode ? OBSERVATION_CHECK_NAME : checkName;
  const assertionStr = result.total_assertions !== null && result.total_assertions !== undefined
    ? `${result.total_assertions} assertions`
    : "assertions not measured";

  const rawTitle = result.valid
    ? `${displayCheckName}: PASS (${result.passed_tests || 0} passed, ${assertionStr})`
    : `${displayCheckName}: ${result.verdict} [${result.rejection_code || "REJECTED"}]`;

  const boundedTitle = truncateBounded(rawTitle, GITHUB_MAX_TITLE_CHARS);

  const summaryLines = [
    `### ${displayCheckName} Verification Summary`,
    "",
    `- **Verdict:** \`${result.verdict}\``,
    `- **Valid Receipt:** \`${result.valid}\``,
    `- **Tests:** \`${result.passed_tests || 0} passed\`, \`${result.failed_tests || 0} failed\`, \`${result.skipped_tests || 0} skipped\`, \`${result.quarantined_tests || 0} quarantined\` (Total: \`${result.total_tests || 0}\`)`,
    `- **Assertions:** \`${result.total_assertions !== null && result.total_assertions !== undefined ? result.total_assertions : "null (unmeasured)"}\``,
  ];

  if (result.rejection_reason) {
    summaryLines.push(`- **Rejection Reason [${result.rejection_code}]:** ${result.rejection_reason}`);
  }

  const boundedSummary = truncateBounded(summaryLines.join("\n"), SAFE_SUMMARY_MAX_CHARS);

  const annotations = [];
  if (Array.isArray(result.failing_test_records)) {
    for (const fail of result.failing_test_records.slice(0, GITHUB_MAX_ANNOTATIONS)) {
      annotations.push({
        path: fail.file_path || "test",
        start_line: fail.line_number || 1,
        end_line: fail.line_number || 1,
        annotation_level: "failure",
        message: truncateBounded(fail.failure_text || "message unavailable", MAX_FAILURE_TEXT_CHARS),
        title: fail.name,
      });
    }
  }

  return {
    name: displayCheckName,
    head_sha: result.aggregated_receipt?.candidate_sha || "unknown",
    status: "completed",
    conclusion,
    output: {
      title: boundedTitle,
      summary: boundedSummary,
      text: boundedSummary,
      annotations,
    },
  };
}

export class Manifest {
  constructor(data = {}) {
    this.schema_version = data.schema_version || CI_MANIFEST_SCHEMA_VERSION;
    this.candidate_sha = (data.candidate_sha || "").toLowerCase();
    this.build_id = data.build_id || "";
    this.expected_shards = data.expected_shards || 1;
    this.artifacts = data.artifacts || [];
  }

  static fromDict(data) {
    return new Manifest(data);
  }
}

/**
 * Negative-control tests verifying:
 * - 1 failed, 0 passed -> FAIL
 * - 1 error, 0 passed -> FAIL
 * - all skipped -> NO-RESULT
 * - no cases -> NO-RESULT
 */
export function runNegativeControlTests() {
  const baseContext = {
    expected_repo: "Wladefant/superboard",
    expected_candidate_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    expected_base_sha: "f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2",
    expected_build_id: "268cd0c3-375e-4918-92d7-ceb44f75d80c",
    expected_trigger_id: "c08371ee-1d41-4e91-a035-ba751fd33027",
    expected_shards: 1,
    required_targets: ["root:workflows/portable/test_x.py"],
    require_nonzero_assertions: false,
  };

  const makeReceipt = (suiteOverride, status = "passed") => ({
    schema_version: "ci-receipt/v1",
    repo: "Wladefant/superboard",
    request_id: "req-1",
    build_id: "268cd0c3-375e-4918-92d7-ceb44f75d80c",
    trigger_id: "c08371ee-1d41-4e91-a035-ba751fd33027",
    candidate_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    checkout_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    base_sha: "f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2",
    runner_digest: "1111111111111111111111111111111111111111111111111111111111111111",
    policy_digest: "2222222222222222222222222222222222222222222222222222222222222222",
    selection_digest: "3333333333333333333333333333333333333333333333333333333333333333",
    shard_id: 1,
    expected_shards: 1,
    status,
    started_at: "2026-10-13T20:00:00Z",
    ended_at: "2026-10-13T20:05:00Z",
    suites: [
      {
        name: "unit",
        target_ids: ["root:workflows/portable/test_x.py"],
        command: "pytest",
        exit_code: 0,
        ...suiteOverride,
      },
    ],
  });

  const results = {};

  // 1. 1 failed, 0 passed -> FAIL
  const rFail = makeReceipt({
    exit_code: 1,
    counts: { discovered: 1, executed: 1, passed: 0, failed: 1, skipped: 0, assertions: 1, errors: 0 },
    tests: [{ name: "test_1", target_id: "root:workflows/portable/test_x.py", status: "failed", failure_text: "assert 1==2", failure_kind: "failure" }],
  }, "failed");
  const resFail = validateCiReceipt(rFail, baseContext);
  results["1_failed_0_passed"] = resFail.verdict === "FAILED";

  // 2. 1 error, 0 passed -> FAIL
  const rErr = makeReceipt({
    exit_code: 1,
    counts: { discovered: 1, executed: 1, passed: 0, failed: 1, skipped: 0, assertions: 0, errors: 1 },
    tests: [{ name: "test_err", target_id: "root:workflows/portable/test_x.py", status: "failed", failure_text: "RuntimeError", failure_kind: "error" }],
  }, "failed");
  const resErr = validateCiReceipt(rErr, baseContext);
  results["1_error_0_passed"] = resErr.verdict === "FAILED";

  // 3. all skipped -> NO-RESULT
  const rSkip = makeReceipt({
    exit_code: 0,
    counts: { discovered: 3, executed: 0, passed: 0, failed: 0, skipped: 3, assertions: 0, errors: 0 },
    tests: [{ name: "test_s", target_id: "root:workflows/portable/test_x.py", status: "skipped" }],
  }, "passed");
  const resSkip = validateCiReceipt(rSkip, baseContext);
  results["all_skipped"] = resSkip.verdict === "NO-RESULT";

  // 4. no cases -> NO-RESULT
  const rNoCases = makeReceipt({
    exit_code: 0,
    counts: { discovered: 0, executed: 0, passed: 0, failed: 0, skipped: 0, assertions: null, errors: null },
    tests: [],
  }, "passed");
  const resNoCases = validateCiReceipt(rNoCases, baseContext);
  results["no_cases"] = resNoCases.verdict === "NO-RESULT";

  return results;
}
