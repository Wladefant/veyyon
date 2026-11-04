/**
 * Measures whether console grandchildren of a spawn variant get their own console
 * (= a new conhost.exe = a visible window) on Windows.
 * Usage: bun packages/coding-agent/scripts/console-window-repro.ts
 * Each variant runs console-window-probe.py as the child; see that file for the metric.
 * `new_console` must be 0 for every variant a Veyyon code path uses.
 */
import * as path from "node:path";
import { detachedSpawnOptions, exec } from "../../utils/src/ptree";

const probe = path.join(import.meta.dir, "console-window-probe.py");

async function viaBun(options: Record<string, unknown>): Promise<string> {
	const child = Bun.spawn(["python", probe], { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...options });
	const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	return `${out.trim().split(/\r?\n/).pop() ?? ""}${err.trim() ? ` ERR: ${err.trim().slice(0, 200)}` : ""}`;
}

const variants: Array<[string, () => Promise<string>]> = [
	["raw Bun detached:true (old launch)", () => viaBun({ detached: true })],
	["raw Bun detached+windowsHide", () => viaBun({ detached: true, windowsHide: true })],
	["raw Bun windowsHide:true", () => viaBun({ windowsHide: true })],
	["Bun + detachedSpawnOptions()", () => viaBun(detachedSpawnOptions())],
	[
		"ptree.exec detached:true",
		async () => (await exec(["python", probe], { detached: true })).stdout.trim().split(/\r?\n/).pop() ?? "",
	],
];

for (const [name, run] of variants) {
	console.log(`${name.padEnd(38)} ${await run()}`);
}
