/**
 * WHY THIS SUITE EXISTS.
 *
 * A skill approval must cover every readable file, including dependency and metadata
 * directories. This suite checks that all contents affect the digest and its bounds.
 * It also checks exact depth acceptance and rejects files that grow or shrink between
 * scanning and reading. Restoring a directory exclusion or ignoring changed sizes
 * must break these tests.
 *
 * A refused scan must reach operators: project skill loading logs a warning, and `veyyon trust`
 * lists the candidate as unreadable even though the bounded scanner returns `null`.
 *
 * Gaps: the suite does not test CLI argument parsing or the slash-command registry.
 * It does not measure scan cost or detect same-size edits during a read.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runTrustCommand } from "@veyyon/coding-agent/cli/trust-cli";
import { describeProjectSkill, PROJECT_SKILL_LIMITS } from "@veyyon/coding-agent/config/project-skill-trust";
import { loadProjectSkills } from "@veyyon/coding-agent/discovery/project-skills";
import { logger } from "@veyyon/utils";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirFactory();
afterEach(() => { mockOpen?.mockRestore(); });
let mockOpen: { mockRestore(): void } | undefined;

interface Fixture {
	root: string;
	skillDir: string;
	agentDir: string;
	home: string;
}

async function makeFixture(): Promise<Fixture> {
	const root = await fs.realpath(makeTempDir("veyyon-skill-bounds-"));
	const skillDir = path.join(root, ".agents", "skills", "bounded");
	const agentDir = path.join(root, "profile", "agent");
	const home = path.join(root, "home");
	await Promise.all([
		fs.mkdir(skillDir, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(home, { recursive: true }),
	]);
	await fs.writeFile(path.join(skillDir, "SKILL.md"), "---\nname: bounded\n---\nbody\n");
	return { root, skillDir, agentDir, home };
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
	test("a refused scan is logged by skill discovery and listed as unreadable by trust", async () => {
		const fixture = await makeFixture();
		await writeFiles(path.join(fixture.skillDir, "assets"), PROJECT_SKILL_LIMITS.maxFiles);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await loadProjectSkills({
				cwd: fixture.root,
				home: fixture.home,
				repoRoot: fixture.root,
				agentDir: fixture.agentDir,
			});
			const listed = await runTrustCommand({
				cwd: fixture.root,
				agentDir: fixture.agentDir,
				action: "list",
				paths: [],
			});
			const skillPath = path.join(fixture.skillDir, "SKILL.md");
			const relativePath = path.relative(fixture.root, skillPath).split(path.sep).join("/");
			const message = `project-skills: ${relativePath} was not loaded because the skill folder is unsafe or unreadable.`;

			expect(result.warnings).toContain(message);
			expect(warning).toHaveBeenCalledWith(message, { path: skillPath, relativePath });
			expect(listed.unreadable).toContain(skillPath);
		} finally {
			warning.mockRestore();
		}
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

	test("a directory exactly at the depth bound still describes the folder", async () => {
		const fixture = await makeFixture();
		const deepest = path.join(fixture.skillDir, ...Array<string>(PROJECT_SKILL_LIMITS.maxDepth).fill("d"));
		await fs.mkdir(deepest, { recursive: true });
		await fs.writeFile(path.join(deepest, "leaf.txt"), "leaf");
		expect(await describeProjectSkill(fixture.skillDir, fixture.root)).not.toBeNull();
	});

	for (const directory of ["node_modules", ".git"]) {
		test(`${directory} content changes revoke the folder digest`, async () => {
			const fixture = await makeFixture();
			const nested = path.join(fixture.skillDir, directory);
			await writeFiles(nested, 1);
			const before = await describeProjectSkill(fixture.skillDir, fixture.root);
			expect(before).not.toBeNull();
			await fs.writeFile(path.join(nested, "asset-0.bin"), "changed");
			const after = await describeProjectSkill(fixture.skillDir, fixture.root);
			expect(after).not.toBeNull();
			expect(after?.hash).not.toBe(before?.hash);
		});

		test(`${directory} files count toward the size bound`, async () => {
			const fixture = await makeFixture();
			await writeFiles(path.join(fixture.skillDir, directory), 1, PROJECT_SKILL_LIMITS.maxFileBytes + 1);
			expect(await describeProjectSkill(fixture.skillDir, fixture.root)).toBeNull();
		});
	}

	for (const [change, content] of [["shrinks", ""], ["grows", "longer content"]] as const) {
		test(`a file that ${change} after scanning refuses the folder`, async () => {
			const fixture = await makeFixture();
			const target = path.join(fixture.skillDir, "asset.txt");
			await fs.writeFile(target, "original");
			const canonicalTarget = await fs.realpath(target);
			const originalOpen = fs.open;
			let changed = false;
			mockOpen = spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
				if (file === canonicalTarget) {
					await fs.writeFile(target, content);
					changed = true;
				}
				return originalOpen(file, flags, mode);
			});
			expect(await describeProjectSkill(fixture.skillDir, fixture.root)).toBeNull();
			expect(changed).toBe(true);
		});
	}
});
