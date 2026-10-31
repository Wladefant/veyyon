import { describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceBinaryForUpdate } from "../src/cli/update-cli";

/**
 * `veyyon update` replaces the binary that is running it.
 *
 * That is the ordinary case, not an edge one: the user types `veyyon update` and
 * the process doing the work IS the file being overwritten. Every other test of
 * the swap operates on a binary nothing is executing, which is the one state a
 * real update never happens in.
 *
 * The contract has two halves and they pull in opposite directions. The running
 * process must survive to finish its own update and print its own summary, and
 * the very next invocation must get the NEW version. Both hold only because the
 * swap is a rename: the running process keeps the inode it was started from, and
 * the path stops pointing at it. A swap that truncated and rewrote the file in
 * place would satisfy the second half and kill the first, mid-update, leaving
 * the user with no idea whether it finished.
 *
 * These are POSIX assertions. Windows cannot delete the image of a live process
 * at all, which is why the backup removal is best effort there and
 * `sweepStaleBackups` finishes the job on a later run; that half is covered by
 * `update-killed-mid-swap.test.ts`.
 */

/**
 * Comment lines between the wait and the version line, 16 KiB of them. dash and bash read a script
 * in blocks of at most 8 KiB, so the version line is read from the script's open descriptor after
 * the wait, not from a buffer filled at startup. That descriptor is how the running process sees
 * the swap: after a rename it still reads the old inode, and after a rewrite in place it reads the
 * new bytes at the same offset and prints the new version.
 */
const PAST_THE_READ_BUFFER = `${"#".repeat(63)}\n`.repeat(256);

/**
 * With `--wait` it reports `ready` on stderr once executing and blocks on stdin, so it is still
 * running through the swap for exactly as long as the test holds stdin open; then it reports its
 * version.
 */
function longRunningBinary(version: string): string {
	return `#!/bin/sh\nif [ "\${1:-}" = "--wait" ]; then echo ready >&2; read -r _; fi\n${PAST_THE_READ_BUFFER}echo "veyyon/${version}"\n`;
}

interface Running {
	/** Close stdin so the process runs to completion; resolves to its exit code and stdout. */
	finish(): Promise<{ code: number | null; stdout: string }>;
	/** Kill the process if it is still running; for cleanup after a failed assertion. */
	kill(): void;
}

/** Start `target --wait` and resolve once it is executing, not merely spawned. */
async function startRunning(target: string): Promise<Running> {
	const child: ChildProcessWithoutNullStreams = spawn(target, ["--wait"], { stdio: "pipe" });
	const closed = once(child, "close");
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", chunk => {
		stdout += chunk;
	});
	const ready = Promise.withResolvers<void>();
	child.stderr.setEncoding("utf8").on("data", chunk => {
		stderr += chunk;
		if (stderr.includes("ready")) ready.resolve();
	});
	child.once("close", code => ready.reject(new Error(`exited with ${code} before it was ready: ${stderr}`)));
	await ready.promise;
	return {
		async finish() {
			child.stdin.end();
			const [code] = await closed;
			return { code, stdout };
		},
		kill() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};
}

const OLD_VERSION = "1.0.0";
const NEW_VERSION = "2.0.0";

interface Layout {
	dir: string;
	target: string;
	temp: string;
	backup: string;
}

async function makeLayout(): Promise<Layout> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-update-running-"));
	const target = path.join(dir, "veyyon");
	const temp = path.join(dir, "veyyon.new");
	await fs.writeFile(target, longRunningBinary(OLD_VERSION), { mode: 0o755 });
	await fs.writeFile(temp, longRunningBinary(NEW_VERSION), { mode: 0o755 });
	return { dir, target, temp, backup: path.join(dir, "veyyon.1700000000000.4242.bak") };
}

async function swap(layout: Layout): Promise<void> {
	await replaceBinaryForUpdate({
		targetPath: layout.target,
		tempPath: layout.temp,
		backupPath: layout.backup,
		expectedVersion: NEW_VERSION,
		// Bound to the path, which is what production does: re-resolving the name
		// through PATH would ask what PATH picks right now, a different question.
		verifyInstalledVersion: async () => ({ ok: true, reportedVersion: NEW_VERSION }),
	});
}

describe("replacing the binary that is currently running", () => {
	/**
	 * The half that a truncate-and-rewrite implementation would break: the process
	 * already executing the old image has to run to completion. Asserted by its
	 * exit code AND its output, because a killed process and a process that never
	 * started both fail to produce output, and only one of them is the defect.
	 */
	it("lets the already-running process finish normally", async () => {
		const layout = await makeLayout();
		let running: Running | undefined;
		try {
			running = await startRunning(layout.target);

			await swap(layout);

			const { code, stdout } = await running.finish();
			expect(code).toBe(0);
			expect(stdout.trim()).toBe(`veyyon/${OLD_VERSION}`);
		} finally {
			running?.kill();
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);

	/**
	 * The other half. A rename that the running process somehow held open would
	 * leave the path serving the old version, so the update would report success
	 * and change nothing until the machine was rebooted.
	 */
	it("serves the new version to the very next invocation", async () => {
		const layout = await makeLayout();
		let running: Running | undefined;
		try {
			running = await startRunning(layout.target);

			await swap(layout);

			const next = Bun.spawnSync([layout.target]);
			expect(next.exitCode).toBe(0);
			expect(next.stdout.toString().trim()).toBe(`veyyon/${NEW_VERSION}`);

			await running.finish();
		} finally {
			running?.kill();
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);

	/**
	 * The bytes on disk, not just what the file prints. A partial write also
	 * changes the output, and a file left non-executable is an install the user's
	 * shell can no longer run.
	 */
	it("leaves the new binary whole and executable at the same path", async () => {
		const layout = await makeLayout();
		let running: Running | undefined;
		try {
			running = await startRunning(layout.target);

			await swap(layout);

			expect(await fs.readFile(layout.target, "utf8")).toBe(longRunningBinary(NEW_VERSION));
			expect(((await fs.stat(layout.target)).mode & 0o111) !== 0).toBe(true);
			await running.finish();
		} finally {
			running?.kill();
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);

	/**
	 * And it leaves nothing behind, even though a process is still executing the
	 * image it just moved aside. That is safe on POSIX precisely because the
	 * running process holds the INODE: unlinking the backup takes the name away
	 * and the bytes stay alive until the last descriptor closes. On Windows the
	 * same removal fails while the process lives, which is why the removal is
	 * best effort and `sweepStaleBackups` exists to finish the job later.
	 */
	it("leaves no backup or staged download in the install directory", async () => {
		const layout = await makeLayout();
		let running: Running | undefined;
		try {
			running = await startRunning(layout.target);

			await swap(layout);

			// Sorted, and the owner receipt is asserted PRESENT rather than filtered out. The
			// updater restamps `.<basename>.veyyon-owner` on every swap because an install with no
			// receipt is refused by its own uninstaller, so a directory holding only the binary
			// would be the bug, not the clean result this test used to expect.
			expect((await fs.readdir(layout.dir)).sort()).toEqual([".veyyon.veyyon-owner", "veyyon"]);
			// The still-running process is unaffected by losing the backup's name.
			expect((await running.finish()).code).toBe(0);
		} finally {
			running?.kill();
			await fs.rm(layout.dir, { recursive: true, force: true });
		}
	}, 20_000);
});
