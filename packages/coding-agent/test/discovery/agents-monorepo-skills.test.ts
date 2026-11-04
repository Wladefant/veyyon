/**
 * The `agents` provider reads user-level skills, rules, prompts, and commands.
 * It does not discover those capabilities from a repository. Project skills have
 * a separate provider and trust gate; this suite pins that `.agents` does not
 * become a second, untrusted route into the user-scoped `agents` provider.
 *
 * The cases drive the REAL provider registry through `loadCapability` with an
 * explicit provider allowlist, against a monorepo fixture (a repo root with a
 * `.git` marker and one package under `packages/`). The user level
 * (`~/.agent`, `~/.agents`) remains the positive control: it must keep loading.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability, reset as resetCapabilityCaches } from "@veyyon/coding-agent/discovery/capability";
import type { ContextFile } from "@veyyon/coding-agent/discovery/capability/context-file";
import type { Prompt } from "@veyyon/coding-agent/discovery/capability/prompt";
import type { Rule } from "@veyyon/coding-agent/discovery/capability/rule";
import type { DiscoveredSkill } from "@veyyon/coding-agent/discovery/capability/skill";
import type { SlashCommand } from "@veyyon/coding-agent/discovery/capability/slash-command";
import type { SourceMeta } from "@veyyon/coding-agent/discovery/capability/types";
import "@veyyon/coding-agent/discovery";
import { removeSyncWithRetries } from "@veyyon/utils";

/** The provider whose capabilities are scoped to user directories only. */
const AGENTS = "agents";
/** The provider for standalone AGENTS.md / CLAUDE.md context files. */
const AGENTS_MD = "agents-md";

function writeSkill(dir: string, name: string, description: string): void {
	const skillDir = path.join(dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill content.\n`,
	);
}

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content);
}

function projectPaths(items: Array<{ _source?: SourceMeta }>): string[] {
	return items.flatMap(item => (item._source?.level === "project" ? [item._source.path] : []));
}

describe("the agents provider keeps its capabilities at user scope", () => {
	let tempDir: string;
	let userHome: string;
	let repoRoot: string;
	let subProject: string;
	let agentDir: string;

	beforeEach(() => {
		resetCapabilityCaches();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-monorepo-"));
		userHome = path.join(tempDir, "home");
		repoRoot = path.join(tempDir, "repo");
		subProject = path.join(repoRoot, "packages", "my-app");
		agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(subProject, { recursive: true });
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
		fs.mkdirSync(userHome, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		resetCapabilityCaches();
		removeSyncWithRetries(tempDir);
	});

	/** Load one capability from the sub-project cwd through the agents provider only. */
	function loadFromAgents<T>(capability: string) {
		return loadCapability<T>(capability, {
			cwd: subProject,
			home: userHome,
			agentDir,
			providers: [AGENTS],
		});
	}

	// =========================================================================
	// Skills
	// =========================================================================

	describe("skills", () => {
		test("the agents provider ignores repo-root .agents/skills from a sub-project cwd", async () => {
			writeSkill(path.join(repoRoot, ".agents", "skills"), "root-skill", "From repo root");

			const result = await loadFromAgents<DiscoveredSkill>("skills");

			expect(result.items.map(skill => skill.name)).not.toContain("root-skill");
			expect(projectPaths(result.all)).toEqual([]);
		});

		test("the agents provider ignores sub-project-local .agents/skills", async () => {
			writeSkill(path.join(subProject, ".agents", "skills"), "local-skill", "From sub-project");

			const result = await loadFromAgents<DiscoveredSkill>("skills");

			expect(result.items.map(skill => skill.name)).not.toContain("local-skill");
			expect(projectPaths(result.all)).toEqual([]);
		});

		test("still loads the user level: ~/.agents/skills is found from inside the monorepo", async () => {
			writeSkill(path.join(repoRoot, ".agents", "skills"), "root-skill", "From repo root");
			writeSkill(path.join(userHome, ".agents", "skills"), "user-skill", "From the operator's home");

			const result = await loadFromAgents<DiscoveredSkill>("skills");

			const userSkill = result.items.find(skill => skill.name === "user-skill");
			expect(userSkill).toBeDefined();
			expect(userSkill?._source.level).toBe("user");
			expect(result.items.map(skill => skill.name)).not.toContain("root-skill");
		});
	});

	// =========================================================================
	// Rules
	// =========================================================================

	describe("rules", () => {
		test("finds no rule in the repo root's .agents/rules from a sub-project cwd", async () => {
			writeFile(path.join(repoRoot, ".agents", "rules", "root-rule.md"), "# Root\n\nRoot rule.");

			const result = await loadFromAgents<Rule>("rules");

			expect(result.items.map(rule => rule.name)).not.toContain("root-rule");
			expect(projectPaths(result.all)).toEqual([]);
		});

		test("finds no rule in the sub-project's own .agents/rules either", async () => {
			writeFile(path.join(subProject, ".agents", "rules", "local-rule.md"), "# Local\n\nLocal rule.");

			const result = await loadFromAgents<Rule>("rules");

			expect(result.items.map(rule => rule.name)).not.toContain("local-rule");
			expect(projectPaths(result.all)).toEqual([]);
		});

		test("still loads the user level: ~/.agents/rules is found from inside the monorepo", async () => {
			writeFile(path.join(repoRoot, ".agents", "rules", "root-rule.md"), "# Root\n\nRoot rule.");
			writeFile(path.join(userHome, ".agents", "rules", "user-rule.md"), "# User\n\nUser rule.");

			const result = await loadFromAgents<Rule>("rules");

			expect(result.items.map(rule => rule.name)).toContain("user-rule");
			expect(result.items.map(rule => rule.name)).not.toContain("root-rule");
		});
	});

	// =========================================================================
	// Prompts
	// =========================================================================

	describe("prompts", () => {
		test("finds no prompt anywhere in the monorepo's .agents/prompts directories", async () => {
			writeFile(path.join(subProject, ".agents", "prompts", "local.md"), "Local prompt.");
			writeFile(path.join(repoRoot, ".agents", "prompts", "root.md"), "Root prompt.");

			const result = await loadFromAgents<Prompt>("prompts");

			expect(result.items.map(prompt => prompt.name)).toEqual([]);
			expect(projectPaths(result.all)).toEqual([]);
		});
	});

	// =========================================================================
	// Commands
	// =========================================================================

	describe("commands", () => {
		test("finds no command anywhere in the monorepo's .agents/commands directories", async () => {
			writeFile(path.join(subProject, ".agents", "commands", "local-cmd.md"), "Local command.");
			writeFile(path.join(repoRoot, ".agents", "commands", "root-cmd.md"), "Root command.");

			const result = await loadFromAgents<SlashCommand>("slash-commands");

			expect(result.items.map(command => command.name)).toEqual([]);
			expect(projectPaths(result.all)).toEqual([]);
		});
	});

	// =========================================================================
	// Context files: the one repository contribution still allowed
	// =========================================================================

	describe("context files (AGENTS.md)", () => {
		function loadContextFiles() {
			return loadCapability<ContextFile>("context-files", {
				cwd: subProject,
				home: userHome,
				agentDir,
				providers: [AGENTS_MD],
			});
		}

		test("ignores .agents/AGENTS.md: a dotted directory is not a context-file location", async () => {
			writeFile(path.join(repoRoot, ".agents", "AGENTS.md"), "# Dotted Rules\n\nDo not load me.");

			const result = await loadContextFiles();

			expect(result.items).toEqual([]);
		});

		test("still walks up for standalone AGENTS.md files, closest first", async () => {
			writeFile(path.join(subProject, "AGENTS.md"), "# Local Rules");
			writeFile(path.join(repoRoot, "AGENTS.md"), "# Root Rules");

			const result = await loadContextFiles();

			expect(result.items.map(file => file.content)).toEqual(["# Local Rules", "# Root Rules"]);
			expect(result.items.map(file => file.level)).toEqual(["project", "project"]);
			// Depth is what keeps dedup keys distinct across levels: 0 at cwd, deeper above.
			expect(result.items[0]?.depth).toBe(0);
			expect(result.items[1]?.depth).toBeGreaterThan(0);
		});

		test("stops the AGENTS.md walk-up at the repository root", async () => {
			writeFile(path.join(tempDir, "AGENTS.md"), "# Above Repo");
			writeFile(path.join(repoRoot, "AGENTS.md"), "# Root Rules");

			const result = await loadContextFiles();

			expect(result.items.map(file => file.content)).toEqual(["# Root Rules"]);
		});
	});
});
