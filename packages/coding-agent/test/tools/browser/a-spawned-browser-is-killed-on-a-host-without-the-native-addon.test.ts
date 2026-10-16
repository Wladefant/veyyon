import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * WHY: `gracefulKillTreeOnce` is how the browser tool ends a browser it spawned:
 * a headless Chromium whose `close()` timed out, an app whose CDP endpoint never
 * came up, a spawned app on session dispose. It asked the native addon for a
 * process handle and returned when there was none, so on a host where the addon
 * cannot load (issue #917) it killed nothing and the browser outlived the
 * session that started it.
 *
 * The class this closes: the browser tool's single-pid kill degrading to a
 * no-op instead of to the runtime's own signals. The runtime fallback keeps the
 * helper's contract, polite signal first and a hard kill after the grace.
 *
 * What it does NOT catch: descendants of the pid. Without the addon there is no
 * tree walk, so a renderer that outlives its browser process is not reached.
 * `killExistingByPath` finds processes by executable path, which has no runtime
 * equivalent, and still finds nothing on such a host.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..");
const ATTACH_URL = `file://${path.join(REPO_ROOT, "packages/coding-agent/src/tools/web/browser/attach.ts")}`;

/**
 * Run a snippet on a host the loader has no addon for: a platform outside the
 * supported set leaves every candidate unresolvable, the same terminal state as
 * a glibc mismatch. The override precedes the dynamic import of the loader.
 */
function runWithoutAddon(body: string): { stdout: string; stderr: string; status: number | null } {
	const snippet = `Object.defineProperty(process, "platform", { value: "sunos", configurable: true });\n${body}`;
	const result = spawnSync(process.execPath, ["-e", snippet], { cwd: REPO_ROOT, encoding: "utf8", timeout: 20_000 });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function parseStdout(run: { stdout: string; stderr: string }): unknown {
	try {
		return JSON.parse(run.stdout);
	} catch {
		throw new Error(`child produced no JSON verdict; stdout ${JSON.stringify(run.stdout)}, stderr ${run.stderr}`);
	}
}

/** Spawn `script`, wait for its `ready` line, kill it through the helper, and report how it ended. */
function killScript(script: string, graceMs: number): unknown {
	const run = runWithoutAddon(
		`const { gracefulKillTreeOnce } = await import(${JSON.stringify(ATTACH_URL)});
		const child = Bun.spawn(["sh", "-c", ${JSON.stringify(script)}], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		const reader = child.stdout.getReader();
		await reader.read();
		reader.releaseLock();
		const started = performance.now();
		let threw = null;
		try { await gracefulKillTreeOnce(child.pid, ${graceMs}); } catch (error) { threw = String(error && error.message); }
		const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
		const elapsedMs = performance.now() - started;
		if (!exited) child.kill("SIGKILL");
		process.stdout.write(JSON.stringify({ threw, exited, signal: child.signalCode, waitedForGrace: elapsedMs >= ${graceMs} - 50 }));
		process.exit(0);`,
	);
	expect(run.status).toBe(0);
	return parseStdout(run);
}

describe.skipIf(process.platform === "win32")("killing a spawned browser on a host without the native addon", () => {
	it("ends a process that stops on the polite signal", () => {
		expect(killScript("echo ready; exec sleep 30", 400)).toMatchObject({
			threw: null,
			exited: true,
			signal: "SIGTERM",
		});
	});

	it("hard-kills a process that ignores the polite signal, after the grace", () => {
		expect(killScript('trap "" TERM; echo ready; exec sleep 30', 400)).toEqual({
			threw: null,
			exited: true,
			signal: "SIGKILL",
			waitedForGrace: true,
		});
	});
});
