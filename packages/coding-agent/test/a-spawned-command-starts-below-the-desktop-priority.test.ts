/**
 * A command an agent runs starts below the desktop's CPU priority.
 *
 * ## The defect class this closes
 *
 * Every process a session spawned ran at the priority of the terminal, the
 * compositor and the harness itself. A parallel fan-out from one tool call (a
 * frame extraction per CPU from an eval cell, a `cargo build`, an `xargs -P`)
 * then held every core at the same weight as the terminal the operator was
 * typing into, and the screen stalled until the burst ended. Every process a
 * session spawns now starts at `SPAWN_NICE`, so contention resolves in the
 * desktop's favor and an idle machine runs the work at full speed.
 *
 * The TypeScript spawn sites apply the level in the adoption closures, and
 * cpu-limit-adoption.test.ts asserts it at every wired site, which
 * cpu-limit-spawn-sites.test.ts forces every site to be. The native spawn
 * points apply it in Rust: the brush spawn observer behind the bash tool, and
 * the PTY spawner behind interactive bash and `launch`. This suite drives both
 * through the entries the product calls, and pins the Rust level to
 * `SPAWN_NICE` so the two halves cannot drift apart.
 *
 * ## What it does not catch
 *
 * A native spawn point added outside the brush observer and the PTY spawner.
 * A grandchild forked in the microseconds between the spawn and the priority
 * change keeps the inherited level. Windows has no `/bin/sh` here, so its
 * `BELOW_NORMAL_PRIORITY_CLASS` branch is exercised by no test in this file.
 */

import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { executeBash } from "@veyyon/coding-agent/exec/bash-executor";
import { SPAWN_NICE } from "@veyyon/coding-agent/session/cpu-limit";
import { PtySession } from "@veyyon/natives";

/** A child inherits the runner's level, so a runner niced past SPAWN_NICE hands its own down. */
const EXPECTED = Math.max(os.getPriority(), SPAWN_NICE);

/** The direct child reports its own pid and stays alive until the case aborts it. */
const CHILD_SCRIPT = "echo $$; exec sleep 10";

/** How long the level may take to settle after the pid is printed. */
const SETTLE_MS = 2_000;

/** The first pid printed into `output`, once one is there. */
function pidIn(output: string): number | undefined {
	const match = /\d+/.exec(output);
	return match ? Number(match[0]) : undefined;
}

/** Poll `read` until it answers or SETTLE_MS passes, failing with `what`. */
async function poll<T>(what: string, read: () => T | undefined): Promise<T> {
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

/** The child's level once it reaches EXPECTED, or the last level read when it never does. */
async function settledPriority(pid: number): Promise<number> {
	const deadline = Date.now() + SETTLE_MS;
	let level = os.getPriority(pid);
	while (level !== EXPECTED && Date.now() < deadline) {
		await sleep(10);
		level = os.getPriority(pid);
	}
	return level;
}

describe.skipIf(process.platform === "win32")("a spawned command starts below the desktop priority", () => {
	it("a bash tool command starts at SPAWN_NICE", async () => {
		let output = "";
		const abort = new AbortController();
		const run = executeBash(`/bin/sh -c '${CHILD_SCRIPT}'`, {
			timeout: 20_000,
			signal: abort.signal,
			onChunk: chunk => {
				output += chunk;
			},
		});
		try {
			const pid = await poll("the bash child's pid", () => pidIn(output));
			expect(await settledPriority(pid)).toBe(EXPECTED);
		} finally {
			abort.abort();
			await run.catch(() => {});
		}
	});

	it("a PTY command starts at SPAWN_NICE", async () => {
		let output = "";
		const session = new PtySession();
		const run = session.startArgv(
			{ application: "/bin/sh", args: ["-c", CHILD_SCRIPT], timeoutMs: 20_000, cols: 80, rows: 24 },
			(_error, chunk) => {
				output += chunk;
			},
		);
		try {
			const pid = await poll("the PTY child's pid", () => pidIn(output));
			expect(await settledPriority(pid)).toBe(EXPECTED);
		} finally {
			session.kill();
			await run.catch(() => {});
		}
	});
});
