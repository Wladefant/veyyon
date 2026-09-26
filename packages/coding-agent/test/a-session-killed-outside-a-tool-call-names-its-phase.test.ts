/**
 * WHY. veyyon#73's fourth silent death had no tool call in flight. Main was
 * inside a provider turn, straight after a mid-run compaction, with eight lanes
 * streaming, and was ended below JavaScript. The in-flight marker covers only
 * the inside of a tool call, so the next launch had nothing to say: no exit
 * record, no `error` line, no marker.
 *
 * THE CLASS THIS CLOSES: an unrecorded death is detected whatever the session
 * was doing. The process keeps a heartbeat naming its phase (`provider`,
 * `tool`, `compaction`, `idle`) and its busy lanes, and the next launch turns a
 * heartbeat whose process is gone into `Previous session died silently`. The
 * arms are a death inside a provider turn with a lane streaming beside it, a
 * death inside a tool call, and a normal exit, which must not be reported.
 *
 * WHAT IT DOES NOT CATCH. The `compaction` phase is read from the same
 * `isCompacting` the UI shows and is not driven end to end here: compaction has
 * no seam to hold it open without a real summarising provider. A heartbeat is
 * written asynchronously, so a death in the instant between a phase change and
 * its write reports the phase before it; `heartbeatAt` says how old that was.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { HEARTBEAT_INTERVAL_MS, type SessionHeartbeat } from "@veyyon/utils/session-heartbeat";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const FIXTURE = path.resolve(import.meta.dir, "fixtures/session-with-tool-call-in-flight.ts");
const SILENT_MESSAGE = "Previous session died silently";

interface LogEntry {
	level: string;
	message: string;
	pid?: number;
	sessionId?: string;
	phase?: string;
	startedAt?: string;
	heartbeatAt?: string;
	activeLanes?: number;
	lanes?: number;
}

interface Arena {
	/** Config root the child resolves its profile, log and heartbeat under. */
	root: string;
	env: Record<string, string | undefined>;
	dispose: () => void;
}

const arenas: Arena[] = [];

/** A config root the spawned children share and nothing else can see; see the tool-call suite. */
function createArena(): Arena {
	const temp = TempDir.createSync("veyyon-heartbeat-");
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

function logsDir(arena: Arena): string {
	return path.join(arena.root, "profiles", "default", "logs");
}

function heartbeatDir(arena: Arena): string {
	return path.join(logsDir(arena), "heartbeat");
}

function silentDeaths(arena: Arena): LogEntry[] {
	if (!fs.existsSync(logsDir(arena))) return [];
	return fs
		.readdirSync(logsDir(arena))
		.filter(name => name.endsWith(".log"))
		.flatMap(name => fs.readFileSync(path.join(logsDir(arena), name), "utf8").split("\n"))
		.filter(line => line.trim().length > 0)
		.map(line => JSON.parse(line) as LogEntry)
		.filter(entry => entry.message === SILENT_MESSAGE);
}

/**
 * Heartbeats on disk. An `exited` tombstone is not one: a short-lived `report`
 * run can leave its own when it exits mid-write, and the next launch drops it.
 */
function heartbeatFiles(arena: Arena): string[] {
	return fs.existsSync(heartbeatDir(arena))
		? fs
				.readdirSync(heartbeatDir(arena))
				.filter(name => name.endsWith(".json"))
				.sort()
		: [];
}

function readHeartbeat(arena: Arena, pid: number): SessionHeartbeat {
	return JSON.parse(fs.readFileSync(path.join(heartbeatDir(arena), `${pid}.json`), "utf8")) as SessionHeartbeat;
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
 * Start the fixture, wait until its heartbeat shows the phase the arm reaches,
 * run `whileAlive`, then end it the way a crash does: no JavaScript on the way out.
 */
async function killFixtureAtReady(
	arena: Arena,
	mode: string,
	whileAlive?: (pid: number) => Promise<void>,
): Promise<{ pid: number; sessionId: string }> {
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
	try {
		await whileAlive?.(pid);
	} finally {
		await reader.cancel();
		// SIGKILL on POSIX, TerminateProcess on Windows.
		proc.kill("SIGKILL");
		await proc.exited;
	}
	return { pid, sessionId };
}

afterEach(() => {
	for (const arena of arenas.splice(0)) arena.dispose();
});

describe("a session that died below JavaScript", () => {
	it("is named with its provider phase and busy lanes on the next launch", async () => {
		const arena = createArena();
		const { pid, sessionId } = await killFixtureAtReady(arena, "provider", async livePid => {
			// A live process is left alone, however many launches look at it.
			await runFixture(arena, "report");
			expect(silentDeaths(arena)).toEqual([]);
			expect(heartbeatFiles(arena)).toContain(`${livePid}.json`);
			// Rewritten while nothing changes phase, so a hang is told from a death.
			// Real time on purpose: the interval runs in another process, whose clock
			// fake timers cannot reach, and the file is the only signal it gives.
			const first = Date.parse(readHeartbeat(arena, livePid).heartbeatAt);
			const deadline = Date.now() + HEARTBEAT_INTERVAL_MS * 2 + 2_000;
			while (Date.parse(readHeartbeat(arena, livePid).heartbeatAt) === first) {
				if (Date.now() > deadline) throw new Error("heartbeat was not rewritten while idle in its phase");
				await Bun.sleep(100);
			}
		});

		const beat = readHeartbeat(arena, pid);
		expect(beat.phase).toBe("provider");

		await runFixture(arena, "report");

		const reported = silentDeaths(arena);
		expect(reported).toHaveLength(1);
		expect(reported[0].level).toBe("error");
		expect(reported[0].pid).toBe(pid);
		expect(reported[0].sessionId).toBe(sessionId);
		expect(reported[0].phase).toBe("provider");
		// The spawned lane streaming beside Main, as in the incident.
		expect(reported[0].lanes).toBe(1);
		expect(reported[0].activeLanes).toBe(1);
		expect(Date.parse(reported[0].startedAt ?? "")).toBeGreaterThan(0);
		expect(Date.parse(reported[0].heartbeatAt ?? "")).toBeGreaterThanOrEqual(Date.parse(reported[0].startedAt ?? ""));
		// Swept, so the same death is not re-reported on every later launch.
		expect(heartbeatFiles(arena)).toEqual([]);
		await runFixture(arena, "report");
		expect(silentDeaths(arena)).toHaveLength(1);
	}, 60_000);

	it("is named with its tool phase when it died inside a call", async () => {
		const arena = createArena();
		const { pid, sessionId } = await killFixtureAtReady(arena, "abandon");

		await runFixture(arena, "report");

		const reported = silentDeaths(arena);
		expect(reported).toHaveLength(1);
		expect(reported[0]).toMatchObject({ level: "error", pid, sessionId, phase: "tool", lanes: 0, activeLanes: 0 });
	}, 60_000);

	it("is not reported when the session exited through JavaScript", async () => {
		const arena = createArena();
		expect(await runFixture(arena, "clean-exit")).toContain("done");
		await runFixture(arena, "report");
		expect(silentDeaths(arena)).toEqual([]);
		expect(heartbeatFiles(arena)).toEqual([]);
	}, 60_000);

	it("is not reported when its exit tombstone shows the last rewrite landed after the exit", async () => {
		const arena = createArena();
		const { pid } = await killFixtureAtReady(arena, "provider");
		// What a session leaves when it exits while a rewrite is on its way and the
		// process ends before the rewrite's own cleanup runs.
		fs.writeFileSync(path.join(heartbeatDir(arena), `${pid}.exited`), "");

		await runFixture(arena, "report");

		expect(silentDeaths(arena)).toEqual([]);
		expect(heartbeatFiles(arena)).toEqual([]);
		expect(fs.existsSync(path.join(heartbeatDir(arena), `${pid}.exited`))).toBe(false);
	}, 60_000);
});
