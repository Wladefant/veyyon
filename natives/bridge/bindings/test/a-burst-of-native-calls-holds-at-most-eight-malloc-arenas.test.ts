import { describe, expect, it } from "bun:test";
import * as path from "node:path";

/**
 * WHY: glibc gives every thread that calls `malloc` an arena of its own, up to eight per core, and
 * each arena keeps its own free chunks. Concurrent shell commands and searches run on the addon's
 * blocking pool, Rayon and libuv threads, so one burst of tool calls grew 242 arenas on a 32-thread
 * host and left 340 MiB resident after the free pages were released; a long session held 3.6 GiB
 * in 206 arena heaps. The addon's module initializer caps the arenas at eight. The defect class is
 * any load path where the cap is not in force before the addon's threads allocate: the call
 * dropped from the initializer, moved after the first native thread starts, or a cap set so late
 * that glibc has already fixed its limit. The cap must also leave an explicit `MALLOC_ARENA_MAX`
 * or `glibc.malloc.arena_max` tunable in force.
 *
 * The probe runs in a fresh child, so the addon loads through the production loader exactly once.
 * It runs 32 shell commands and 16 searches at once, then has glibc print its arenas with
 * `malloc_stats`. The explicit-limit cases double as the control: under a limit of 64 the same
 * burst must grow more than eight arenas, or the default case could not see a missing cap.
 *
 * Gap: arenas grow only with threads that allocate at the same moment, so a host that runs the
 * burst on eight or fewer threads cannot tell a missing cap from a working one; the control cases
 * then fail rather than pass silently. glibc Linux only.
 */

const INDEX_URL = `file://${path.resolve(import.meta.dir, "..", "native", "index.js")}`;
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const CAP = 8;

const PROBE = `
import { dlopen, FFIType } from "bun:ffi";
import { executeShell, grep } from ${JSON.stringify(INDEX_URL)};
const root = process.cwd();
const work = [];
for (let i = 0; i < 32; i++) work.push(executeShell({ command: "seq 1 " + (20000 + i) + " | sort -r | wc -l", cwd: root }));
for (let i = 0; i < 16; i++) work.push(grep({ pattern: "fn\\\\s+\\\\w*" + (i % 10), path: root + "/natives", maxCount: 500 }));
await Promise.all(work);
dlopen("libc.so.6", { malloc_stats: { args: [], returns: FFIType.void } }).symbols.malloc_stats();
`;

/** True when the runtime's C library is glibc; Bun leaves `process.versions.glibc` unset. */
function runsOnGlibc(): boolean {
	const report: unknown = process.report?.getReport();
	if (typeof report !== "object" || report === null || !("header" in report)) return false;
	const header = report.header;
	return typeof header === "object" && header !== null && "glibcVersionRuntime" in header;
}

async function arenasAfterBurst(env: Record<string, string>): Promise<number> {
	const childEnv: Record<string, string | undefined> = { ...process.env, ...env };
	if (!("MALLOC_ARENA_MAX" in env)) delete childEnv.MALLOC_ARENA_MAX;
	if (!("GLIBC_TUNABLES" in env)) delete childEnv.GLIBC_TUNABLES;
	const proc = Bun.spawn([process.execPath, "-e", PROBE], {
		cwd: REPO_ROOT,
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new Error(`probe exited ${exitCode}: ${stderr}`);
	return stderr.match(/^Arena \d+:$/gm)?.length ?? 0;
}

describe.skipIf(process.platform !== "linux" || !runsOnGlibc())("glibc malloc arenas", () => {
	it("stay at eight or fewer through a burst of concurrent native calls", async () => {
		const arenas = await arenasAfterBurst({});
		expect(arenas).toBeGreaterThan(0);
		expect(arenas).toBeLessThanOrEqual(CAP);
	});

	it("follow MALLOC_ARENA_MAX when the environment sets it", async () => {
		expect(await arenasAfterBurst({ MALLOC_ARENA_MAX: "64" })).toBeGreaterThan(CAP);
	});

	it("follow glibc.malloc.arena_max in GLIBC_TUNABLES when the environment sets it", async () => {
		expect(await arenasAfterBurst({ GLIBC_TUNABLES: "glibc.malloc.arena_max=64" })).toBeGreaterThan(CAP);
	});
});
