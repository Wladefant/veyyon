import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDefault } from "@veyyon/coding-agent/config/settings";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * WHY. A hand-edited setting of the wrong kind or outside its declared values reads as another value,
 * and the session records a warning for it. Only the TUI drew those warnings, so `veyyon -p` and RPC
 * ran on the replaced value with nothing on stderr: `compaction.enabled: maybe` ran with compaction on
 * and `edit.mode: nonsense` ran in hashline mode, and the run gave no sign either line was ignored.
 *
 * CLASS CLOSED: every warning the session records for its settings reaches stderr in a mode without a
 * TUI, once, with the file to edit and the value the run uses instead.
 *
 * NOT CAUGHT: ACP, whose sessions are built per client request by its own factory.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");
const CONFIG = "~/.veyyon/profiles/default/agent/config.yml";

/** stderr of `veyyon -p hi` in a fresh HOME whose profile config is `config`. */
async function printRunStderr(config: string): Promise<string> {
	const { home, env, cleanup } = hermeticSpawnEnv();
	try {
		const agentDir = path.join(home, ".veyyon", "profiles", "default", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), config);
		const proc = Bun.spawn([process.execPath, cliEntry, "-p", "hi"], {
			env,
			cwd: home,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr] = await Promise.all([new Response(proc.stderr).text(), new Response(proc.stdout).text()]);
		await proc.exited;
		return stderr;
	} finally {
		cleanup();
	}
}

function settingsWarnings(stderr: string): string[] {
	return stderr.split("\n").filter(line => line.startsWith("warning: settings: "));
}

describe("a print run states a setting that reads as another value", () => {
	it("states each one with its file and the value the run uses", async () => {
		const stderr = await printRunStderr("compaction:\n  enabled: maybe\nretry:\n  maxDelayMs: soon\n");

		// One line per setting; their order is not a contract.
		expect(settingsWarnings(stderr).sort()).toEqual([
			`warning: settings: compaction.enabled: expected a boolean (true or false), found string ("maybe") in ${CONFIG}; it reads as ${JSON.stringify(getDefault("compaction.enabled"))}`,
			`warning: settings: retry.maxDelayMs: expected a finite number, found string ("soon") in ${CONFIG}; it reads as ${JSON.stringify(getDefault("retry.maxDelayMs"))}`,
		]);
	}, 60_000);

	it("states an enum value outside its declared values with the value the run uses", async () => {
		const stderr = await printRunStderr("edit:\n  mode: nonsense\n");

		const [warning, ...rest] = settingsWarnings(stderr);
		expect(rest).toEqual([]);
		expect(warning).toStartWith("warning: settings: edit.mode: expected one of ");
		expect(warning).toEndWith(
			`found "nonsense" in ${CONFIG}; it reads as ${JSON.stringify(getDefault("edit.mode"))}`,
		);
	}, 60_000);

	it("control: a config whose values all parse to their declared kinds states none", async () => {
		const stderr = await printRunStderr("compaction:\n  enabled: false\nedit:\n  mode: replace\n");

		expect(settingsWarnings(stderr)).toEqual([]);
	}, 60_000);
});
