/**
 * Regression for https://github.com/can1357/oh-my-pi/issues/9158
 *
 * `createWorkerSubprocess` spawns every worker with `serialization: "advanced"`.
 * When a child sends a malformed or truncated advanced-IPC frame, Bun raises the
 * structured-clone decode failure as a process-level `uncaughtException` in the
 * PARENT (oven-sh/bun#37287) — not in the channel's `ipc()` callback. The global
 * postmortem handler treated that as fatal and exited the whole session with
 * code 1, defeating the entire point of isolating worker failures in a subprocess.
 *
 * The fix teaches the postmortem `uncaughtException` handler to recognize that
 * specific Bun decode error (`isWorkerIpcDeserializeError`) and contain it to the
 * offending worker: log and continue instead of exiting. This test spawns a real
 * parent process (which installs the postmortem handler on import) whose worker
 * emits a bad frame, and pins that the parent SURVIVES and the failure still
 * reaches the worker's own error channel.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("issue #9158 — malformed worker IPC frame must not terminate the parent", () => {
	it("contains an advanced-serialization decode failure to the worker instead of exiting the session", async () => {
		const repoRoot = path.resolve(import.meta.dir, "..");
		// Bun advanced-IPC frame with an invalid structured-clone body, written
		// raw to the IPC fd (3) — the same shape the issue reporter used.
		const childScript =
			'require("node:fs").writeSync(3, Buffer.from([2, 4, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef])); process.exit(0);';
		// Runs in a spawned `bun -e` parent: importing postmortem installs the global
		// uncaughtException handler under test.
		const wrapperScript = `
			import "@veyyon/utils/postmortem";
			import { createWorkerSubprocess } from "@veyyon/coding-agent/subprocess/worker-client";
			const worker = createWorkerSubprocess({
				spawnCommand: { cmd: [process.execPath, "-e", ${JSON.stringify(childScript)}] },
				env: {},
				exitLabel: "malformed IPC child",
				reportCleanExit: true,
				unref: false,
			});
			const { promise: errored, resolve } = Promise.withResolvers();
			worker.errors.add(resolve);
			// Deterministic: the bad frame is contained, then the clean child exit
			// (reportCleanExit) faults the worker's own error channel.
			await errored;
			process.stdout.write("SURVIVED_WITH_ERROR");
		`;
		const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, VEYYON_TEST_RUNTIME: "0" },
		});
		const [stdout, _stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// Before the fix the postmortem handler exited the parent with code 1 and
		// no "SURVIVED" marker ever printed.
		expect(exitCode).toBe(0);
		expect(stdout).toBe("SURVIVED_WITH_ERROR");
	}, 45_000);
	it("still faults on an unrelated TypeError with the same message but a real stack", async () => {
		// Guards the narrowed matcher: an application-thrown `TypeError` carrying
		// this exact message but a populated stack must stay on the fatal path,
		// so a genuine bug is never silently swallowed as a worker IPC frame.
		const repoRoot = path.resolve(import.meta.dir, "..");
		const wrapperScript = `
			import "@veyyon/utils/postmortem";
			import "@veyyon/coding-agent/subprocess/worker-client";
			process.stdout.write("BEFORE_THROW");
			queueMicrotask(() => { throw new TypeError("Unable to deserialize data."); });
		`;
		const proc = Bun.spawn([process.execPath, "-e", wrapperScript], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, VEYYON_TEST_RUNTIME: "0" },
		});
		const [stdout, _stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(1);
		expect(stdout).toBe("BEFORE_THROW");
	}, 45_000);
});
