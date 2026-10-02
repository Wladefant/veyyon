// WHY: Path-scoped history must not include unrelated commits or exceed the requested bound.
// Real git verifies revision reachability, literal option-shaped paths, order, and the zero bound.
// This does not exercise remote history or cancellation of a hung git executable.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { revList } from "../src/utils/git";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

const makeDir = useTrackedTempDirs("veyyon-git-path-history-");

test("path history is bounded, newest first, and constrained to its revision", async () => {
	const cwd = makeDir();
	const git = (...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
	git("init", "-q", "-b", "main");
	git("config", "user.name", "test");
	git("config", "user.email", "test@example.invalid");
	git("config", "commit.gpgsign", "false");
	const commit = (file: string, contents: string): string => {
		writeFileSync(path.join(cwd, file), contents);
		git("add", "--", file);
		git("commit", "-qm", "fixture change");
		return git("rev-parse", "HEAD");
	};
	const first = commit("--tracked.txt", "first\n");
	commit("unrelated.txt", "unrelated\n");
	const second = commit("--tracked.txt", "second\n");
	const third = commit("--tracked.txt", "third\n");
	expect(await revList.touching(cwd, "HEAD", "--tracked.txt", 2)).toEqual([third, second]);
	expect(await revList.touching(cwd, second, "--tracked.txt", 10)).toEqual([second, first]);
	expect(await revList.touching(cwd, "HEAD", "--tracked.txt", 0)).toEqual([]);
	expect(await revList.touching(cwd, "HEAD", "absent.txt", 10)).toEqual([]);
});
