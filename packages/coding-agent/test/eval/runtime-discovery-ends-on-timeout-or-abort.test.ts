/**
 * WHY: availability probes run before the cell watchdog. A stuck interpreter
 * must terminate during discovery, not stall the turn. Real child processes
 * cover each subprocess backend; native Windows console handles remain a gap.
 * These integration bounds use the platform clock because fake timers cannot
 * prove that the OS killed and reaped a real interpreter subprocess.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as julia from "@veyyon/coding-agent/eval/jl/kernel";
import { disposeKernelToolBridge } from "@veyyon/coding-agent/eval/kernel-tool-bridge";
import { runBoundedProbe } from "@veyyon/coding-agent/eval/probe";
import { disposeKernelSessionsByOwner } from "@veyyon/coding-agent/eval/py/executor";
import * as python from "@veyyon/coding-agent/eval/py/kernel";
import * as ruby from "@veyyon/coding-agent/eval/rb/kernel";
import { ToolAbortError } from "@veyyon/coding-agent/tools/core/tool-errors";
import { EvalTool } from "@veyyon/coding-agent/tools/shell/eval";
import { evalBackendLoaders } from "@veyyon/coding-agent/tools/shell/manifest";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

// Lazy module loading is separate from the interpreter discovery deadline.
beforeAll(() => evalBackendLoaders.python());
afterAll(disposeKernelToolBridge);

useIsolatedAgentDir({ globalSettings: true });
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		const pid = Number(await fs.readFile(path.join(root, "pid"), "utf8").catch(() => "0"));
		if (pid > 0) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* Already reaped. */
			}
		}
		await fs.rm(root, { recursive: true, force: true });
	}
});

async function interpreter() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-probe-"));
	roots.push(root);
	const pidFile = path.join(root, "pid");
	const executable = path.join(root, "interpreter");
	const code = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
	await fs.writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e '${code}'\n`, {
		mode: 0o755,
	});
	return { root, executable, pidFile };
}

async function expectReaped(pidFile: string) {
	const pid = Number(await fs.readFile(pidFile, "utf8"));
	expect(() => process.kill(pid, 0)).toThrow();
}

const backends = [
	{ name: "python", check: python.checkPythonKernelAvailability },
	{ name: "ruby", check: ruby.checkRubyKernelAvailability },
	{ name: "julia", check: julia.checkJuliaKernelAvailability },
];

describe("runtime availability probes", () => {
	it("reaps a stalled interpreter at the supplied deadline", async () => {
		const fixture = await interpreter();
		const started = Date.now();
		const result = await runBoundedProbe([fixture.executable], {
			cwd: fixture.root,
			env: process.env,
			timeoutMs: 250,
		});
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - started).toBeLessThan(3000);
		await expectReaped(fixture.pidFile);
	}, 5000);

	it("does not spawn when cancellation precedes discovery", async () => {
		const fixture = await interpreter();
		const controller = new AbortController();
		controller.abort();
		expect(
			await runBoundedProbe([fixture.executable], {
				cwd: fixture.root,
				env: process.env,
				signal: controller.signal,
			}),
		).toEqual({ exitCode: null, timedOut: false, aborted: true });
		expect(await fs.stat(fixture.pidFile).catch(() => null)).toBeNull();
	});

	it("returns an interpreter's real nonzero exit code", async () => {
		expect(
			await runBoundedProbe([process.execPath, "-e", "process.exit(23)"], { cwd: process.cwd(), env: process.env }),
		).toEqual({ exitCode: 23, timedOut: false, aborted: false });
	});

	it("gives a stdin-reading interpreter EOF rather than a live parent handle", async () => {
		const result = await runBoundedProbe(
			[process.execPath, "-e", 'process.stdin.on("end", () => process.exit(0)); process.stdin.resume();'],
			{ cwd: process.cwd(), env: process.env, timeoutMs: 1000 },
		);
		expect(result).toEqual({ exitCode: 0, timedOut: false, aborted: false });
	});

	for (const backend of backends) {
		it(`${backend.name} discovery bounds a configured stalled interpreter`, async () => {
			const fixture = await interpreter();
			const result = await backend.check(fixture.root, fixture.executable, { forceProbe: true, timeoutMs: 300 });
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("probe timed out");
			await expectReaped(fixture.pidFile);
		}, 5000);
	}

	it("aborting one caller does not cancel another caller's discovery", async () => {
		const fixture = await interpreter();
		const controller = new AbortController();
		const first = python.checkPythonKernelAvailability(fixture.root, fixture.executable, {
			forceProbe: true,
			signal: controller.signal,
			timeoutMs: 2000,
		});
		const second = python.checkPythonKernelAvailability(fixture.root, fixture.executable, {
			forceProbe: true,
			timeoutMs: 400,
		});
		const timer = setTimeout(() => controller.abort(), 200);
		try {
			expect((await first).reason).toContain("cancelled");
			expect((await second).reason).toContain("probe timed out");
		} finally {
			clearTimeout(timer);
		}
	}, 5000);

	it("the eval tool propagates a short cell deadline into real Python discovery", async () => {
		const fixture = await interpreter();
		const original = python.checkPythonKernelAvailability;
		vi.spyOn(python, "checkPythonKernelAvailability").mockImplementation((cwd, executable, options) =>
			original(cwd, executable, { ...options, forceProbe: true }),
		);
		const settings = Settings.isolated({ "eval.py": true, "python.interpreter": fixture.executable });
		const tool = new EvalTool(makeToolSession({ cwd: fixture.root, settings }));
		const started = Date.now();
		await expect(tool.execute("probe", { language: "py", code: "1", timeout: 1 })).rejects.toThrow(
			"Python backend is unavailable",
		);
		expect(Date.now() - started).toBeLessThan(4000);
		await expectReaped(fixture.pidFile);
	}, 6000);

	it("timeout zero lets a slow valid interpreter finish discovery and execute", async () => {
		const fixture = await interpreter();
		// Real startup latency must cross the one-second clamp on the old path.
		await fs.writeFile(
			fixture.executable,
			'#!/bin/sh\nif [ "$1" = "-c" ]; then\nexec python3 -c "import time; time.sleep(1.5)"\nfi\nexec python3 "$@"\n',
			{ mode: 0o755 },
		);
		const original = python.checkPythonKernelAvailability;
		vi.spyOn(python, "checkPythonKernelAvailability").mockImplementation((cwd, executable, options) =>
			original(cwd, executable, { ...options, forceProbe: true }),
		);
		const settings = Settings.isolated({ "eval.py": true, "python.interpreter": fixture.executable });
		const tool = new EvalTool(
			makeToolSession({
				cwd: fixture.root,
				settings,
				getEvalKernelOwnerId: () => fixture.root,
			}),
		);
		try {
			const result = await tool.execute("probe-zero", { language: "py", code: "print(42)", timeout: 0 });
			expect(result.isError).not.toBe(true);
			expect(result.content).toContainEqual(
				expect.objectContaining({
					type: "text",
					text: expect.stringContaining("42"),
				}),
			);
		} finally {
			await disposeKernelSessionsByOwner(fixture.root);
		}
	}, 15000);

	it("the eval tool reports discovery cancellation as an abort", async () => {
		const fixture = await interpreter();
		const original = python.checkPythonKernelAvailability;
		vi.spyOn(python, "checkPythonKernelAvailability").mockImplementation((cwd, executable, options) =>
			original(cwd, executable, { ...options, forceProbe: true }),
		);
		const settings = Settings.isolated({ "eval.py": true, "python.interpreter": fixture.executable });
		const tool = new EvalTool(makeToolSession({ cwd: fixture.root, settings }));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 300);
		try {
			await expect(
				tool.execute("probe", { language: "py", code: "1", timeout: 10 }, controller.signal),
			).rejects.toBeInstanceOf(ToolAbortError);
			await expectReaped(fixture.pidFile);
		} finally {
			clearTimeout(timer);
		}
	}, 5000);
});
