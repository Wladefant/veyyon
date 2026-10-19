/**
 * WHY THIS SUITE EXISTS.
 *
 * Every discovery pass and every `veyyon trust` hashes each project skill folder. Before
 * the bounds, a folder with a large asset or a `node_modules` tree was read whole into
 * memory, so one skill could stall or exhaust memory on each pass. This suite pins the
 * contract that replaced it: a folder over any bound is not trusted, and the scan skips
 * `node_modules` and `.git` directories.
 *
 * Mutations this suite is designed to catch:
 * - Remove any one of the four bounds: its over-limit fixture then describes as trusted.
 * - Off-by-one on a bound (`>=` vs `>`): the at-limit fixture then becomes untrusted.
 * - Scan `node_modules` or `.git` directories: the oversized file inside them then
 *   refuses the folder, and the digest moves when their content changes.
 *
 * Gaps: this drives the production describer on real temp folders. It does not drive
 * `veyyon trust` or discovery, and it does not measure scan cost at the bounds.
 * Skipped directories are not hashed, so a change inside `node_modules` does not revoke
 * trust. That is the documented trade-off, and the last test pins it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describeProjectSkill, PROJECT_SKILL_LIMITS } from "@veyyon/coding-agent/config/project-skill-trust";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirFactory();

interface Fixture {
	root: string;
	skillDir: string;
}

async function makeFixture(): Promise<Fixture> {
	const root = await fs.realpath(makeTempDir("veyyon-skill-bounds-"));
	const skillDir = path.join(root, ".agents", "skills", "bounded");
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: bounded\n---\nbody\n");
	return { root, skillDir };
}

async function writeFiles(dir: string, count: number, bytes = 0): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const body = Buffer.alloc(bytes, "a");
	for (let index = 0; index < count; index++) {
		await fs.writeFile(path.join(dir, `asset-${index}.bin`), body);
	}
}

describe("a skill folder over a bound is not trusted", () => {
	test("one file more than the file count bound refuses the folder", async () => {
		const fixture = await makeFixture();
		// SKILL.md already counts as one file.
		await writeFiles(path.join(fixture.skillDir, "assets"), PROJECT_SKILL_LIMITS.maxFiles);

		expect(await describeProjectSkill(fixture.skillDir, fixture.root)).toBeNull();
	});

	test("exactly the file count bound still describes the folder", async () => {
		const fixture = await makeFixture();
		await writeFiles(path.join(fixture.skillDir, "assets"), PROJECT_SKILL_LIMITS.maxFiles - 1);

		expect(await describeProjectSkill(fixture.skillDir, fixture.root)).not.toBeNull();
	});

	test("a file one byte over the per-file bound refuses the folder", async () => {
		const fixture = await makeFixture();
		await fs.writeFile(path.join(fixture.skillDir, "big.bin"), Buffer.alloc(PROJECT_SKILL_LIMITS.maxFileBytes + 1));

		expect(await describeProjectSkill(fixture.skillDir, fixture.root)).toBeNull();
	});

	test("files that together exceed the total bound refuse the folder", async () => {
		const fixture = await makeFixture();
		const fileCount = Math.ceil(PROJECT_SKILL_LIMITS.maxTotalBytes / PROJECT_SKILL_LIMITS.maxFileBytes) + 1;
		await writeFiles(path.join(fixture.skillDir, "assets"), fileCount, PROJECT_SKILL_LIMITS.maxFileBytes);

		expect(await describeProjectSkill(fixture.skillDir, fixture.root)).toBeNull();
	});

	test("a directory nested one level past the depth bound refuses the folder", async () => {
		const fixture = await makeFixture();
		let deepest = fixture.skillDir;
		for (let level = 0; level <= PROJECT_SKILL_LIMITS.maxDepth; level++) {
			deepest = path.join(deepest, "d");
		}
		await fs.mkdir(deepest, { recursive: true });
		await fs.writeFile(path.join(deepest, "leaf.txt"), "leaf");

		expect(await describeProjectSkill(fixture.skillDir, fixture.root)).toBeNull();
	});

	test("node_modules and .git directories are not scanned, so their content does not count or revoke trust", async () => {
		const fixture = await makeFixture();
		await writeFiles(path.join(fixture.skillDir, "node_modules", "pkg"), PROJECT_SKILL_LIMITS.maxFiles + 8);
		await writeFiles(path.join(fixture.skillDir, ".git"), 1, PROJECT_SKILL_LIMITS.maxFileBytes + 1);

		const before = await describeProjectSkill(fixture.skillDir, fixture.root);
		expect(before).not.toBeNull();

		await fs.writeFile(path.join(fixture.skillDir, "node_modules", "pkg", "asset-0.bin"), "changed");
		const after = await describeProjectSkill(fixture.skillDir, fixture.root);
		expect(after?.hash).toBe(before?.hash);
	});
});
