/**
 * WHY: an async atomic write stages its bytes in `.<target>.<pid>.<n>.tmp` and renames that over
 * the target. A process that exited between the two (a SIGTERM to every window at once, a fatal
 * error, `process.exit`) left the staged file beside the target for good: its name holds a dead
 * pid, so no later writer reuses or removes it. Profile caches collected one per such exit
 * (`.launch-facts.json.<pid>.<n>.tmp`, `.first-frame.json.<pid>.<n>.tmp`).
 *
 * Class closed: every exported async writer, interrupted by every way the process ends through
 * `postmortem` or `process.exit`, at each stage a staged file exists in (its exclusive open issued
 * but not yet delivered, its bytes written), leaves no staged file and no partial target. Writers
 * and exit reasons are read from the modules at run time, so a new one fails here until it is
 * covered or opted out by name.
 *
 * Not caught: SIGKILL and power loss, which run no exit listener. An exit that lands on the rename,
 * or before an issued open has created its file, is not covered either.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as atomicWrite from "../src/atomic-write";
import { Reason } from "../src/postmortem";
import { TempDir } from "../src/temp";

const ATOMIC_URL = pathToFileURL(path.join(import.meta.dirname, "../src/atomic-write.ts")).href;
const POSTMORTEM_URL = pathToFileURL(path.join(import.meta.dirname, "../src/postmortem.ts")).href;

/**
 * Child process: starts one write, holds it at `stage`, then ends the process the way `exit`
 * names. Prints `MID-WRITE` when a staged file exists at that moment, so a write that finished, or
 * one that had not staged anything yet, cannot pass as one the exit interrupted.
 *
 * `node:fs/promises` is patched through `require` before either module is imported: a module's
 * namespace import binds the functions present when it is first created.
 */
const PROBE = `
import { createRequire } from "node:module";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const [writer, exit, stage, target] = process.argv.slice(2);

const hold = new Promise(() => {});
setInterval(() => {}, 60_000);

function endProcess() {
	const staged = fs.readdirSync(path.dirname(target)).some(name => name.endsWith(".tmp"));
	process.stdout.write(staged ? "MID-WRITE\\n" : "NOT-STAGED\\n");
	switch (exit) {
		case "exit": process.exit(0);
		case "uncaught_exception": setTimeout(() => { throw new Error("probe fatal"); }); return;
		case "unhandled_rejection": void Promise.reject(new Error("probe rejection")); return;
		default: process.kill(process.pid, exit.toUpperCase());
	}
}

// "open": the exclusive open of the staged name is issued and the file exists, but the writer never
// receives the handle.
const realOpen = fsp.open;
fsp.open = function (file, flags, mode) {
	if (stage !== "open" || flags !== "wx" || !String(file).endsWith(".tmp")) return realOpen(file, flags, mode);
	void realOpen(file, flags, mode);
	const deadline = Date.now() + 5_000;
	while (!fs.existsSync(file) && Date.now() < deadline) {}
	endProcess();
	return hold;
};

// "write": every handle writer stages through FileHandle.writeFile; hold it after the bytes land.
const self = await fsp.open(process.argv[1], "r");
const proto = Object.getPrototypeOf(self);
await self.close();
const realWriteFile = proto.writeFile;
proto.writeFile = async function (...args) {
	await realWriteFile.apply(this, args);
	if (stage !== "write") return;
	endProcess();
	return hold;
};

await import(${JSON.stringify(POSTMORTEM_URL)});
const aw = await import(${JSON.stringify(ATOMIC_URL)});
const writes = {
	atomicWriteFile: () => aw.atomicWriteFile(target, "payload", { fsync: false }),
	atomicWriteJson: () => aw.atomicWriteJson(target, { payload: true }, { fsync: false }),
	atomicWriteFilePreservingMode: () => aw.atomicWriteFilePreservingMode(target, "payload", { fsync: false }),
	atomicWriteFileWith: () =>
		aw.atomicWriteFileWith(target, async tmp => {
			await fs.promises.writeFile(tmp, "payload");
			if (stage !== "write") return;
			endProcess();
			await hold;
		}),
};
await writes[writer]();
process.stdout.write("WRITE-FINISHED\\n");
`;

/** Where a write is when the exit lands. */
const STAGES = ["open", "write"] as const;

/** Writers that cannot be interrupted mid-write: a synchronous write runs no exit listener before it returns. */
const SYNCHRONOUS_WRITERS = ["atomicWriteFileSync"];

/** Reasons no process exit produces: `postmortem` raises neither from a signal, an error or `exit`. */
const NOT_PROCESS_EXITS = [Reason.PRE_EXIT, Reason.MANUAL];

/** The exit code `postmortem` (or `process.exit`) ends the probe with, per reason. */
const EXIT_CODE: Partial<Record<Reason, number>> = {
	[Reason.EXIT]: 0,
	[Reason.SIGINT]: 130,
	[Reason.SIGTERM]: 143,
	[Reason.SIGHUP]: 129,
	[Reason.UNCAUGHT_EXCEPTION]: 1,
	[Reason.UNHANDLED_REJECTION]: 1,
};

const exportedWriters = Object.entries(atomicWrite)
	.filter(([, value]) => typeof value === "function")
	.map(([name]) => name)
	.sort();
const asyncWriters = exportedWriters.filter(name => !SYNCHRONOUS_WRITERS.includes(name));
const exits = Object.values(Reason).filter(reason => !NOT_PROCESS_EXITS.includes(reason));

interface ProbeRun {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	entries: string[];
}

let root: TempDir;
let probePath: string;

beforeAll(async () => {
	root = await TempDir.create("@veyyon-exit-mid-write-");
	probePath = path.join(root.path(), "probe.ts");
	await fsp.writeFile(probePath, PROBE);
});

afterAll(async () => {
	await root.remove();
});

async function runProbe(writer: string, exit: Reason, stage: string): Promise<ProbeRun> {
	const outDir = path.join(root.path(), `${writer}-${exit}-${stage}`);
	await fsp.mkdir(outDir);
	const child = spawn(process.execPath, [probePath, writer, exit, stage, path.join(outDir, "state.json")], {
		cwd: root.path(),
		env: { ...process.env, VEYYON_CODING_AGENT_DIR: path.join(root.path(), "agent") },
		stdio: ["ignore", "pipe", "ignore"],
	});
	let stdout = "";
	child.stdout.setEncoding("utf8").on("data", chunk => {
		stdout += chunk;
	});
	// A probe whose exit never runs would hold forever; the watchdog bounds it and shows as a signal.
	const watchdog = setTimeout(() => child.kill("SIGKILL"), 10_000);
	const ended = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
	child.on("close", (code, signal) => ended.resolve({ code, signal }));
	const { code, signal } = await ended.promise;
	clearTimeout(watchdog);
	return { code, signal, stdout, entries: fs.readdirSync(outDir).sort() };
}

describe("a process that exits mid-write", () => {
	it("covers every exported writer and every process exit reason", () => {
		expect(exportedWriters.filter(name => SYNCHRONOUS_WRITERS.includes(name))).toEqual(SYNCHRONOUS_WRITERS);
		expect(asyncWriters).toEqual([
			"atomicWriteFile",
			"atomicWriteFilePreservingMode",
			"atomicWriteFileWith",
			"atomicWriteJson",
		]);
		expect(exits.filter(reason => EXIT_CODE[reason] === undefined)).toEqual([]);
	});

	it("leaves neither a staged file nor a target, for every writer, exit and stage", async () => {
		const cases = asyncWriters.flatMap(writer =>
			exits.flatMap(exit => STAGES.map(stage => ({ name: `${writer} / ${exit} / ${stage}`, writer, exit, stage }))),
		);
		const runs = await Promise.all(cases.map(({ writer, exit, stage }) => runProbe(writer, exit, stage)));
		const outcomes = cases.map(({ name }, index) => {
			const run = runs[index];
			return {
				case: name,
				code: run.code,
				signal: run.signal,
				interrupted: run.stdout === "MID-WRITE\n",
				entries: run.entries,
			};
		});
		expect(outcomes).toEqual(
			cases.map(({ name, exit }) => ({
				case: name,
				code: EXIT_CODE[exit] ?? null,
				signal: null,
				interrupted: true,
				entries: [],
			})),
		);
	}, 60_000);

	it("installs one exit listener however many writes it makes", async () => {
		const dir = path.join(root.path(), "listener");
		const before = process.listenerCount("exit");
		for (let index = 0; index < 20; index++) {
			await atomicWrite.atomicWriteFile(path.join(dir, `file-${index}.json`), "{}", { fsync: false });
		}
		expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
		expect(fs.readdirSync(dir).sort()).toEqual(Array.from({ length: 20 }, (_, index) => `file-${index}.json`).sort());
	});
});
