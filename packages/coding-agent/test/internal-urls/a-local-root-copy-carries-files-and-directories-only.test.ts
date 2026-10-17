/**
 * Subject: `internal-urls/local-protocol.ts` `copyLocalRoot`, the copy that carries a planning
 * session's `local://` files into the fresh session a plan is approved into.
 *
 * Contract: directories and regular files arrive with their bytes at any depth; symbolic links do
 * not; a source root that is missing or is not a directory copies nothing and creates no
 * destination; any other failure to read the source root is raised, not swallowed.
 *
 * NOT CAUGHT: a destination that already holds files the source does not, which the copy leaves in
 * place and no caller depends on either way.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { copyLocalRoot } from "@veyyon/coding-agent/internal-urls/local-protocol";
import { TempDir } from "@veyyon/utils";

let tempDir: TempDir;
let source: string;
let destination: string;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-local-root-copy-");
	source = path.join(tempDir.path(), "source");
	destination = path.join(tempDir.path(), "destination");
});

afterEach(() => {
	tempDir.removeSync();
});

async function exists(target: string): Promise<boolean> {
	return fs.lstat(target).then(
		() => true,
		() => false,
	);
}

describe("a local root that is a directory", () => {
	it("arrives with every file and directory at every depth", async () => {
		await fs.mkdir(path.join(source, "handoff", "nested"), { recursive: true });
		await fs.mkdir(path.join(source, "empty"), { recursive: true });
		await fs.writeFile(path.join(source, "plan.md"), "# Plan\n");
		await fs.writeFile(path.join(source, "handoff", "nested", "context.txt"), "pre-approval handoff");

		await copyLocalRoot(source, destination);

		expect(await fs.readFile(path.join(destination, "plan.md"), "utf8")).toBe("# Plan\n");
		expect(await fs.readFile(path.join(destination, "handoff", "nested", "context.txt"), "utf8")).toBe(
			"pre-approval handoff",
		);
		expect((await fs.readdir(path.join(destination, "empty"))).length).toBe(0);
		expect((await fs.readdir(destination)).toSorted()).toEqual(["empty", "handoff", "plan.md"]);
	});

	it("leaves a symbolic link behind", async () => {
		await fs.mkdir(source, { recursive: true });
		const outside = path.join(tempDir.path(), "outside.txt");
		await fs.writeFile(outside, "outside the local root");
		await fs.symlink(outside, path.join(source, "link.txt"));
		await fs.writeFile(path.join(source, "kept.txt"), "kept");

		await copyLocalRoot(source, destination);

		expect(await fs.readdir(destination)).toEqual(["kept.txt"]);
	});
});

describe("a local root that is not a directory", () => {
	it("copies nothing when the root is missing", async () => {
		await copyLocalRoot(source, destination);

		expect(await exists(destination)).toBe(false);
	});

	it("copies nothing when the root is a file", async () => {
		await fs.writeFile(source, "not a directory");

		await copyLocalRoot(source, destination);

		expect(await exists(destination)).toBe(false);
	});

	it("raises a failure to read the root that is not a missing root", async () => {
		await fs.writeFile(source, "not a directory");

		await expect(copyLocalRoot(path.join(source, "child"), destination)).rejects.toMatchObject({ code: "ENOTDIR" });
		expect(await exists(destination)).toBe(false);
	});
});
