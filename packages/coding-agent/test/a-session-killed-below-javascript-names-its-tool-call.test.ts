/**
 * WHY. A session that died three times in twenty minutes left no account of any
 * of it (veyyon#73): no `Session exit recorded` line, no `error` line, no crash
 * report. `#recordSessionExit` runs from the postmortem handler table, which
 * covers every exit that reaches JavaScript and none that does not, so a
 * process terminated below the runtime — `TerminateProcess`, a native abort, an
 * OOM kill — simply stopped mid-log, and the next launch had no way to say what
 * it had been doing.
 *
 * THE CLASS THIS CLOSES: an unrecorded death is unattributed. Whatever kills the
 * process, the tool call it was inside is named in the day's log on the next
 * launch. The three arms are the three ways a process can reach its end while a
 * call has been started — killed inside the call, killed after it returned, and
 * exited normally — and only the first is a crash.
 *
 * WHAT IT DOES NOT CATCH. It does not prove WHICH kills are survivable: a kill
 * that also takes the filesystem write (a disk full at exactly the wrong moment)
 * leaves nothing, and nothing can. It does not exercise a native Bun panic,
 * because inducing one deterministically means corrupting memory on purpose; the
 * marker is written before the call begins and is indifferent to how the process
 * then dies, which `SIGKILL`/`TerminateProcess` is enough to establish. The
 * native-trace half of the same acceptance criterion is proven separately, by
 * the stderr guard's own suite.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/session-with-tool-call-in-flight.ts");
const ABANDONED_MESSAGE = "Previous session died with a tool call in flight";

interface LogEntry {
	level: string;
	message: string;
	pid?: number;
	toolName?: string;
	toolCallId?: string;
	sessionId?: string;
	startedAt?: string;
}

interface Arena {
	/** Config root the child resolves its profile, log and markers under. */
	root: string;
	env: Record<string, string | undefined>;
	dispose: () => void;
}

const arenas: Arena[] = [];

/**
 * A config root the spawned children share and nothing else can see.
 *
 * `VEYYON_CONFIG_DIR` is joined onto the home, so the value has to be relative
 * and walk out of it — the same move `enterIsolatedConfigRoot` makes, for the
 * same reason: an absolute-looking name lands the root inside the developer's
 * real home.
 */
function createArena(): Arena {
	const temp = TempDir.createSync("veyyon-inflight-marker-");
	const hermetic = hermeticSpawnEnv({
		VEYYON_CONFIG_DIR: path.relative(homedir(), temp.path()),
	});
	delete hermetic.env.VEYYON_PROFILE;
	const arena: Arena = {
		root: temp.path(),
		env: hermetic.env,
		dispose: () => {
			hermetic.cleanup();
			temp.removeSync();
		},
	};
	arenas.push(arena);
	return arena;
}

function logEntries(arena: Arena): LogEntry[] {
	const logsDir = path.join(arena.root, "profiles", "default", "logs");
	if (!fs.existsSync(logsDir)) return [];
	return fs
		.readdirSync(logsDir)
		.filter(name => name.endsWith(".log"))
		.flatMap(name => fs.readFileSync(path.join(logsDir, name), "utf8").split("\n"))
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as LogEntry);
}

function markerFiles(arena: Arena): string[] {
	const dir = path.join(arena.root, "profiles", "default", "logs", "inflight");
	return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

/** Run the fixture to completion and return its stdout. */
async function runFixture(arena: Arena, mode: string): Promise<string> {
	const proc = Bun.spawn([process.execPath, FIXTURE, mode, arena.root], {
		env: arena.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
		new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`fixture "${mode}" exited ${exitCode}: ${stderr}`);
	return stdout;
}

/**
 * Start the fixture, wait for it to reach the point the arm describes, then end
 * it the way a crash does: no signal handler, no cleanup, no exit record.
 */
async function killFixtureAtReady(arena: Arena, mode: string): Promise<{ pid: number; sessionId: string }> {
	const proc = Bun.spawn([process.execPath, FIXTURE, mode, arena.root], {
		env: arena.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	while (!buffered.includes("\n")) {
		const { done, value } = await reader.read();
		if (done) throw new Error(`fixture "${mode}" ended before it was ready: ${buffered}`);
		buffered += decoder.decode(value, { stream: true });
	}
	const [ready, sessionId] = buffered.split("\n")[0].split(" ");
	expect(ready).toBe("ready");
	const pid = proc.pid;
	await reader.cancel();
	// SIGKILL on POSIX, TerminateProcess on Windows: the death the report
	// describes, where no JavaScript runs on the way out.
	proc.kill("SIGKILL");
	await proc.exited;
	return { pid, sessionId };
}

afterEach(() => {
	for (const arena of arenas.splice(0)) arena.dispose();
});

it("keeps crash evidence when the recovery log cannot be written", async () => {
	const arena = createArena();
	await killFixtureAtReady(arena, "abandon");
	const now = new Date();
	const date = [
		now.getFullYear(),
		String(now.getMonth() + 1).padStart(2, "0"),
		String(now.getDate()).padStart(2, "0"),
	].join("-");
	const blockedLog = path.join(arena.root, "profiles", "default", "logs", `veyyon.${date}.log`);
	fs.rmSync(blockedLog, { force: true });
	fs.mkdirSync(blockedLog);
	await runFixture(arena, "report");
	expect(markerFiles(arena)).toHaveLength(1);
	fs.rmdirSync(blockedLog);
	await runFixture(arena, "report");
	expect(logEntries(arena).filter(entry => entry.message === ABANDONED_MESSAGE)).toHaveLength(1);
	expect(markerFiles(arena)).toEqual([]);
}, 60_000);

describe("a tool call that a dead process never finished", () => {
	it.each(["abandon", "concurrent"])(
		"names the unfinished call after %s in the next launch's log",
		async mode => {
			const arena = createArena();
			const { pid, sessionId } = await killFixtureAtReady(arena, mode);

			// The dead process left exactly one marker, and left it behind.
			expect(markerFiles(arena)).toEqual([`${pid}-746f6f6c755f696e666c69676874.json`]);
			expect(logEntries(arena).some(entry => entry.message === ABANDONED_MESSAGE)).toBe(false);

			await runFixture(arena, "report");

			const reported = logEntries(arena).filter(entry => entry.message === ABANDONED_MESSAGE);
			expect(reported).toHaveLength(1);
			expect(reported[0].level).toBe("error");
			expect(reported[0].toolName).toBe("bash");
			expect(reported[0].toolCallId).toBe("toolu_inflight");
			expect(reported[0].sessionId).toBe(sessionId);
			expect(reported[0].pid).toBe(pid);
			// Dated, so a reader can line the death up against the log around it.
			expect(Date.parse(reported[0].startedAt ?? "")).toBeGreaterThan(0);
			// Swept, so the same death is not re-reported on every later launch.
			expect(markerFiles(arena)).toEqual([]);
		},
		60_000,
	);

	it("is not reported when the call had already returned before the kill", async () => {
		const arena = createArena();
		await killFixtureAtReady(arena, "complete");

		expect(markerFiles(arena)).toEqual([]);
		await runFixture(arena, "report");
		expect(logEntries(arena).filter(entry => entry.message === ABANDONED_MESSAGE)).toEqual([]);
	}, 60_000);

	it("is not reported when the session exited normally mid-call", async () => {
		const arena = createArena();
		// Disposing inside the call is the ordinary shutdown the exit record
		// already accounts for. Reporting it as a crash would put a false death
		// in the log on every clean quit that happened to be mid-tool.
		expect(await runFixture(arena, "clean-exit")).toContain("done");

		expect(markerFiles(arena)).toEqual([]);
		await runFixture(arena, "report");
		expect(logEntries(arena).filter(entry => entry.message === ABANDONED_MESSAGE)).toEqual([]);
	}, 60_000);
});
