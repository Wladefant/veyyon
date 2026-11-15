import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

const EVIDENCE_DIR = path.resolve(__dirname);
const SCRATCH_FILE = path.join(EVIDENCE_DIR, "scratch-terminal", "terminal_scratch.json");
const VERIFY_PS1 = path.join(EVIDENCE_DIR, "verify_timestamped.ps1");
const OUTPUT_JSON = path.join(EVIDENCE_DIR, "bun_timestamp_probe_results.json");

const systemRoot = process.env.SystemRoot || "C:\\Windows";
const powershellExe = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

interface BunProbeResult {
  iteration: number;
  spawnCallElapsedMs: number;
  spawnEventElapsedMs: number;
  psScriptEndUtc: string | null;
  childExitEventElapsedMs: number;
  childCloseEventElapsedMs: number;
  promiseResolveElapsedMs: number;
  deltaPsScriptToCloseMs: number | null;
  totalWallMs: number;
  exitCode: number | null;
  stdout: string;
}

function runProbeIteration(iteration: number): Promise<BunProbeResult> {
  const { promise, resolve } = Promise.withResolvers<BunProbeResult>();

  const tStart = performance.now();
  const spawnStartUtc = new Date().toISOString();
  let spawnEventElapsedMs = 0;
  let childExitEventElapsedMs = 0;
  let childCloseEventElapsedMs = 0;
  let psScriptEndUtc: string | null = null;

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
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
    const text = chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (line.includes("PS_SCRIPT_END:")) {
        psScriptEndUtc = line.split("PS_SCRIPT_END:")[1].trim();
      }
    }
  });

  child.on("exit", (code) => {
    childExitEventElapsedMs = performance.now() - tStart;
  });

  child.on("close", (code) => {
    childCloseEventElapsedMs = performance.now() - tStart;
    const promiseResolveElapsedMs = performance.now() - tStart;
    const totalWallMs = promiseResolveElapsedMs;

    let deltaPsScriptToCloseMs: number | null = null;
    if (psScriptEndUtc) {
      const psEndDate = new Date(psScriptEndUtc).getTime();
      const startDate = new Date(spawnStartUtc).getTime();
      const psScriptElapsedFromStart = psEndDate - startDate;
      deltaPsScriptToCloseMs = childCloseEventElapsedMs - psScriptElapsedFromStart;
    }

    resolve({
      iteration,
      spawnCallElapsedMs: Number(spawnCallElapsedMs.toFixed(2)),
      spawnEventElapsedMs: Number(spawnEventElapsedMs.toFixed(2)),
      psScriptEndUtc,
      childExitEventElapsedMs: Number(childExitEventElapsedMs.toFixed(2)),
      childCloseEventElapsedMs: Number(childCloseEventElapsedMs.toFixed(2)),
      promiseResolveElapsedMs: Number(promiseResolveElapsedMs.toFixed(2)),
      deltaPsScriptToCloseMs: deltaPsScriptToCloseMs !== null ? Number(deltaPsScriptToCloseMs.toFixed(2)) : null,
      totalWallMs: Number(totalWallMs.toFixed(2)),
      exitCode: code,
      stdout: Buffer.concat(stdoutChunks).toString("utf8").trim(),
    });
  });

  return promise;
}

async function main() {
  console.log("Running Bun timestamp probe (3 iterations)...");
  const runs: BunProbeResult[] = [];
  for (let i = 1; i <= 3; i++) {
    const res = await runProbeIteration(i);
    runs.push(res);
    console.log(
      `  Iteration ${i}: spawnCall=${res.spawnCallElapsedMs}ms, exitEvent=${res.childExitEventElapsedMs}ms, ` +
      `closeEvent=${res.childCloseEventElapsedMs}ms, promiseResolve=${res.promiseResolveElapsedMs}ms, total=${res.totalWallMs}ms`
    );
  }

  const output = {
    description: "Bun timestamp probe measuring spawn call, PS script completion marker, JS 'exit' event, JS 'close' event, and promise resolution.",
    limitations: "Independent probe in isolated runner. Cannot observe event-loop lag or synchrony stalls in the original incident caller process.",
    runs,
  };

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(output, null, 2), "utf8");
  console.log(`Results saved to ${OUTPUT_JSON}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
