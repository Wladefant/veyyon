/**
 * WHY THIS SUITE EXISTS: workspace diagnostics read the checker's stdout and stderr to the end. A
 * checker that starts children (cargo starts rustc) hands them those pipes. An abort that ended only
 * the checker left the children holding the pipes open, so the aborted call settled only when the
 * last child exited, and a long-lived child was never ended at all.
 *
 * Contract: an abort ends the checker and every process it started, and the call settles without
 * waiting for them. The settle time and the child's death are both bounded, so the defect shows as a
 * failure here rather than as a hung run.
 *
 * NOT CAUGHT: Windows, where the fake checker (a POSIX shell script) cannot run, and a host without
 * the native addon, where the process tree cannot be walked and only the checker itself is ended.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runWorkspaceDiagnostics } from "@veyyon/coding-agent/lsp/workspace-diagnostics";
import { ToolAbortError } from "@veyyon/coding-agent/tools/core/tool-errors";
import { TempDir } from "@veyyon/utils";

/**
 * Whether `pid` is still running. A killed orphan under a container's PID 1 can stay in the process
 * table unreaped; that zombie runs nothing and holds no pipe, so it counts as ended. Without `/proc`
 * (macOS) the signal probe alone answers.
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return true;
	}
}

/** Polls `check` every 10 ms until it holds or `ms` elapse; returns whether it held. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
	const deadline = performance.now() + ms;
	while (!check()) {
		if (performance.now() >= deadline) return false;
		await delay(10);
	}
	return true;
}

describe.skipIf(process.platform === "win32")("an aborted workspace check", () => {
	it("ends the checker and the processes it started, and settles without waiting for them", async () => {
		const dir = TempDir.createSync("@veyyon-diagnostics-abort-");
		const project = path.join(dir.path(), "project");
		const fakeCargo = path.join(dir.path(), "cargo");
		const pidFile = path.join(project, "child.pid");
		fs.mkdirSync(project);
		fs.writeFileSync(path.join(project, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.0"\n');
		// A checker that starts a long-lived child, which inherits its output pipes, and waits on it.
		fs.writeFileSync(fakeCargo, `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nwait\n`, { mode: 0o755 });

		// The checker binary is the one external boundary: `cargo` is swapped for the fake at the
		// spawn call, and the real spawn, process supervision and abort path run as shipped.
		const realSpawn = Bun.spawn.bind(Bun);
		vi.spyOn(Bun, "spawn").mockImplementation(((
			cmd: string[],
			options?: Bun.SpawnOptions.SpawnOptions<
				Bun.SpawnOptions.Writable,
				Bun.SpawnOptions.Readable,
				Bun.SpawnOptions.Readable
			>,
		) => realSpawn(cmd[0] === "cargo" ? [fakeCargo, ...cmd.slice(1)] : cmd, options)) as typeof Bun.spawn);
		let childPid: number | undefined;
		try {
			const controller = new AbortController();
			const run = runWorkspaceDiagnostics(project, controller.signal);
			const started = await within(
				5_000,
				() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "",
			);
			if (!started) {
				const settled = await Promise.race([run.catch(error => String(error)), delay(1_000, "still running")]);
				throw new Error(`the fake checker never wrote its child pid; the run gave ${JSON.stringify(settled)}`);
			}
			childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
			expect(isAlive(childPid)).toBe(true);

			const abortedAt = performance.now();
			controller.abort();
			await expect(run).rejects.toBeInstanceOf(ToolAbortError);
			expect(performance.now() - abortedAt).toBeLessThan(2_000);

			const pid = childPid;
			expect(await within(2_000, () => !isAlive(pid))).toBe(true);
		} finally {
			vi.restoreAllMocks();
			if (childPid !== undefined && isAlive(childPid)) process.kill(childPid, "SIGKILL");
			dir.removeSync();
		}
	}, 15_000);
});
