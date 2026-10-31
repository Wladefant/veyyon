/**
 * WHY: A score run copies a frozen candidate arm into its variants. If inspection reuses that
 * copied body, changing or deleting the candidate artifact can still look fresh. This regression
 * requires inspection to load the current candidate artifact and report unknown when it is absent.
 * It does not verify provider revision freshness or authenticate local run JSON.
 */

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bindSkillExperiment } from "../../engine/skills/binding";
import { loadSkillArms } from "../../engine/skills/lifecycle";
import { inspectSkillRun } from "../../evals";
import { typescriptEditSuite } from "../../suites/typescript-edit/main";

const model = "anthropic/claude-sonnet-4-6";

async function writeCandidate(pathname: string, sourceHash: string, content: string): Promise<void> {
	const resolvedModel = { provider: "anthropic", id: "claude-sonnet-4-6", version: "revision-1" };
	await fs.writeFile(
		pathname,
		JSON.stringify({
			version: 1,
			kind: "veyyon-skill-candidate",
			skillName: "inspect-skill",
			sourceHash,
			candidateHash: createHash("sha256").update(content, "utf8").digest("hex"),
			content,
			model,
			splitSeed: "seed",
			feedbackTaskIds: ["feedback-1"],
			createdAt: "2026-10-29T00:00:00.000Z",
			binding: {
				version: 1,
				cohortSize: 100,
				sourceHash,
				datasetFingerprint: "d".repeat(64),
				criteriaHash: "criterion-v1",
				minimumImprovement: 0,
				splitFingerprint: "s".repeat(64),
				buildHash: "b".repeat(64),
				registryHash: "r".repeat(64),
				graderHash: "g".repeat(64),
				suiteIdentity: { suite: typescriptEditSuite.id, version: typescriptEditSuite.version, sha: "a".repeat(64) },
				requestedModels: [model],
				resolvedModel,
			},
			resolvedModel,
		}),
		"utf8",
	);
}

describe("skill run inspection", () => {
	it("marks a changed candidate artifact stale and a missing one unverified", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-inspect-"));
		try {
			const manifestPath = path.join(directory, "manifest.json");
			const candidatePath = path.join(directory, "candidate.json");
			const runPath = path.join(directory, "run.json");
			const skillContent = "Skill body.\nCOMPONENT\n";
			const sourceHash = createHash("sha256").update(skillContent, "utf8").digest("hex");
			await fs.writeFile(
				manifestPath,
				JSON.stringify({
					version: 1,
					skillName: "inspect-skill",
					sourceHash,
					content: skillContent,
					components: [{ name: "component", content: "COMPONENT\n" }],
					criteria: { minimumImprovement: 0 },
				}),
				"utf8",
			);
			await writeCandidate(candidatePath, sourceHash, "First candidate.");
			const candidateArm = (await loadSkillArms(manifestPath, candidatePath)).find(arm => arm.kind === "candidate");
			if (!candidateArm) throw new Error("Candidate artifact did not create a candidate arm.");
			const variant = {
				name: "candidate",
				model,
				harness: "veyyon",
				configPath: null,
				promptVariantPath: null,
				attachments: [],
				skillArm: candidateArm,
			};
			const provenance = await typescriptEditSuite.provenance({});
			const binding = await bindSkillExperiment([variant], provenance, { minimumImprovement: 0 });
			await fs.writeFile(
				runPath,
				JSON.stringify({
					metadata: { skillBinding: binding },
					suite: { name: typescriptEditSuite.id },
					variants: [variant],
				}),
				"utf8",
			);
			await writeCandidate(candidatePath, sourceHash, "Changed candidate.");
			expect(await inspectSkillRun({ runPath, manifestPath, candidatePath })).toBe(1);
			expect(await inspectSkillRun({ runPath, manifestPath })).toBe(2);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	}, 180_000);
});
