/**
 * WHY: git and gh ran through one reader that ends a child at its deadline and stops reading at
 * 8 MiB, while `jj` spawned its own child and read both pipes to the end with no deadline. A
 * `jj diff` that waited on a working-copy lock never returned, and a diff of any size was held in
 * memory whole. Every CLI in `CAPTURED_COMMANDS` now spawns through `git.runCommand`.
 *
 * The class: a CLI the agent runs whose output is not capped or whose run has no deadline. The
 * sweep reads `CAPTURED_COMMANDS` at run time and drives each command through the public entry
 * point that runs it, against a stub of that command on PATH: the cap is the witness that the
 * entry point spawns through the shared runner, since a private spawn returns every byte. A
 * command added to the list without an entry point here fails the type check and this suite.
 *
 * Not caught: a new spawn site that calls `Bun.spawn` for a CLI that is not in the list. The
 * deadline is driven through `runCommand` with a short `timeoutMs`, because no entry point takes
 * one and the default is five minutes.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "@veyyon/coding-agent/utils/git";
import * as jj from "@veyyon/coding-agent/utils/jj";
import * as which from "@veyyon/utils/which";

const OVERFLOW_BYTES = git.GIT_COMMAND_OUTPUT_LIMIT_BYTES + 1024 * 1024;

/** The public entry point that runs each command, returning the stdout it captured. */
const ENTRY_POINTS: Record<git.CapturedCommand, (cwd: string) => Promise<string>> = {
	git: cwd => git.diff(cwd),
	gh: async cwd => (await git.github.run(cwd, ["api", "user"], undefined, { trimOutput: false })).stdout,
	jj: cwd => jj.diff(cwd),
};

let stubDir = "";
let restorePath: (() => void) | undefined;

/** Replace the stub for `command` with a script that runs `source` in this Bun, which needs nothing on PATH. */
async function stub(command: git.CapturedCommand, source: string): Promise<void> {
	const file = path.join(stubDir, command);
	await fs.writeFile(file, `#!/bin/sh\nexec "${process.execPath}" -e '${source}'\n`);
	await fs.chmod(file, 0o755);
}

beforeAll(async () => {
	stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-captured-command-stubs-"));
});

afterAll(async () => {
	await fs.rm(stubDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	restorePath?.();
	restorePath = undefined;
});

/** Resolve every command to its stub: `$which` for the installed check, the live PATH for the spawn. */
function useStubs(): void {
	const original = process.env.PATH;
	restorePath = () => {
		if (original === undefined) delete process.env.PATH;
		else process.env.PATH = original;
	};
	process.env.PATH = original ? `${stubDir}${path.delimiter}${original}` : stubDir;
	vi.spyOn(which, "$which").mockImplementation(command => path.join(stubDir, command));
}

describe("a git, gh or jj run ends at its deadline and stops reading at the cap", () => {
	it("drives every captured command through an entry point", () => {
		expect(Object.keys(ENTRY_POINTS).sort()).toEqual([...git.CAPTURED_COMMANDS].sort());
	});

	for (const command of git.CAPTURED_COMMANDS) {
		describe(command, () => {
			it("keeps the first 8 MiB of stdout and appends the notice that names the command", async () => {
				await stub(command, `process.stdout.write("a".repeat(${OVERFLOW_BYTES}))`);
				useStubs();

				const stdout = await ENTRY_POINTS[command](stubDir);
				const notice = `\n${git.truncationNotice(command)}\n`;
				expect(stdout.length).toBe(git.GIT_COMMAND_OUTPUT_LIMIT_BYTES + notice.length);
				expect(stdout.endsWith(`a${notice}`)).toBe(true);
				expect(git.truncationNotice(command)).toBe(`[${command} subprocess output truncated after 8 MiB]`);
			});

			it("ends a run that outlives its deadline with exit code 124", async () => {
				await stub(command, "setTimeout(() => {}, 30000)");
				useStubs();

				const started = performance.now();
				const result = await git.runCommand(command, ["status"], stubDir, { timeoutMs: 200 });
				const elapsed = performance.now() - started;

				expect(result).toEqual({
					exitCode: 124,
					stdout: "",
					stderr: `${command} status timed out after 200ms`,
				});
				expect(elapsed).toBeLessThan(5_000);
			});
		});
	}
});
