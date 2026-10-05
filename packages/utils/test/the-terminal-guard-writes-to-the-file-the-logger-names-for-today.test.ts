import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils/temp";
import { DIR_OVERRIDE_ENV_KEYS, XDG_BASE_ENV_KEYS } from "../src/dir-env-keys";

/**
 * WHY. With no redirect path, the terminal guard appends intercepted output to today's log file.
 * It names that file from the C library's local time (`localtime_r`, `GetLocalTime`), not from a
 * `Date`, because a `Date`'s first local-time read builds the engine's ICU time zone cache on the
 * path to the first frame. The logger names the same file through a `Date`. The class closed here
 * is the guard naming a different day than the logger: a misread `struct tm` or `SYSTEMTIME` field,
 * a UTC read where a local one belongs, or the C library reading a zone the `Date` does not, which
 * happens when `process.env.TZ` is assigned at run time (Bun applies it to `Date` alone).
 *
 * Every zone below runs in its own process with that zone in the launch environment, and the
 * sweep always holds a zone whose local day differs from the UTC day at the moment it runs. The
 * run-time case assigns a zone 26 hours from the launch zone, so the two days always differ.
 *
 * NOT closed here: that the C library and ICU resolve an unusual `TZ` value (a POSIX rule string,
 * an unknown name) to the same offset; the zones swept are IANA names and `Etc/` offsets. The
 * explicit `tzset` call: glibc's `localtime_r` loads the zone on first use itself, and POSIX does
 * not require that of Darwin or musl, which this suite does not run on. A Windows process with
 * `TZ` set names its file through a `Date`, so the Windows `GetLocalTime` read is exercised only by
 * the case with `TZ` unset.
 */

const GUARD_MODULE = path.join(import.meta.dirname, "..", "src", "stderr-guard.ts");
const DIRS_MODULE = path.join(import.meta.dirname, "..", "src", "dirs.ts");
const LOG_FILE_MODULE = path.join(import.meta.dirname, "..", "src", "log-file.ts");

let temp: TempDir;

beforeAll(() => {
	temp = TempDir.createSync("@guard-log-day-");
});

afterAll(() => {
	temp.removeSync();
});

interface GuardReport {
	logsDir: string;
	/** Today's file as the logger names it, read before and after the guard ran. */
	expected: string[];
	/** Every file in the logs directory holding the marker line. */
	holding: string[];
}

/**
 * Runs the guard in a process whose launch zone is `launchTz` (`TZ` unset when undefined) and whose
 * `process.env.TZ` is assigned `runtimeTz` first when given, writes a marker through the routed
 * console, and reports where it landed.
 */
function runGuard(launchTz: string | undefined, runtimeTz?: string): GuardReport {
	const root = fs.mkdtempSync(path.join(temp.path(), "case-"));
	const probe = path.join(root, "probe.ts");
	fs.writeFileSync(
		probe,
		[
			`import * as fs from "node:fs";`,
			`import * as path from "node:path";`,
			`import { restoreTerminalStderr, suppressTerminalStderr } from ${JSON.stringify(GUARD_MODULE)};`,
			`import { getLogsDir } from ${JSON.stringify(DIRS_MODULE)};`,
			`import { logFileName } from ${JSON.stringify(LOG_FILE_MODULE)};`,
			runtimeTz === undefined ? "" : `process.env.TZ = ${JSON.stringify(runtimeTz)};`,
			`suppressTerminalStderr({ force: true });`,
			`console.log("guard-day-marker");`,
			`restoreTerminalStderr();`,
			// Read after the guard so the guard runs before anything initializes the engine's zone.
			`const expected = [logFileName()];`,
			`const logsDir = getLogsDir();`,
			`const holding = fs.readdirSync(logsDir).filter(name => fs.readFileSync(path.join(logsDir, name), "utf8").includes("guard-day-marker"));`,
			`expected.push(logFileName());`,
			`process.stdout.write(JSON.stringify({ logsDir, expected, holding }));`,
		].join("\n"),
	);
	const home = path.join(root, "home");
	fs.mkdirSync(home);
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home };
	for (const key of [...DIR_OVERRIDE_ENV_KEYS, ...XDG_BASE_ENV_KEYS, "VEYYON_PROFILE", "TZ"]) delete env[key];
	if (launchTz !== undefined) env.TZ = launchTz;
	const run = spawnSync(process.execPath, [probe], { env, encoding: "utf8" });
	expect(run.stderr).toBe("");
	expect(run.status).toBe(0);
	const report = JSON.parse(run.stdout) as GuardReport;
	// The probe resolved its logs directory under its own HOME, never the caller's.
	expect(report.logsDir.startsWith(home)).toBe(true);
	return report;
}

/** The marker landed in exactly one file, the one the logger names for today. */
function expectLoggersFile(report: GuardReport): void {
	expect(report.holding).toHaveLength(1);
	expect(report.expected).toContain(report.holding[0]);
}

/** UTC calendar day of `ms` shifted by `hours`, as `YYYY-MM-DD`. */
function dayAt(ms: number, hours: number): string {
	return new Date(ms + hours * 3_600_000).toISOString().slice(0, 10);
}

/** Launch zones with their offset from UTC in hours; none observes daylight saving time. */
const LAUNCH_ZONES: readonly [string, number][] = [
	["Etc/GMT+12", -12],
	["Etc/UTC", 0],
	["Etc/GMT-14", 14],
	["Pacific/Kiritimati", 14],
	["Asia/Kolkata", 5.5],
	["America/Phoenix", -7],
];

describe("the terminal guard's default target", () => {
	it("is the logger's file for today in every launch zone, including zones a day ahead of or behind UTC", () => {
		const now = Date.now();
		// The sweep holds a zone whose day is not UTC's, so a UTC read cannot pass it.
		expect(LAUNCH_ZONES.some(([, offset]) => dayAt(now, offset) !== dayAt(now, 0))).toBe(true);
		for (const [zone] of LAUNCH_ZONES) {
			expectLoggersFile(runGuard(zone));
		}
	});

	it("is the logger's file for today in the system zone when TZ is unset", () => {
		expectLoggersFile(runGuard(undefined));
	});

	it("follows a zone assigned to process.env.TZ at run time, which only Date sees", () => {
		// Launch and run-time zones 26 hours apart always fall on different days.
		const before = Date.now();
		const report = runGuard("Etc/GMT+12", "Etc/GMT-14");
		const after = Date.now();
		expectLoggersFile(report);
		expect([dayAt(before, 14), dayAt(after, 14)].some(day => report.holding[0]?.includes(day))).toBe(true);
	});
});
