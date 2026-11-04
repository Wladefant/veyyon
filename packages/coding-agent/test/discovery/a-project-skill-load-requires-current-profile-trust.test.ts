/**
 * WHY THIS SUITE EXISTS.
 *
 * This closes the class where project skill instructions or assets change after
 * an operator approves them, or a project skill loads without that approval.
 * Every decision goes through the real `runTrustCommand` and `ProjectTrust`
 * store, then the real skill capability provider and production `loadSkills`
 * pipeline. It uses isolated repo, profile, and home fixtures with a `.git`
 * root and a nested working directory.
 *
 * Mutations this suite is designed to catch:
 * - Return the skill before checking trust (`untrusted`); turn a recorded deny
 *   into allow (`denied`); ignore the current folder digest (`changed`); or
 *   trust every path after one approval (`unknown-file`).
 * - Hash only `SKILL.md`, omit nested paths, or exclude `.git`-named files: the
 *   SKILL.md and script edits, nested asset add/remove/rename, and .git-named
 *   nested file cases must change the verdict.
 * - Parse SKILL.md by re-reading from disk after trust evaluation instead of
 *   using the evaluated `ProjectSkillSnapshot.content`: a second read creates a
 *   read race where instructions can be swapped between hash check and parse.
 * - Depend on directory enumeration order rather than sorted paths: rebuilding
 *   the same path/byte set in reverse creation order must remain trusted.
 * - Use the nested cwd as the project key, or fail to hash an explicit SKILL.md
 *   path's folder: the nested-root and explicit-approval cases must fail.
 * - Skip real-path containment or ancestor cycle detection: out-of-root symlinks
 *   and symlink cycles back to an ancestor skill directory must reject approval
 *   and loading.
 * - Reverse project-root/provider priority, drop explicit agentDir/cwd, or bypass
 *   production `loadSkills` allowlist: trusted project skills must beat profile
 *   skills of the same name, untrusted skills must be omitted, and modified scripts
 *   must be refused on repeat calls without cache clears.
 * - Leak project trust approvals across profile agent directories: approvals
 *   must remain strictly isolated to the approving profile.
 *
 * Gaps: these tests call the production command function and loader pipeline,
 * not CLI argument parsing or the slash-command registry. They do not execute
 * skill scripts or claim runtime smoke or mutation evidence.
 */
import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runTrustCommand, type TrustCommandResult } from "@veyyon/coding-agent/cli/trust-cli";
import { loadCapability, reset as resetCapabilityCaches } from "@veyyon/coding-agent/discovery/capability";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/discovery/capability/fs";
import { type DiscoveredSkill, skillCapability } from "@veyyon/coding-agent/discovery/capability/skill";
import {
	PROJECT_SKILL_DIRECTORIES,
	PROVIDER_ID as PROJECT_SKILLS_PROVIDER,
	discoverProjectSkillPaths,
} from "@veyyon/coding-agent/discovery/project-skills";
import { loadSkills } from "@veyyon/coding-agent/extensibility/skills";
import "@veyyon/coding-agent/discovery";
import { useTrackedTempDirFactory } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirFactory();

interface Fixture {
	tempRoot: string;
	repoRoot: string;
	nestedCwd: string;
	agentDir: string;
	otherAgentDir: string;
	home: string;
}

async function makeFixture(): Promise<Fixture> {
	const tempRoot = makeTempDir("veyyon-project-skills-");
	const repoRoot = path.join(tempRoot, "repo");
	const nestedCwd = path.join(repoRoot, "packages", "workspace");
	const agentDir = path.join(tempRoot, "profiles", "work", "agent");
	const otherAgentDir = path.join(tempRoot, "profiles", "client", "agent");
	const home = path.join(tempRoot, "home");
	await Promise.all([
		fs.mkdir(path.join(repoRoot, ".git"), { recursive: true }),
		fs.mkdir(nestedCwd, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
		fs.mkdir(otherAgentDir, { recursive: true }),
		fs.mkdir(home, { recursive: true }),
	]);
	return { tempRoot, repoRoot, nestedCwd, agentDir, otherAgentDir, home };
}

afterAll(() => {
	resetCapabilityCaches();
});

async function writeSkill(skillRoot: string, name: string, body?: string): Promise<string> {
	const skillDir = path.join(skillRoot, name);
	const skillFile = path.join(skillDir, "SKILL.md");
	const skillBody = body ?? `Body for ${name}.`;
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(
		skillFile,
		`---\nname: ${name}\ndescription: Skill ${name}.\n---\n\n${skillBody}\n`,
	);
	return skillFile;
}

async function writeProjectSkill(fixture: Fixture, directory: string, name: string, body?: string): Promise<string> {
	return writeSkill(path.join(fixture.repoRoot, directory), name, body);
}

function relativeProjectPath(fixture: Fixture, absolutePath: string): string {
	return path.relative(fixture.repoRoot, absolutePath).split(path.sep).join("/");
}

async function decide(
	fixture: Fixture,
	action: "approve" | "deny" | "list",
	agentDir = fixture.agentDir,
	paths: readonly string[] = [],
) {
	return runTrustCommand({ cwd: fixture.nestedCwd, agentDir, action, paths });
}

async function loadProjectSkills(fixture: Fixture, agentDir = fixture.agentDir) {
	clearFsCache();
	return loadCapability<DiscoveredSkill>(skillCapability.id, {
		cwd: fixture.nestedCwd,
		home: fixture.home,
		agentDir,
		providers: [PROJECT_SKILLS_PROVIDER],
	});
}

async function loadScopedSkills(fixture: Fixture, providers: string[], agentDir = fixture.agentDir) {
	clearFsCache();
	return loadCapability<DiscoveredSkill>(skillCapability.id, {
		cwd: fixture.nestedCwd,
		home: fixture.home,
		agentDir,
		providers,
	});
}


function candidateFor(result: TrustCommandResult, relativePath: string) {
	return result.candidates.find(candidate => candidate.relativePath === relativePath);
}

async function expectChangedAndWithheld(fixture: Fixture, skillFile: string, name: string): Promise<void> {
	const relativePath = relativeProjectPath(fixture, skillFile);
	const listed = await decide(fixture, "list");
	const loaded = await loadProjectSkills(fixture);
	const candidate = candidateFor(listed, relativePath);
	expect(candidate?.verdict).toBe("changed");
	expect(loaded.items.map(skill => skill.name)).not.toContain(name);
	expect(loaded.warnings.join("\n")).toContain(relativePath);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function probeFileSymlinkSupport(): Promise<boolean> {
	const probeDir = makeTempDir("veyyon-project-skill-symlink-probe-");
	const target = path.join(probeDir, "target.txt");
	await fs.writeFile(target, "target\n");
	try {
		await fs.symlink(target, path.join(probeDir, "link.txt"), "file");
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP") return false;
		throw error;
	}
}

const fileSymlinksAvailable = await probeFileSymlinkSupport();

async function probeDirSymlinkSupport(): Promise<boolean> {
	const probeDir = makeTempDir("veyyon-project-skill-dir-symlink-probe-");
	const target = path.join(probeDir, "target");
	const link = path.join(probeDir, "link");
	await fs.mkdir(target, { recursive: true });
	try {
		await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP") return false;
		throw error;
	}
}

const dirSymlinksAvailable = await probeDirSymlinkSupport();
const symlinkTest = test.skipIf(!fileSymlinksAvailable);
const dirSymlinkTest = test.skipIf(!dirSymlinksAvailable);

test.skipIf(process.platform !== "win32")("a lowercase skill.md definition loads on Windows", async () => {
	const fixture = await makeFixture();
	const skillDir = path.join(fixture.repoRoot, PROJECT_SKILL_DIRECTORIES[0], "lowercase-definition");
	const skillFile = path.join(skillDir, "skill.md");
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(
		skillFile,
		"---\nname: lowercase-definition\ndescription: Lowercase definition.\n---\n\nLowercase body.\n",
	);

	const approved = await decide(fixture, "approve");
	const loaded = await loadProjectSkills(fixture);

	expect(approved.candidates.map(candidate => candidate.relativePath)).toEqual([
		relativeProjectPath(fixture, skillFile),
	]);
	expect(loaded.items.map(skill => skill.name)).toEqual(["lowercase-definition"]);
	expect(loaded.items[0]?.content).toContain("Lowercase body.");
});

test("project skill roots keep their declared order and enumerate each root", async () => {
	const fixture = await makeFixture();
	expect(PROJECT_SKILL_DIRECTORIES).toEqual([".agents/skills", ".github/skills", ".claude/skills"]);

	const expected: string[] = [];
	for (const [index, directory] of PROJECT_SKILL_DIRECTORIES.entries()) {
		expected.push(await writeProjectSkill(fixture, directory, `root-${index}`));
	}

	expect(await discoverProjectSkillPaths(fixture.repoRoot)).toEqual(expected);
});

test("an untrusted project skill is listed and withheld from a nested cwd", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "untrusted");
	const relativePath = relativeProjectPath(fixture, skillFile);

	const listed = await decide(fixture, "list");
	const loaded = await loadProjectSkills(fixture);

	expect(listed.projectRoot).toBe(await fs.realpath(fixture.repoRoot));
	expect(listed.candidates.map(candidate => candidate.relativePath)).toEqual([relativePath]);
	expect(candidateFor(listed, relativePath)?.verdict).toBe("untrusted");
	expect(loaded.items.map(skill => skill.name)).toEqual([]);
	expect(loaded.warnings.join("\n")).toContain(relativePath);
});

test("trust lists and approves a project skill before the capability loads it", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "approved");
	const relativePath = relativeProjectPath(fixture, skillFile);

	const listed = await decide(fixture, "list");
	const approved = await decide(fixture, "approve");
	const loaded = await loadProjectSkills(fixture);

	expect(listed.projectRoot).toBe(await fs.realpath(fixture.repoRoot));
	expect(listed.candidates.map(candidate => candidate.relativePath)).toEqual([relativePath]);
	expect(approved.projectRoot).toBe(listed.projectRoot);
	expect(candidateFor(approved, relativePath)?.verdict).toBe("trusted");
	expect(loaded.items.map(skill => skill.name)).toEqual(["approved"]);
	expect(loaded.items[0]?._source.path).toBe(skillFile);
});

test("editing SKILL.md after approval invalidates that skill", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "edited-instructions");
	await decide(fixture, "approve");
	await fs.writeFile(
		skillFile,
		"---\nname: edited-instructions\ndescription: Skill edited-instructions.\n---\n\nChanged instructions.\n",
	);

	await expectChangedAndWithheld(fixture, skillFile, "edited-instructions");
});

test("editing only a nested script after approval invalidates the skill folder", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "script-change");
	const script = path.join(path.dirname(skillFile), "scripts", "run.sh");
	await fs.mkdir(path.dirname(script), { recursive: true });
	await fs.writeFile(script, "printf 'before'\n");
	await decide(fixture, "approve");
	await fs.writeFile(script, "printf 'after'\n");

	await expectChangedAndWithheld(fixture, skillFile, "script-change");
});

test("adding a nested asset after approval invalidates the skill folder", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "added-asset");
	await decide(fixture, "approve");
	const asset = path.join(path.dirname(skillFile), "assets", "new.txt");
	await fs.mkdir(path.dirname(asset), { recursive: true });
	await fs.writeFile(asset, "new asset\n");

	await expectChangedAndWithheld(fixture, skillFile, "added-asset");
});

test("removing a nested asset after approval invalidates the skill folder", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "removed-asset");
	const asset = path.join(path.dirname(skillFile), "assets", "old.txt");
	await fs.mkdir(path.dirname(asset), { recursive: true });
	await fs.writeFile(asset, "old asset\n");
	await decide(fixture, "approve");
	await fs.unlink(asset);

	await expectChangedAndWithheld(fixture, skillFile, "removed-asset");
});

test("renaming a nested asset after approval invalidates the skill folder", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "renamed-asset");
	const original = path.join(path.dirname(skillFile), "assets", "before.txt");
	const renamed = path.join(path.dirname(skillFile), "assets", "after.txt");
	await fs.mkdir(path.dirname(original), { recursive: true });
	await fs.writeFile(original, "same bytes\n");
	await decide(fixture, "approve");
	await fs.rename(original, renamed);

	await expectChangedAndWithheld(fixture, skillFile, "renamed-asset");
});

test("editing a nested .git-named file after approval invalidates the skill folder", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "git-file-change");
	const gitFile = path.join(path.dirname(skillFile), ".git");
	await fs.writeFile(gitFile, "gitdir: ../../.git/modules/nested\n");
	await decide(fixture, "approve");
	await fs.writeFile(gitFile, "gitdir: ../../.git/modules/tampered\n");

	await expectChangedAndWithheld(fixture, skillFile, "git-file-change");
});

test("adding a nested .git-named file after approval invalidates the skill folder", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "added-git-file");
	await decide(fixture, "approve");
	const gitFile = path.join(path.dirname(skillFile), ".git");
	await fs.writeFile(gitFile, "gitdir: ../../.git/modules/added\n");

	await expectChangedAndWithheld(fixture, skillFile, "added-git-file");
});

test("recreating the same folder bytes in a different creation order keeps approval", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "stable-folder");
	const first = path.join(path.dirname(skillFile), "assets", "a.txt");
	const second = path.join(path.dirname(skillFile), "scripts", "b.sh");
	await fs.mkdir(path.dirname(first), { recursive: true });
	await fs.mkdir(path.dirname(second), { recursive: true });
	await fs.writeFile(first, "asset\n");
	await fs.writeFile(second, "script\n");
	await decide(fixture, "approve");

	const skillDir = path.dirname(skillFile);
	await fs.rm(path.join(skillDir, "assets"), { recursive: true });
	await fs.rm(path.join(skillDir, "scripts"), { recursive: true });
	await fs.mkdir(path.dirname(second), { recursive: true });
	await fs.writeFile(second, "script\n");
	await fs.mkdir(path.dirname(first), { recursive: true });
	await fs.writeFile(first, "asset\n");
	expect((await loadProjectSkills(fixture)).items.map(skill => skill.name)).toEqual(["stable-folder"]);
});

test("an explicit SKILL.md approval hashes nested files in its containing folder", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "explicit-file");
	const script = path.join(path.dirname(skillFile), "scripts", "run.sh");
	await fs.mkdir(path.dirname(script), { recursive: true });
	await fs.writeFile(script, "printf 'approved'\n");

	const approved = await decide(fixture, "approve", fixture.agentDir, [skillFile]);
	await fs.writeFile(script, "printf 'modified'\n");

	expect(approved.candidates.map(candidate => candidate.relativePath)).toEqual([
		relativeProjectPath(fixture, skillFile),
	]);
	await expectChangedAndWithheld(fixture, skillFile, "explicit-file");
});

test("a denied project skill remains withheld", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "denied");
	const relativePath = relativeProjectPath(fixture, skillFile);

	const denied = await decide(fixture, "deny");
	const loaded = await loadProjectSkills(fixture);

	expect(denied.decision).toBe("denied");
	expect(candidateFor(denied, relativePath)?.verdict).toBe("denied");
	expect(loaded.items.map(skill => skill.name)).toEqual([]);
	expect(loaded.warnings.join("\n")).toContain(relativePath);
});

test("an added skill is not covered by approval for an existing skill", async () => {
	const fixture = await makeFixture();
	const first = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "approved-only");
	await decide(fixture, "approve");
	const added = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "added-later");

	const listed = await decide(fixture, "list");
	const loaded = await loadProjectSkills(fixture);

	expect(candidateFor(listed, relativeProjectPath(fixture, first))?.verdict).toBe("trusted");
	expect(candidateFor(listed, relativeProjectPath(fixture, added))?.verdict).toBe("unknown-file");
	expect(loaded.items.map(skill => skill.name)).toEqual(["approved-only"]);
	expect(loaded.warnings.join("\n")).toContain(relativeProjectPath(fixture, added));
});

test("project directory order wins duplicate skill names", async () => {
	const fixture = await makeFixture();
	const skillFiles: string[] = [];
	for (const directory of PROJECT_SKILL_DIRECTORIES) {
		skillFiles.push(await writeProjectSkill(fixture, directory, "same-name", `From ${directory}.`));
	}

	const approved = await decide(fixture, "approve");
	const loaded = await loadProjectSkills(fixture);

	expect(approved.candidates.map(candidate => candidate.relativePath)).toEqual(
		PROJECT_SKILL_DIRECTORIES.map(directory => `${directory}/same-name/SKILL.md`),
	);
	expect(loaded.items.map(skill => skill.name)).toEqual(["same-name"]);
	expect(loaded.items[0]?._source.path).toBe(skillFiles[0]);
	expect(loaded.items[0]?.content).toContain(`From ${PROJECT_SKILL_DIRECTORIES[0]}.`);
});

test("a repo skill beats the same profile name while project discovery stays out of profile and home roots", async () => {
	const fixture = await makeFixture();
	const repoSkill = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "shared-name", "Repository copy.");
	await writeSkill(path.join(fixture.agentDir, "skills"), "shared-name", "Profile copy.");
	await writeSkill(path.join(fixture.agentDir, "skills"), "profile-only");
	await writeSkill(path.join(fixture.otherAgentDir, "skills"), "foreign-profile-only");
	await writeSkill(path.join(fixture.home, ".agents", "skills"), "home-only");
	await decide(fixture, "approve");

	const projectOnly = await loadProjectSkills(fixture);
	const combined = await loadScopedSkills(fixture, [PROJECT_SKILLS_PROVIDER, "native", "agents"]);
	const shared = combined.items.find(skill => skill.name === "shared-name");

	expect(projectOnly.items.map(skill => skill.name)).toEqual(["shared-name"]);
	expect(projectOnly.items[0]?._source.path).toBe(repoSkill);
	expect(combined.items.map(skill => skill.name)).toEqual(["shared-name", "profile-only", "home-only"]);
	expect(shared?._source.path).toBe(repoSkill);
	expect(combined.items.find(skill => skill.name === "profile-only")?._source.path).toBe(
		path.join(fixture.agentDir, "skills", "profile-only", "SKILL.md"),
	);
	expect(combined.items.find(skill => skill.name === "home-only")?._source.path).toBe(
		path.join(fixture.home, ".agents", "skills", "home-only", "SKILL.md"),
	);
	expect(combined.items.map(skill => skill.name)).not.toContain("foreign-profile-only");
});

test("production loadSkills loads trusted project skills beating profile skills, omits untrusted skills, and refuses script edits across repeat calls without clearing caches", async () => {
	const fixture = await makeFixture();

	const sharedProjectSkill = await writeProjectSkill(
		fixture,
		PROJECT_SKILL_DIRECTORIES[0],
		"shared-skill",
		"Project instructions.",
	);
	await writeSkill(path.join(fixture.agentDir, "skills"), "shared-skill", "Profile copy.");

	const scriptSkill = await writeProjectSkill(
		fixture,
		PROJECT_SKILL_DIRECTORIES[0],
		"scripted-skill",
		"Scripted instructions.",
	);
	const script = path.join(path.dirname(scriptSkill), "scripts", "run.sh");
	await fs.mkdir(path.dirname(script), { recursive: true });
	await fs.writeFile(script, "printf 'initial-script'\n");

	const untrustedSkill = await writeProjectSkill(
		fixture,
		PROJECT_SKILL_DIRECTORIES[1],
		"untrusted-skill",
		"Untrusted instructions.",
	);

	await writeSkill(path.join(fixture.agentDir, "skills"), "profile-only", "Profile unique.");

	await decide(fixture, "approve", fixture.agentDir, [sharedProjectSkill, scriptSkill]);

	const initial = await loadSkills({
		cwd: fixture.nestedCwd,
		agentDir: fixture.agentDir,
	});

	const shared = initial.skills.find(skill => skill.name === "shared-skill");
	expect(shared).toBeDefined();
	expect(shared?.filePath).toBe(sharedProjectSkill);
	expect(shared?._source?.provider).toBe(PROJECT_SKILLS_PROVIDER);

	const scripted = initial.skills.find(skill => skill.name === "scripted-skill");
	expect(scripted).toBeDefined();
	expect(scripted?.filePath).toBe(scriptSkill);

	expect(initial.skills.map(skill => skill.name)).toContain("profile-only");
	expect(initial.skills.map(skill => skill.name)).not.toContain("untrusted-skill");
	expect(
		initial.warnings.some(warning => warning.message.includes(relativeProjectPath(fixture, untrustedSkill))),
	).toBe(true);
	expect(
		initial.warnings.some(
			warning =>
				warning.message.includes('"shared-skill"') &&
				warning.message.includes(sharedProjectSkill),
		),
	).toBe(true);

	await fs.writeFile(script, "printf 'tampered-script'\n");

	const repeat = await loadSkills({
		cwd: fixture.nestedCwd,
		agentDir: fixture.agentDir,
	});

	expect(repeat.skills.map(skill => skill.name)).not.toContain("scripted-skill");
	expect(
		repeat.warnings.some(warning => warning.message.includes(relativeProjectPath(fixture, scriptSkill))),
	).toBe(true);

	const sharedStill = repeat.skills.find(skill => skill.name === "shared-skill");
	expect(sharedStill?.filePath).toBe(sharedProjectSkill);
});

test("production loadSkills loads a project skill approved at repository root from a nested working directory without clearing caches", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(
		fixture,
		PROJECT_SKILL_DIRECTORIES[0],
		"root-approved-skill",
		"Instructions for root-approved skill.",
	);

	await runTrustCommand({
		cwd: fixture.repoRoot,
		agentDir: fixture.agentDir,
		action: "approve",
		paths: [skillFile],
	});

	const loaded = await loadSkills({
		cwd: fixture.nestedCwd,
		agentDir: fixture.agentDir,
	});

	const skill = loaded.skills.find(item => item.name === "root-approved-skill");
	expect(skill).toBeDefined();
	expect(skill?.filePath).toBe(skillFile);
});

test("project trust approvals stay isolated between profile agent directories", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "profile-approved");
	const relativePath = relativeProjectPath(fixture, skillFile);
	await decide(fixture, "approve", fixture.agentDir);

	const workProfile = await loadProjectSkills(fixture, fixture.agentDir);
	const clientDecision = await decide(fixture, "list", fixture.otherAgentDir);
	const clientProfile = await loadProjectSkills(fixture, fixture.otherAgentDir);

	expect(workProfile.items.map(skill => skill.name)).toEqual(["profile-approved"]);
	expect(clientDecision.decision).toBe("undecided");
	expect(candidateFor(clientDecision, relativePath)?.verdict).toBe("untrusted");
	expect(clientProfile.items.map(skill => skill.name)).toEqual([]);
	expect(clientProfile.warnings.join("\n")).toContain(relativePath);
});

symlinkTest("an outside-project symlink makes a project skill unapprovable and unloadable", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "outside-link");
	const external = path.join(fixture.tempRoot, "outside.sh");
	const linked = path.join(path.dirname(skillFile), "scripts", "external.sh");
	await fs.mkdir(path.dirname(linked), { recursive: true });
	await fs.writeFile(external, "printf 'outside'\n");
	await fs.symlink(external, linked, "file");

	const approval = await decide(fixture, "approve");
	const loaded = await loadProjectSkills(fixture);
	const relativePath = relativeProjectPath(fixture, skillFile);

	expect(candidateFor(approval, relativePath)).toBeUndefined();
	expect(approval.decision).toBe("undecided");
	expect(loaded.items.map(skill => skill.name)).toEqual([]);
	expect(loaded.warnings.join("\n")).toContain(relativePath);
});
symlinkTest("a broken symlink makes a project skill unapprovable and unloadable", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "broken-link");
	const linked = path.join(path.dirname(skillFile), "scripts", "missing.sh");
	await fs.mkdir(path.dirname(linked), { recursive: true });
	await fs.symlink(path.join(fixture.tempRoot, "missing.sh"), linked, "file");

	const approval = await decide(fixture, "approve");
	const loaded = await loadProjectSkills(fixture);
	const relativePath = relativeProjectPath(fixture, skillFile);
	const warning = loaded.warnings.join("\n");

	expect(candidateFor(approval, relativePath)).toBeUndefined();
	expect(approval.decision).toBe("undecided");
	expect(loaded.items.map(skill => skill.name)).toEqual([]);
	expect(warning).toContain(relativePath);
	expect(warning).toContain("skill folder is unsafe or unreadable");
	expect(warning).not.toContain("symlink cycle");
});

dirSymlinkTest("a directory symlink to the project root makes a skill unapprovable and unloadable", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "root-link");
	const linked = path.join(path.dirname(skillFile), "assets", "project-root");
	await fs.mkdir(path.dirname(linked), { recursive: true });
	await fs.symlink(fixture.repoRoot, linked, process.platform === "win32" ? "junction" : "dir");

	const approval = await decide(fixture, "approve");
	const loaded = await loadProjectSkills(fixture);
	const relativePath = relativeProjectPath(fixture, skillFile);
	const warning = loaded.warnings.join("\n");

	expect(candidateFor(approval, relativePath)).toBeUndefined();
	expect(approval.decision).toBe("undecided");
	expect(loaded.items.map(skill => skill.name)).toEqual([]);
	expect(warning).toContain(relativePath);
	expect(warning).toContain("skill folder is unsafe or unreadable");
	expect(warning).not.toContain("symlink cycle");
});

dirSymlinkTest("a symlink cycle makes a project skill unapprovable and unloadable", async () => {
	const fixture = await makeFixture();
	const skillFile = await writeProjectSkill(fixture, PROJECT_SKILL_DIRECTORIES[0], "cycle-link");
	const skillDir = path.dirname(skillFile);
	const cycle = path.join(skillDir, "assets", "loop");
	await fs.mkdir(path.dirname(cycle), { recursive: true });
	await fs.symlink(skillDir, cycle, process.platform === "win32" ? "junction" : "dir");

	const approval = await decide(fixture, "approve");
	const loaded = await loadProjectSkills(fixture);
	const relativePath = relativeProjectPath(fixture, skillFile);

	expect(candidateFor(approval, relativePath)).toBeUndefined();
	expect(approval.decision).toBe("undecided");
	expect(loaded.warnings.join("\n")).toContain(relativePath);
	expect(loaded.items.map(skill => skill.name)).toEqual([]);
});


