import { dlopen, FFIType } from "bun:ffi";
import { verifyNativeOwnerOnlyWindowsAcl } from "../packages/utils/src/windows-acl-native.ts";

const target = process.env.VEYYON_OWNER_ONLY_ACL_PATH;
if (!target) {
  console.error("Missing VEYYON_OWNER_ONLY_ACL_PATH");
  process.exit(1);
}

// Check FFI dlopen directly to capture any verbatim error
let ffiLoadError: string | null = null;
try {
  const advapi = dlopen("advapi32.dll", {
    GetFileSecurityW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
  });
  advapi.close();
} catch (e: unknown) {
  ffiLoadError = e instanceof Error ? e.message : String(e);
}

function nearestRankPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx];
}

function computeStats(data: number[], errors: number, total: number) {
  const sorted = [...data].sort((a, b) => a - b);
  const sum = data.reduce((a, b) => a + b, 0);
  const mean = data.length > 0 ? sum / data.length : 0;
  const variance = data.length > 0 ? data.reduce((acc, v) => acc + (v - mean) ** 2, 0) / data.length : 0;
  return {
    total_expected: total,
    complete: data.length,
    errors,
    missing: Math.max(0, total - data.length - errors),
    min_ms: sorted.length > 0 ? Number(sorted[0].toFixed(4)) : null,
    p50_ms: sorted.length > 0 ? Number(nearestRankPercentile(sorted, 50).toFixed(4)) : null,
    p95_ms: sorted.length > 0 ? Number(nearestRankPercentile(sorted, 95).toFixed(4)) : null,
    max_ms: sorted.length > 0 ? Number(sorted[sorted.length - 1].toFixed(4)) : null,
    mean_ms: Number(mean.toFixed(4)),
    stddev_ms: Number(Math.sqrt(variance).toFixed(4)),
  };
}

// 1. Sequential 20 in-process calls
const seqRuns: { iteration: number; duration_ms: number; error: string | null }[] = [];
const seqDurations: number[] = [];
let seqErrors = 0;

for (let i = 0; i < 20; i++) {
  const t0 = performance.now();
  let err: string | null = null;
  try {
    verifyNativeOwnerOnlyWindowsAcl(target);
  } catch (e: unknown) {
    err = e instanceof Error ? e.message : String(e);
    seqErrors++;
  }
  const t1 = performance.now();
  const dur = t1 - t0;
  seqRuns.push({ iteration: i + 1, duration_ms: Number(dur.toFixed(4)), error: err });
  if (!err) seqDurations.push(dur);
}

// 2. Concurrency 8 (20 total calls) in-process
const concRuns: { iteration: number; duration_ms: number; error: string | null }[] = [];
const concDurations: number[] = [];
let concErrors = 0;

// Execute in batches of 8
const batchSize = 8;
for (let b = 0; b < 20; b += batchSize) {
  const currentBatch = Math.min(batchSize, 20 - b);
  const promises = Array.from({ length: currentBatch }, async (_, idx) => {
    const iter = b + idx + 1;
    const t0 = performance.now();
    let err: string | null = null;
    try {
      verifyNativeOwnerOnlyWindowsAcl(target);
    } catch (e: unknown) {
      err = e instanceof Error ? e.message : String(e);
    }
    const t1 = performance.now();
    const dur = t1 - t0;
    return { iteration: iter, duration_ms: Number(dur.toFixed(4)), error: err };
  });
  const results = await Promise.all(promises);
  for (const r of results) {
    concRuns.push(r);
    if (r.error) concErrors++;
    else concDurations.push(r.duration_ms);
  }
}

const output = {
  ffi_load_error: ffiLoadError,
  sequential_20: {
    stats: computeStats(seqDurations, seqErrors, 20),
    runs: seqRuns,
  },
  concurrency8_20: {
    stats: computeStats(concDurations, concErrors, 20),
    runs: concRuns,
  },
};

console.log(JSON.stringify(output, null, 2));
