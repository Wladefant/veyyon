/**
 * WHY: The real final CLI passed a wrapper where a raw binding was required, so isolated
 * lifecycle tests passed while every final invocation failed before reaching its plan.
 * This drives main with real suite discovery and production artifact readers. Only grader
 * results are synthetic. It also rejects a candidate arm substituted in a saved score run.
 * GAP: No provider call occurs; this proves preflight, not model quality or final execution.
 */
import { afterEach, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { TempDir } from "@veyyon/utils";
import { main } from "../../evals";
import { buildSkillArms } from "../../engine/skills/arms";
import { bindSkillExperiment } from "../../engine/skills/binding";
import { createCandidateSourceBinding, createSkillSelection, loadSkillArms, readSkillExperimentCriteria, readSkillPhaseRun } from "../../engine/skills/lifecycle";
import type { SkillCandidateArtifact } from "../../engine/skills/lifecycle";
import { splitTasks } from "../../engine/task-splits";
import { typescriptEditSuite } from "../../suites/typescript-edit/main";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
afterEach(() => {
	spyOn(process.stdout, "write").mockRestore();
	spyOn(process.stderr, "write").mockRestore();
});

it("accepts an unknown-revision incumbent through the real final CLI and rejects substituted candidate arms", async () => {
	const directory = await TempDir.create("@evals-test-final-skill-cli-");
	try {
		const manifestPath = directory.join("manifest.json");
		const candidatePath = directory.join("candidate.json");
		const scorePath = directory.join("score.json");
		const selectionPath = directory.join("selection.json");
		const seed = "final-cli-regression";
		const model = "openai-codex/gpt-6-luna";
		const content = "Edit only the requested token.\nPreserve all other bytes.\n";
		const manifest = { version: 1, cohortSize: 80, skillName: "targeted-edit", content,
			sourceHash: hash(content), components: [{ name: "minimal-edit", content: "Edit only the requested token.\n" }],
			criteria: { minimumImprovement: 0 } };
		await fs.writeFile(manifestPath, JSON.stringify(manifest));
		const tasks = await Promise.all((await typescriptEditSuite.discoverTasks()).map(id => typescriptEditSuite.describeTask(id)));
		const partitions = splitTasks(tasks, seed, 80);
		const full = buildSkillArms(manifest).find(arm => arm.kind === "full")!;
		const variants = [{ name: "veyyon__skill-full", harness: "veyyon", model, skillArm: full, configPath: null, promptVariantPath: null, attachments: [] }];
		const provenance = await typescriptEditSuite.provenance();
		const frozenBinding = await bindSkillExperiment(variants, provenance, manifest.criteria, 80);
		const criteria = await readSkillExperimentCriteria(manifestPath);
		const resolvedModel = { provider: "openai-codex", id: "gpt-6-luna", version: null };
		const binding = createCandidateSourceBinding(frozenBinding, tasks, full.sourceHash, criteria, seed, resolvedModel, 80);
		const revisedContent = `${content}Check the changed token once.\n`;
		const candidate: SkillCandidateArtifact = {
			version: 1, kind: "veyyon-skill-candidate", skillName: full.skillName, sourceHash: full.sourceHash,
			candidateHash: hash(revisedContent), content: revisedContent, model, splitSeed: seed,
			feedbackTaskIds: partitions.feedback.map(task => task.id), createdAt: "2026-10-29T00:00:00.000Z", binding, resolvedModel,
		};
		await fs.writeFile(candidatePath, JSON.stringify(candidate));
		const scoreArms = (await loadSkillArms(manifestPath, candidatePath, seed)).filter(arm => arm.kind === "full" || arm.kind === "candidate");
		const scoreVariants = scoreArms.map(arm => ({ name: `veyyon__skill-${arm.id}`, harness: "veyyon", model, skillArm: arm }));
		const record = {
			suite: { name: provenance.suite, version: provenance.version, provenanceSha: provenance.sha },
			tasks: partitions.score.map(task => task.id), variants: scoreVariants,
			metadata: { skillPhase: "score", skillBinding: frozenBinding },
			results: partitions.score.flatMap(task => scoreVariants.map(variant => ({
				cell: { task: task.id, variant: variant.name, repeat: 1 }, score: { reward: 0, error: null },
				artifacts: { extra: { skillArm: { ...variant.skillArm }, resolvedModel,
					observedSkillPrompt: { role: "developer", attribution: "agent", present: true, contentHash: variant.skillArm.contentHash, messageHash: hash(`observed-${variant.skillArm.contentHash}`) },
					observedSkillHashes: [{ name: full.skillName, contentHash: variant.skillArm.contentHash }] } },
			}))),
		};
		await fs.writeFile(scorePath, JSON.stringify(record));
		const readScore = () => readSkillPhaseRun({ runPath: scorePath, phase: "score", tasks, splitSeed: seed, manifestPath, candidate });
		const firstExtra = record.results[0]!.artifacts.extra;
		const observedPrompt = firstExtra.observedSkillPrompt;
		for (const invalidPrompt of [null, { ...observedPrompt, present: false }, { ...observedPrompt, role: "user" }, { ...observedPrompt, contentHash: "wrong" }]) {
			await fs.writeFile(scorePath, JSON.stringify({
				...record, results: record.results.map((result, index) => index === 0
					? { ...result, artifacts: { extra: { ...result.artifacts.extra, observedSkillPrompt: invalidPrompt } } }
					: result),
			}));
			await expect(readScore()).rejects.toThrow("Run outcome has no verified agent-authored skill body in model context.");
		}
		await fs.writeFile(scorePath, JSON.stringify(record));
		const score = await readScore();
		const selection = await createSkillSelection({ tasks, splitSeed: seed, outcomes: score.scoreOutcomes,
			candidate, sourceHash: full.sourceHash, binding: score.binding, scoreRunHash: score.runHash, outputPath: selectionPath });
		expect(selection.winner).toBe("incumbent");
		expect(selection.score.reason).toBe("unknown-model-revision");
		const chunks: string[] = [];
		spyOn(process.stdout, "write").mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
		spyOn(process.stderr, "write").mockImplementation(chunk => { chunks.push(String(chunk)); return true; });
		const args = ["--suite", "typescript-edit", "--harness", "veyyon", "--model", model,
			"--repeats", "1", "--skill-experiment", manifestPath, "--skill-phase", "final", "--skill-split-seed", seed,
			"--skill-candidate", candidatePath, "--skill-selection", selectionPath, "--skill-score-run", scorePath,
			"--runs-dir", directory.join("runs"), "--run-id", "final-cli", "--dry-run"];
		expect(await main(args)).toBe(0);
		expect(chunks.join("")).toContain("tasks      48");
		expect(chunks.join("")).toContain("DRY RUN — nothing was executed.");
		await expect(fs.stat(directory.join("runs", "final-cli", "run.json"))).rejects.toThrow();

		const candidateVariant = record.variants.find(variant => variant.skillArm.kind === "candidate")!;
		const candidateResults = record.results.filter(result => result.cell.variant === candidateVariant.name);
		const originalId = candidateVariant.skillArm.id;
		for (const field of ["id", "skillName"] as const) {
			candidateVariant.skillArm = { ...candidateVariant.skillArm, [field]: "substituted" };
			for (const result of candidateResults) result.artifacts.extra.skillArm = { ...candidateVariant.skillArm };
			await fs.writeFile(scorePath, JSON.stringify(record));
			await expect(readScore()).rejects.toThrow("Run candidate arm does not match the frozen candidate artifact.");
			await expect(main(args)).rejects.toThrow("Run candidate arm does not match the frozen candidate artifact.");
			candidateVariant.skillArm = { ...candidateVariant.skillArm, id: originalId, skillName: full.skillName };
		}
	} finally {
		await directory.remove();
	}
}, 120_000);
