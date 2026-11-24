import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type KnowledgeAction, runKnowledgeCliCommand } from "../../src/cli/shared-knowledge-cli";
import { exportKnowledgeCatalog } from "../../src/shared-knowledge/syncer";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

describe("runKnowledgeCliCommand argument refusals", () => {
	it("refuses an export with neither an output directory nor a plan", async () => {
		await expect(runKnowledgeCliCommand({ action: "export" })).rejects.toThrow(
			"Specify --out for export or --plan for review",
		);
	});

	it("refuses a status or diff with no catalog directory", async () => {
		await expect(runKnowledgeCliCommand({ action: "status" })).rejects.toThrow(
			"Must specify catalog directory with --from <dir> or positional argument for diff/status",
		);
	});

	it("refuses apply with no catalog directory and names the action", async () => {
		await expect(runKnowledgeCliCommand({ action: "apply" })).rejects.toThrow(
			"Must specify catalog directory with --from <dir> or positional argument for apply",
		);
	});

	it("refuses an action the CLI does not know", async () => {
		const unknown = "publish" as KnowledgeAction;
		await expect(runKnowledgeCliCommand({ action: unknown })).rejects.toThrow("Unknown knowledge action: publish");
	});
});

describe("runKnowledgeCliCommand verify", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-knowledge-cli-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("verifies an exported catalog and reports its item count as JSON", async () => {
		const sourceAgentDir = path.join(tempDir, "source", "agent");
		const sourceGlobalDir = path.join(tempDir, "source", "global");
		const sourceWorkflowsDir = path.join(tempDir, "source", "workflows");
		const skillDir = path.join(sourceAgentDir, "skills", "docs-first");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.mkdir(sourceGlobalDir, { recursive: true });
		await fs.mkdir(sourceWorkflowsDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Docs First\nRead the docs.", "utf-8");

		const catalogDir = path.join(tempDir, "catalog");
		const options = {
			outDir: catalogDir,
			agentDir: sourceAgentDir,
			globalDir: sourceGlobalDir,
			workflowsDir: sourceWorkflowsDir,
		};
		const planPath = path.join(tempDir, "review-plan.json");
		await exportKnowledgeCatalog({ ...options, planPath });
		const exported = await exportKnowledgeCatalog({ ...options, reviewedPlanPath: planPath });

		const printed: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			printed.push(args.map(String).join(" "));
		});
		try {
			await runKnowledgeCliCommand({ action: "verify", path: catalogDir, json: true });
		} finally {
			log.mockRestore();
		}

		const report = JSON.parse(printed.join("\n"));
		expect(report).toMatchObject({ valid: true, itemCount: exported.exportedCount });
		expect(report.itemCount).toBeGreaterThan(0);
	});
});
