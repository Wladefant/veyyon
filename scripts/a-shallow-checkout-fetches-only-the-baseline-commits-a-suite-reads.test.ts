/**
 * WHY: CI checks out one commit deep, so a suite that reads an approved commit from the object store
 * finds it only after `bun scripts/git-baseline.ts --fetch`. The class is a baseline read a shallow
 * checkout cannot satisfy: a commit missing from `BASELINE_COMMITS` is rejected before any reader
 * runs, a listed commit is fetched without the history behind it, a full checkout stays full, and a
 * repository that already holds the commit fetches nothing.
 *
 * Not covered: the fetch goes to a local `file://` origin, so a server that rejects a fetch by commit
 * id, as a host with `uploadpack.allowReachableSHA1InWant` off would, is outside this suite.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BASELINE_COMMITS, fetchBaselineCommits, readGitFileText, readGitTree } from "./git-baseline";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-baseline-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", ...args], {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function has(repo: string, commit: string): boolean {
	return spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repo }).status === 0;
}

const origin = path.join(root, "origin");
fs.mkdirSync(origin);
git(origin, "init", "-q");

function commitFile(name: string): string {
	fs.writeFileSync(path.join(origin, `${name}.txt`), name);
	git(origin, "add", `${name}.txt`);
	git(origin, "commit", "-q", "-m", name);
	return git(origin, "rev-parse", "HEAD");
}

// base <- baseline <- tip: the baseline commit has history behind it and a commit after it.
const base = commitFile("base");
const baseline = commitFile("baseline");
commitFile("tip");

function clone(name: string, ...flags: string[]): string {
	const dir = path.join(root, name);
	git(root, "clone", "-q", ...flags, `file://${origin}`, dir);
	return dir;
}

describe("a shallow checkout fetches only the baseline commits a suite reads", () => {
	it("fetches a listed commit one deep, and fetches nothing once it is present", () => {
		const shallow = clone("shallow", "--depth=1");
		expect(has(shallow, baseline)).toBe(false);

		expect(fetchBaselineCommits(shallow, [baseline])).toEqual([baseline]);
		expect(git(shallow, "show", `${baseline}:baseline.txt`)).toBe("baseline");
		expect(has(shallow, base)).toBe(false);

		expect(fetchBaselineCommits(shallow, [baseline])).toEqual([]);
	});

	it("keeps a full checkout full when it fetches a commit it lacks", () => {
		const full = clone("full");
		const later = commitFile("later");
		expect(has(full, later)).toBe(false);

		expect(fetchBaselineCommits(full, [later])).toEqual([later]);
		expect(has(full, later)).toBe(true);
		expect(git(full, "rev-parse", "--is-shallow-repository")).toBe("false");
	});

	it("rejects a commit missing from BASELINE_COMMITS before reading it", () => {
		expect(() => readGitTree(baseline, origin)).toThrow(/is not listed in BASELINE_COMMITS/);
		expect(() => readGitFileText("baseline.txt", baseline, origin)).toThrow(/is not listed in BASELINE_COMMITS/);
	});

	it("names the fetch command when a listed commit is absent from a shallow checkout", () => {
		const shallow = clone("shallow-missing", "--depth=1");
		expect(() => readGitTree(BASELINE_COMMITS.oracleSnapshot, shallow)).toThrow(
			/run 'bun scripts\/git-baseline\.ts --fetch'/,
		);
	});

	it("exits 2 with the usage line on an unknown argument", () => {
		const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "git-baseline.ts"), "--fetch-all"], {
			encoding: "utf-8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toBe("Usage: bun scripts/git-baseline.ts --fetch\n");
	});
});
