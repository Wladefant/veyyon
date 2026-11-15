import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const EVIDENCE_DIR = path.resolve(__dirname);
const SCRATCH_FILE = path.join(EVIDENCE_DIR, "scratch-terminal", "terminal_scratch.json");
const VERIFY_PS1 = path.join(EVIDENCE_DIR, "verify.ps1");
const OUTPUT_JSON = path.join(EVIDENCE_DIR, "event-loop-lag-results.json");

const systemRoot = process.env.SystemRoot || "C:\\Windows";
const powershellExe = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

interface LaunchMetric {
  iteration: number;
  spawnCallElapsedMs: number;
  spawnEventElapsedMs: number;
  firstStdoutElapsedMs: number | null;
  totalElapsedMs: number;
  exitCode: number | null;
  timedOut: boolean;
  timerCallbackElapsedMs: number | null;
  timerLagAtTimeoutMs: number | null;
  maxTimerLagDuringRunMs: number;
  stdout: string;
  stderr: string;
}

// Global 100ms interval timer lag tracker
const allTimerLags: number[] = [];
let maxObservedLag = 0;
let lastTick = performance.now();

const timerInterval = setInterval(() => {
  const now = performance.now();
  const delta = now - lastTick;
  lastTick = now;
  const lag = Math.max(0, delta - 100);
  allTimerLags.push(lag);
  if (lag > maxObservedLag) {
    maxObservedLag = lag;
  }
}, 100);
// Do not keep event loop alive solely for timer
timerInterval.unref();

function runTimedLaunch(iteration: number, timeoutMs = 15000): Promise<LaunchMetric> {
  const { promise, resolve } = Promise.withResolvers<LaunchMetric>();

  let localMaxLag = 0;
  let localLast = performance.now();
  const localTracker = setInterval(() => {
    const now = performance.now();
    const delta = now - localLast;
    localLast = now;
    const lag = Math.max(0, delta - 100);
    if (lag > localMaxLag) localMaxLag = lag;
  }, 100);
  localTracker.unref();

  const tStart = performance.now();
  let spawnEventElapsedMs = 0;
  let firstStdoutElapsedMs: number | null = null;
  let timedOut = false;
  let timerCallbackElapsedMs: number | null = null;
  let timerLagAtTimeoutMs: number | null = null;
  let settled = false;

  const t0 = performance.now();
  const child = spawn(
    powershellExe,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      VERIFY_PS1,
    ],
    {
      env: {
        SystemRoot: systemRoot,
        VEYYON_OWNER_ONLY_ACL_PATH: SCRATCH_FILE,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const spawnCallElapsedMs = performance.now() - t0;

  child.on("spawn", () => {
    spawnEventElapsedMs = performance.now() - tStart;
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    if (firstStdoutElapsedMs === null) {
      firstStdoutElapsedMs = performance.now() - tStart;
    }
    stdoutChunks.push(chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const finish = (exitCode: number | null) => {
    if (settled) return;
    settled = true;
    clearInterval(localTracker);
    clearTimeout(timerHandle);

    const totalElapsedMs = performance.now() - tStart;
    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

    resolve({
      iteration,
      spawnCallElapsedMs: Number(spawnCallElapsedMs.toFixed(2)),
      spawnEventElapsedMs: Number(spawnEventElapsedMs.toFixed(2)),
      firstStdoutElapsedMs: firstStdoutElapsedMs !== null ? Number(firstStdoutElapsedMs.toFixed(2)) : null,
      totalElapsedMs: Number(totalElapsedMs.toFixed(2)),
      exitCode,
      timedOut,
      timerCallbackElapsedMs: timerCallbackElapsedMs !== null ? Number(timerCallbackElapsedMs.toFixed(2)) : null,
      timerLagAtTimeoutMs: timerLagAtTimeoutMs !== null ? Number(timerLagAtTimeoutMs.toFixed(2)) : null,
      maxTimerLagDuringRunMs: Number(localMaxLag.toFixed(2)),
      stdout,
      stderr,
    });
  };

  const timerHandle = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    const timerNow = performance.now();
    timerCallbackElapsedMs = timerNow - tStart;
    timerLagAtTimeoutMs = timerCallbackElapsedMs - timeoutMs;

    try {
      child.kill();
    } catch {}
    finish(-1);
  }, timeoutMs);

  child.on("close", (code) => {
    finish(code);
  });

  child.on("error", (err) => {
    stderrChunks.push(Buffer.from(String(err)));
    finish(-1);
  });

  return promise;
}

function nearestRankPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (p <= 0) return sorted[0];
  if (p >= 100) return sorted[sorted.length - 1];
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[idx];
}

async function main() {
  console.log("=== Event Loop Delay & Process Scheduling Measurement ===");
  console.log("Testing PowerShell launches under CURRENT natural load with 15s timer...");

  const runs: LaunchMetric[] = [];
  const count = 10;

  for (let i = 1; i <= count; i++) {
    const res = await runTimedLaunch(i, 15000);
    runs.push(res);
    console.log(
      `  [Launch ${i}/${count}] total: ${res.totalElapsedMs}ms, spawnCall: ${res.spawnCallElapsedMs}ms, ` +
      `spawnEvent: ${res.spawnEventElapsedMs}ms, timedOut: ${res.timedOut}, maxLag: ${res.maxTimerLagDuringRunMs}ms`
    );
  }

  console.log("\nTesting 4 concurrent PowerShell launches with 15s timer under natural load...");
  const concPromises = Array.from({ length: 4 }, (_, idx) => runTimedLaunch(count + idx + 1, 15000));
  const concResults = await Promise.all(concPromises);
  runs.push(...concResults);
  for (const res of concResults) {
    console.log(
      `  [Conc Launch ${res.iteration}] total: ${res.totalElapsedMs}ms, spawnCall: ${res.spawnCallElapsedMs}ms, ` +
      `spawnEvent: ${res.spawnEventElapsedMs}ms, timedOut: ${res.timedOut}, maxLag: ${res.maxTimerLagDuringRunMs}ms`
    );
  }

  clearInterval(timerInterval);

  const sortedLags = [...allTimerLags].sort((a, b) => a - b);
  const p50Lag = nearestRankPercentile(sortedLags, 50);
  const p95Lag = nearestRankPercentile(sortedLags, 95);
  const maxLag = sortedLags.length > 0 ? sortedLags[sortedLags.length - 1] : 0;
  const meanLag = sortedLags.length > 0 ? sortedLags.reduce((a, b) => a + b, 0) / sortedLags.length : 0;

  const timeoutsCount = runs.filter((r) => r.timedOut).length;

  const summary = {
    total_launches: runs.length,
    timeouts_count: timeoutsCount,
    timeout_reproduced: timeoutsCount > 0,
    timer_lag_100ms_stats: {
      samples_count: allTimerLags.length,
      p50_ms: Number(p50Lag.toFixed(2)),
      p95_ms: Number(p95Lag.toFixed(2)),
      max_ms: Number(maxLag.toFixed(2)),
      mean_ms: Number(meanLag.toFixed(2)),
      stalls_over_100ms_count: allTimerLags.filter((l) => l > 100).length,
      stalls_over_500ms_count: allTimerLags.filter((l) => l > 500).length,
      stalls_over_1000ms_count: allTimerLags.filter((l) => l > 1000).length,
    },
    process_scheduling_stats: {
      spawn_call_p50_ms: Number(nearestRankPercentile(runs.map((r) => r.spawnCallElapsedMs).sort((a, b) => a - b), 50).toFixed(2)),
      spawn_call_p95_ms: Number(nearestRankPercentile(runs.map((r) => r.spawnCallElapsedMs).sort((a, b) => a - b), 95).toFixed(2)),
      spawn_call_max_ms: Number(Math.max(...runs.map((r) => r.spawnCallElapsedMs)).toFixed(2)),
      spawn_event_p50_ms: Number(nearestRankPercentile(runs.map((r) => r.spawnEventElapsedMs).sort((a, b) => a - b), 50).toFixed(2)),
      spawn_event_p95_ms: Number(nearestRankPercentile(runs.map((r) => r.spawnEventElapsedMs).sort((a, b) => a - b), 95).toFixed(2)),
    },
    runs,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\nResults written to: ${OUTPUT_JSON}`);
  console.log(`Summary: timeout_reproduced=${summary.timeout_reproduced} (${timeoutsCount}/${runs.length})`);
  console.log(`Timer lag: p50=${summary.timer_lag_100ms_stats.p50_ms}ms, p95=${summary.timer_lag_100ms_stats.p95_ms}ms, max=${summary.timer_lag_100ms_stats.max_ms}ms`);
  console.log(`Process spawn call: p50=${summary.process_scheduling_stats.spawn_call_p50_ms}ms, max=${summary.process_scheduling_stats.spawn_call_max_ms}ms`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
