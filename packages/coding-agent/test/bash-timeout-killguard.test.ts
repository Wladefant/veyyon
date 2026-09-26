import { expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

useIsolatedGlobalSettings();
const tempDir = useTrackedTempDirs("bash-timeout-killguard-");

it("bash timeout kills its sleeping child without killing the host", async () => {
	// Native deadlines and OS process exit use the real platform clock; fake JS
	// timers cannot exercise the cancellation bridge or prove the child was reaped.
	const dir = tempDir();
	const pidFile = path.join(dir, "child.pid");
	const script = path.join(dir, "sleeper.js");
	await writeFile(
		script,
		`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`,
	);
	const hostPid = process.pid;
	const tool = new BashTool(makeToolSession({ cwd: dir }));
	let failure: unknown;
	try {
		await tool.execute("killguard-timeout", {
			command: `node "${script.replaceAll("\\", "/")}"`,
			timeout: 2,
			backgroundAfter: 30,
		});
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toContain("timed out");
	const childPid = Number(await readFile(pidFile, "utf8"));
	expect(childPid).toBeGreaterThan(0);
	expect(childPid).not.toBe(hostPid);
	let alive = true;
	for (let attempt = 0; attempt < 100 && alive; attempt++) {
		try {
			process.kill(childPid, 0);
		} catch {
			alive = false;
		}
		if (alive) await delay(50);
	}
	expect(alive).toBe(false);
	expect(process.pid).toBe(hostPid);
}, 15000);
