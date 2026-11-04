import { expect, it } from "bun:test";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { assertNotTerminalOwned } from "../src/session/terminal-ownership";

it("uses one PowerShell process for a scan while checking every parent and record", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-acl-process-"));
	const directory = path.join(root, "run", "terminals");
	const originalSystemRoot = process.env.SystemRoot;
	process.env.SystemRoot = "C:\\Windows";
	const checked: string[] = [];
	let starts = 0;
	let closes = 0;
	const spawnProcess = ((_command, _args, options) => {
		starts++;
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill() {
				queueMicrotask(() => child.emit("close", null, "SIGTERM"));
				return true;
			},
		});
		child.once("close", () => closes++);
		if (options?.stdio === "pipe" || options?.stdio?.[0] === "pipe") {
			let input = "";
			child.stdin.on("data", (chunk: Buffer) => {
				input += chunk.toString("utf8");
				let end: number;
				while ((end = input.indexOf("\n")) !== -1) {
					const [id, encodedPath] = input.slice(0, end).split("\t");
					input = input.slice(end + 1);
					checked.push(Buffer.from(encodedPath, "base64").toString("utf8"));
					queueMicrotask(() => child.stdout.write(`${id}\tOK\n`));
				}
			});
			child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0, null)));
		} else {
			checked.push(String(options?.env?.VEYYON_OWNER_ONLY_ACL_PATH));
			queueMicrotask(() => {
				child.stdout.write("OK");
				child.emit("close", 0, null);
			});
		}
		return child as unknown as ChildProcessWithoutNullStreams;
	}) as typeof spawn;
	try {
		await fs.mkdir(directory, { recursive: true });
		for (const name of ["a", "b"]) {
			await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify({
				version: 1, pid: process.pid, sessionFile: path.join(root, `${name}.jsonl`),
			}));
		}
		await assertNotTerminalOwned(path.join(root, "wanted.jsonl"), root, {
			platform: "win32", windowsAcl: { spawn: spawnProcess },
		});
		expect(checked.filter(target => target !== directory).sort()).toEqual([
			path.join(directory, "a.json"), path.join(directory, "b.json"),
		]);
		expect(checked[0]).toBe(directory);
		expect(checked[2]).toBe(directory);
		expect(checked).toHaveLength(4);
		expect(starts).toBe(1);
		expect(closes).toBe(starts);
	} finally {
		if (originalSystemRoot === undefined) delete process.env.SystemRoot;
		else process.env.SystemRoot = originalSystemRoot;
		await fs.rm(root, { recursive: true, force: true });
	}
});
