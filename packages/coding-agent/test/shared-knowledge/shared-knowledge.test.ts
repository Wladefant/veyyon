import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyKnowledgeCatalog,
	collectLocalKnowledge,
	computeSha256,
	diffKnowledgeCatalog,
	exportKnowledgeCatalog,
	extractHindsightReference,
	readCatalog,
	validateSecurityAllowlist,
} from "../../src/shared-knowledge";
import type { ExportOptions } from "../../src/shared-knowledge/types";

describe("Shared Text Knowledge Synchronization", () => {
	let tempDir: string;
	let sourceAgentDir: string;
	let sourceGlobalDir: string;
	let sourceWorkflowsDir: string;
	let targetAgentDir: string;
	let targetGlobalDir: string;
	let targetWorkflowsDir: string;
	let catalogDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-shared-knowledge-test-"));
		sourceAgentDir = path.join(tempDir, "source", "agent");
		sourceGlobalDir = path.join(tempDir, "source", "global");
		sourceWorkflowsDir = path.join(tempDir, "source", "workflows");

		targetAgentDir = path.join(tempDir, "target", "agent");
		targetGlobalDir = path.join(tempDir, "target", "global");
		targetWorkflowsDir = path.join(tempDir, "target", "workflows");

		catalogDir = path.join(tempDir, "catalog");

		await fs.mkdir(sourceAgentDir, { recursive: true });
		await fs.mkdir(sourceGlobalDir, { recursive: true });
		await fs.mkdir(sourceWorkflowsDir, { recursive: true });

		await fs.mkdir(targetAgentDir, { recursive: true });
		await fs.mkdir(targetGlobalDir, { recursive: true });
		await fs.mkdir(targetWorkflowsDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("completes clean roundtrip export and apply across all knowledge categories", async () => {
		// 1. Setup source assets
		// Authored skill
		const skillDir = path.join(sourceAgentDir, "skills", "docs-first");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Docs First Skill\nAlways read docs first.", "utf-8");

		// Managed skill
		const managedDir = path.join(sourceAgentDir, "managed-skills", "auto-formatter");
		await fs.mkdir(managedDir, { recursive: true });
		await fs.writeFile(path.join(managedDir, "SKILL.md"), "# Auto Formatter\nRun formatter.", "utf-8");

		// Learned lessons
		const memoryDir = path.join(sourceAgentDir, "memories");
		await fs.mkdir(memoryDir, { recursive: true });
		await fs.writeFile(
			path.join(memoryDir, "learned.md"),
			"- Lesson: Always preserve conflict copies on sync.",
			"utf-8",
		);

		// Rules
		const rulesDir = path.join(sourceAgentDir, "rules");
		await fs.mkdir(rulesDir, { recursive: true });
		await fs.writeFile(path.join(rulesDir, "standards.md"), "# Standards\nHigh quality only.", "utf-8");
		await fs.writeFile(path.join(sourceAgentDir, "AGENTS.md"), "# Profile Agents Instructions", "utf-8");
		await fs.writeFile(path.join(sourceGlobalDir, "AGENTS.md"), "# Global Agents Instructions", "utf-8");

		// Workflows
		await fs.writeFile(
			path.join(sourceWorkflowsDir, "audit.py"),
			"# Bounded workflow audit script\nprint('audit ok')",
			"utf-8",
		);

		// Hindsight reference config
		const exportOptions: ExportOptions = {
			agentDir: sourceAgentDir,
			globalDir: sourceGlobalDir,
			workflowsDir: sourceWorkflowsDir,
			outDir: catalogDir,
			includeHindsightReference: true,
			hindsightConfig: {
				apiUrl: "https://hindsight.vectorize.io",
				bankId: "pilot-shared-bank",
				scoping: "account",
			},
		};

		// 2. Export catalog
		const exportResult = await exportKnowledgeCatalog(exportOptions);
		expect(exportResult.exportedCount).toBeGreaterThan(0);
		expect(exportResult.manifest.items.length).toBe(exportResult.exportedCount);

		// Verify catalog structure
		const { manifest, files } = await readCatalog(catalogDir);
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.hindsightReference).toBeDefined();
		expect(manifest.hindsightReference?.apiUrl).toBe("https://hindsight.vectorize.io");
		expect(manifest.hindsightReference?.bankId).toBe("pilot-shared-bank");

		// 3. Apply catalog to clean target
		const applyResult = await applyKnowledgeCatalog({
			catalogDir,
			targetAgentDir,
			targetGlobalDir,
			targetWorkflowsDir,
		});

		expect(applyResult.success).toBe(true);
		expect(applyResult.conflictCount).toBe(0);
		expect(applyResult.appliedCount).toBe(manifest.items.length);

		// 4. Verify target files match byte-for-byte
		const targetSkill = await fs.readFile(
			path.join(targetAgentDir, "skills", "docs-first", "SKILL.md"),
			"utf-8",
		);
		expect(targetSkill).toBe("# Docs First Skill\nAlways read docs first.");

		const targetManaged = await fs.readFile(
			path.join(targetAgentDir, "managed-skills", "auto-formatter", "SKILL.md"),
			"utf-8",
		);
		expect(targetManaged).toBe("# Auto Formatter\nRun formatter.");

		const targetLessons = await fs.readFile(
			path.join(targetAgentDir, "memories", "learned.md"),
			"utf-8",
		);
		expect(targetLessons).toBe("- Lesson: Always preserve conflict copies on sync.");

		const targetWorkflow = await fs.readFile(
			path.join(targetWorkflowsDir, "audit.py"),
			"utf-8",
		);
		expect(targetWorkflow).toBe("# Bounded workflow audit script\nprint('audit ok')");

		// 5. Subsequent apply with no changes is a clean no-op
		const secondApply = await applyKnowledgeCatalog({
			catalogDir,
			targetAgentDir,
			targetGlobalDir,
			targetWorkflowsDir,
		});
		expect(secondApply.success).toBe(true);
		expect(secondApply.appliedCount).toBe(0);
		expect(secondApply.comparison.unchanged.length).toBe(manifest.items.length);
	});

	it("preserves authored-over-managed precedence", async () => {
		// Target has an authored skill named "lint-check"
		const targetSkillDir = path.join(targetAgentDir, "skills", "lint-check");
		await fs.mkdir(targetSkillDir, { recursive: true });
		await fs.writeFile(
			path.join(targetSkillDir, "SKILL.md"),
			"# Authored Lint Check\nAuthor custom logic.",
			"utf-8",
		);

		// Incoming catalog attempts to deliver a managed skill of the same name "lint-check"
		const incomingManagedDir = path.join(sourceAgentDir, "managed-skills", "lint-check");
		await fs.mkdir(incomingManagedDir, { recursive: true });
		await fs.writeFile(
			path.join(incomingManagedDir, "SKILL.md"),
			"# Auto-Learned Lint Check\nManaged generated logic.",
			"utf-8",
		);

		await exportKnowledgeCatalog({
			agentDir: sourceAgentDir,
			outDir: catalogDir,
			categories: ["managed-skills"],
		});

		// Apply to target
		const applyResult = await applyKnowledgeCatalog({
			catalogDir,
			targetAgentDir,
			targetGlobalDir,
			targetWorkflowsDir,
		});

		expect(applyResult.success).toBe(true);
		// The managed skill was shadowed because target already had an authored skill of the same name
		expect(applyResult.comparison.shadowed.length).toBe(1);
		expect(applyResult.comparison.shadowed[0].item.name).toBe("lint-check");

		// Verify target authored skill was untouched
		const targetContent = await fs.readFile(
			path.join(targetSkillDir, "SKILL.md"),
			"utf-8",
		);
		expect(targetContent).toBe("# Authored Lint Check\nAuthor custom logic.");
	});

	it("detects concurrent divergent edits, refuses overwrites, and preserves both inputs", async () => {
		// 1. Initial shared baseline
		const skillDir = path.join(sourceAgentDir, "skills", "code-review");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "Version 1: Baseline", "utf-8");

		await exportKnowledgeCatalog({
			agentDir: sourceAgentDir,
			outDir: catalogDir,
			categories: ["skills"],
		});

		// Apply to target to establish baseline
		const initialApply = await applyKnowledgeCatalog({
			catalogDir,
			targetAgentDir,
			targetGlobalDir,
			targetWorkflowsDir,
		});
		expect(initialApply.success).toBe(true);

		// 2. Upstream edits the skill
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "Version 2: Upstream edit", "utf-8");
		await exportKnowledgeCatalog({
			agentDir: sourceAgentDir,
			outDir: catalogDir,
			categories: ["skills"],
		});

		// 3. Target concurrently edits the skill differently
		const targetSkillPath = path.join(targetAgentDir, "skills", "code-review", "SKILL.md");
		await fs.writeFile(targetSkillPath, "Version 2: Local target edit", "utf-8");

		// 4. Apply incoming catalog to target
		const conflictApply = await applyKnowledgeCatalog({
			catalogDir,
			targetAgentDir,
			targetGlobalDir,
			targetWorkflowsDir,
			preserveConflicts: true,
		});

		// Refuses overwrites!
		expect(conflictApply.success).toBe(false);
		expect(conflictApply.conflictCount).toBe(1);
		expect(conflictApply.errors.length).toBeGreaterThan(0);

		// Original target file remains completely UNTOUCHED
		const preservedTarget = await fs.readFile(targetSkillPath, "utf-8");
		expect(preservedTarget).toBe("Version 2: Local target edit");

		// Incoming conflicting content is preserved in a .conflict.<hash> file
		expect(conflictApply.conflictFiles.length).toBe(1);
		const conflictFileContent = await fs.readFile(conflictApply.conflictFiles[0], "utf-8");
		expect(conflictFileContent).toBe("Version 2: Upstream edit");
	});

	it("enforces strict security allowlist rejecting databases, secrets, symlinks, and traversal", async () => {
		// Path traversal rejection
		const traversalCheck = await validateSecurityAllowlist("../secrets.txt");
		expect(traversalCheck.valid).toBe(false);
		expect(traversalCheck.reason).toContain("Path traversal segment");

		// Database rejection (.db, .db-wal, agent.db)
		expect((await validateSecurityAllowlist("agent.db")).valid).toBe(false);
		expect((await validateSecurityAllowlist("data/store.sqlite")).valid).toBe(false);
		expect((await validateSecurityAllowlist("db.sqlite-wal")).valid).toBe(false);

		// Secret file rejection (.env, id_rsa, credentials.json)
		expect((await validateSecurityAllowlist(".env")).valid).toBe(false);
		expect((await validateSecurityAllowlist(".env.production")).valid).toBe(false);
		expect((await validateSecurityAllowlist("credentials.json")).valid).toBe(false);
		expect((await validateSecurityAllowlist("id_rsa")).valid).toBe(false);
		expect((await validateSecurityAllowlist("shared-auth/keys.json")).valid).toBe(false);

		// Runtime rejection (*.sock, *.pid, logs/, cache/)
		expect((await validateSecurityAllowlist("server.sock")).valid).toBe(false);
		expect((await validateSecurityAllowlist("process.pid")).valid).toBe(false);
		expect((await validateSecurityAllowlist("logs/debug.log")).valid).toBe(false);
		expect((await validateSecurityAllowlist("node_modules/pkg/index.js")).valid).toBe(false);

		// Secret content rejection
		const secretContentCheck = await validateSecurityAllowlist("skills/test/SKILL.md", {
			content: "export API_KEY = sk-proj-123456789012345678901234567890",
		});
		expect(secretContentCheck.valid).toBe(false);
		expect(secretContentCheck.reason).toContain("credential/secret pattern");
	});

	it("enforces atomicity: no partial application if any item has a conflict or validation error", async () => {
		// Setup source with 2 clean skills
		const skill1Dir = path.join(sourceAgentDir, "skills", "skill-one");
		await fs.mkdir(skill1Dir, { recursive: true });
		await fs.writeFile(path.join(skill1Dir, "SKILL.md"), "Skill One Content", "utf-8");

		const skill2Dir = path.join(sourceAgentDir, "skills", "skill-two");
		await fs.mkdir(skill2Dir, { recursive: true });
		await fs.writeFile(path.join(skill2Dir, "SKILL.md"), "Skill Two Content", "utf-8");

		await exportKnowledgeCatalog({
			agentDir: sourceAgentDir,
			outDir: catalogDir,
			categories: ["skills"],
		});

		// In target, skill-two already exists with divergent unbaselined content
		const targetSkill2Dir = path.join(targetAgentDir, "skills", "skill-two");
		await fs.mkdir(targetSkill2Dir, { recursive: true });
		await fs.writeFile(path.join(targetSkill2Dir, "SKILL.md"), "Divergent Local Skill Two", "utf-8");

		// Target does NOT have skill-one yet
		const targetSkill1Path = path.join(targetAgentDir, "skills", "skill-one", "SKILL.md");

		// Apply should fail because skill-two is in conflict
		const applyResult = await applyKnowledgeCatalog({
			catalogDir,
			targetAgentDir,
			targetGlobalDir,
			targetWorkflowsDir,
		});

		expect(applyResult.success).toBe(false);
		expect(applyResult.conflictCount).toBe(1);

		// ATOMICITY ASSERTION: skill-one must NOT have been written!
		let skillOneExists = false;
		try {
			await fs.access(targetSkill1Path);
			skillOneExists = true;
		} catch {
			skillOneExists = false;
		}
		expect(skillOneExists).toBe(false);

		// Target skill-two must remain untouched
		const targetSkill2Content = await fs.readFile(
			path.join(targetSkill2Dir, "SKILL.md"),
			"utf-8",
		);
		expect(targetSkill2Content).toBe("Divergent Local Skill Two");
	});

	it("extracts and applies Hindsight reference config without credentials or database migration", () => {
		const rawSettings = {
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "https://hindsight.vectorize.io",
			"hindsight.apiToken": "super-secret-token-12345", // Must be strictly excluded!
			"hindsight.bankId": "team-bank",
			"hindsight.scoping": "account",
			"hindsight.autoRecall": true,
			"hindsight.autoRetain": true,
		};

		const ref = extractHindsightReference(rawSettings);
		expect(ref).toBeDefined();
		expect(ref?.backend).toBe("hindsight");
		expect(ref?.apiUrl).toBe("https://hindsight.vectorize.io");
		expect(ref?.bankId).toBe("team-bank");
		expect(ref?.scoping).toBe("account");
		expect(ref?.autoRecall).toBe(true);

		// STRICT VERIFICATION: credentials must never be in the reference object
		const refRecord: Record<string, unknown> = ref ? { ...ref } : {};
		expect("apiToken" in refRecord).toBe(false);
		expect("hindsight.apiToken" in refRecord).toBe(false);
		expect(JSON.stringify(ref)).not.toContain("super-secret-token");
		expect(ref?._referenceNotice).toContain("No database migration is performed");
	});
});
