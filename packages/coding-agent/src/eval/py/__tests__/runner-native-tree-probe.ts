import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Process } from "@veyyon/natives";

// Real Windows process-boundary proof. No package install, model, or shared kernel.
// The argument must name the native cache matching this source's 1.6.8 ABI.
assert.equal(process.platform, "win32");
const nativePath = process.argv[2];
assert.ok(nativePath, "pass the matching 1.6.8 native addon path");
const native: {
	Process: { fromPid(pid: number): Process | null };
	__veyyonNativesV1_7_4: () => unknown;
} = createRequire(import.meta.url)(nativePath);
assert.equal(typeof native.__veyyonNativesV1_7_4, "function");

// This OS integration needs a real termination deadline, not a simulated clock.
const runner = spawn("python", ["-u", fileURLToPath(new URL("../runner.py", import.meta.url))], {
	cwd: process.cwd(),
	windowsHide: true,
	stdio: ["pipe", "pipe", "pipe"],
	signal: AbortSignal.timeout(60_000),
});
const exited = once(runner, "exit");
void exited.catch(() => {});
const lines = createInterface({ input: runner.stdout });
const stderr: string[] = [];
runner.stderr.on("data", chunk => stderr.push(String(chunk)));
const owned = new Map<number, Process>();
try {
	assert.ok(runner.pid);
	const root = native.Process.fromPid(runner.pid);
	assert.ok(root, "cannot pin the owned runner");
	owned.set(root.pid, root);
	runner.stdin.write(`${JSON.stringify({
		id: "owned-tree",
		code: "import subprocess, sys; child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], creationflags=subprocess.CREATE_NO_WINDOW); print(child.pid)",
	})}\n`);
	let childPid: number | undefined;
	for await (const line of lines) {
		const frame: { type: string; id?: string; data?: string; status?: string } = JSON.parse(line);
		if (frame.id !== "owned-tree") continue;
		if (frame.type === "stdout") childPid = Number(frame.data?.trim());
		if (frame.type === "done") {
			assert.equal(frame.status, "ok", stderr.join(""));
			break;
		}
	}
	assert.ok(childPid && Number.isSafeInteger(childPid));
	const child = native.Process.fromPid(childPid);
	assert.ok(child, "cannot pin the descendant our cell created");
	owned.set(child.pid, child);
	const discovered = root.children();
	assert.ok(discovered.some(process => process.pid === childPid), "native tree walk missed the owned descendant");
	for (const process of discovered) owned.set(process.pid, process);

	root.killTree();
	const confirmed = await Promise.all([...owned.values()].map(process => process.waitForExit({ timeoutMs: 2000 })));
	assert.ok(confirmed.every(Boolean), "an owned process survived native tree termination");
	await exited;
	process.stdout.write(`${JSON.stringify({ ownerPid: process.pid, runnerPid: root.pid, descendantPid: child.pid, observed: owned.size, confirmed, after: 0 })}\n`);
} finally {
	lines.close();
	for (const process of owned.values()) process.killTree();
	if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
	await exited.catch(() => {});
}
