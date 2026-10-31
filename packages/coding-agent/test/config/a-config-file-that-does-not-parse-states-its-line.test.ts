import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { unparseableSettingsNotice } from "@veyyon/coding-agent/config/settings";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * WHY. Bun's YAML parser states every syntax error as `YAML Parse error: Unexpected token`, and the
 * line and column it attaches are those of the JavaScript call site. A hand-edited config file with
 * one typo was therefore reported with no position: the profile settings notice stated only the
 * path, the global config and `--config` overlay errors ended in "Unexpected token", and
 * `models.yml` read "Unexpected error: YAML Parse error: Unexpected token". A print run stated a
 * profile settings file that did not parse nowhere at all, and ran on defaults for it.
 *
 * The class closed here is "a YAML config file a person edits that fails to parse, stated without
 * the line and column of the error". Each config surface whose load error reaches the operator is
 * driven through the real CLI with the same broken file, and each must state the parser's reason
 * with its position.
 *
 * Not caught: a new loader that parses its file with `Bun.YAML.parse` instead of `parseYaml` from
 * `@veyyon/utils/yaml-sync`, until a surface for it is added below. Loaders whose failure reaches
 * only the log (keybindings, WATCHDOG.yml discovery, harness profiles) are not driven here.
 */

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const cliEntry = path.join(repoRoot, "src", "cli.ts");

/** A value with a second colon, the most common hand-editing mistake in a YAML config file. */
const BROKEN = "theme: dark\nstatusLine: time: %H:%M\n";
const LOCATED = "Nested mappings are not allowed in compact mappings at line 2, column 13";

interface Run {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Spawn the CLI in a fresh HOME after `prepare` writes its files into that HOME. */
async function runCli(args: readonly string[], prepare: (home: string, agentDir: string) => void): Promise<Run> {
	const { home, env, cleanup } = hermeticSpawnEnv();
	try {
		const agentDir = path.join(home, ".veyyon", "profiles", "default", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		prepare(home, agentDir);
		const proc = Bun.spawn([process.execPath, cliEntry, ...args.map(arg => arg.replaceAll("<home>", home))], {
			env,
			cwd: home,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout: stdout.replaceAll(home, "<home>"), stderr: stderr.replaceAll(home, "<home>") };
	} finally {
		cleanup();
	}
}

const PROFILE_CONFIG = "<home>/.veyyon/profiles/default/agent/config.yml";

describe("a YAML config file that does not parse", () => {
	it("is stated by a print run as a profile settings file, with its line, its kept copy and its fix", async () => {
		const { stderr } = await runCli(["-p", "hi"], (_home, agentDir) => {
			fs.writeFileSync(path.join(agentDir, "config.yml"), BROKEN);
		});

		// The TUI draws the same builder's text, so the two channels cannot drift apart.
		const notice = unparseableSettingsNotice([
			{ path: PROFILE_CONFIG, quarantinePath: `${PROFILE_CONFIG}.corrupt`, reason: LOCATED },
		]);
		expect(stderr).toContain(`error: settings: ${notice}\n`);
		expect(stderr).toContain(`\n  ${PROFILE_CONFIG}: ${LOCATED}\n    original kept at ${PROFILE_CONFIG}.corrupt\n`);
		expect(stderr.split("Could not read your settings").length - 1).toBe(1);
	}, 60_000);

	it("control: a print run with a profile settings file that parses states no settings notice", async () => {
		const { stderr } = await runCli(["-p", "hi"], (_home, agentDir) => {
			fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: dark\n");
		});

		expect(stderr).not.toContain("Could not read your settings");
	}, 60_000);

	it("is stated with its line as the global config, and the run stops", async () => {
		const { code, stderr } = await runCli(["-p", "hi"], home => {
			fs.writeFileSync(path.join(home, ".veyyon", "config.yml"), `onboardingVersion: 99\n${BROKEN}`);
		});

		expect(code).not.toBe(0);
		expect(stderr).toContain(
			`Global config <home>/.veyyon/config.yml is not valid YAML: ${LOCATED.replace("line 2", "line 3")}.`,
		);
	}, 60_000);

	it("is stated with its line as a --config overlay, and the run stops", async () => {
		const { code, stderr } = await runCli(["-p", "--config", "<home>/overlay.yml", "hi"], home => {
			fs.writeFileSync(path.join(home, "overlay.yml"), BROKEN);
		});

		expect(code).not.toBe(0);
		expect(stderr).toContain(`Failed to parse config overlay <home>/overlay.yml: ${LOCATED}`);
	}, 60_000);

	it("is stated with its line as models.yml by `veyyon models`", async () => {
		const { stdout } = await runCli(["models"], (_home, agentDir) => {
			fs.writeFileSync(path.join(agentDir, "models.yml"), BROKEN);
		});

		expect(stdout).toContain(
			`Failed to load config file models (<home>/.veyyon/profiles/default/agent/models.yml), Parse error: ${LOCATED}`,
		);
	}, 60_000);
});
