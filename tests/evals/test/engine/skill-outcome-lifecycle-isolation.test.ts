/**
 * WHY: Candidate cutover must remain tied to score data and a criterion fixed before outcomes.
 * The reader rechecks saved means, winner, candidate hash, score-run receipt, and threshold.
 *
 * WHAT IT DOES NOT CATCH: A person with write access can alter both a local run record and its
 * selection receipt. These artifacts are trusted local records, not cryptographic signatures.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFinalSkillRunLock, buildFeedbackOnlyPrompt, claimFinalSkillUse, createCandidateSourceBinding, createSkillSelection, readFrozenSkillSelection, selectSkillCandidate } from "../../engine/skills/lifecycle";
import type { SkillCandidateArtifact, SkillScoreOutcome } from "../../engine/skills/lifecycle";
import type { TaskDescriptor } from "../../engine/contracts";
import { splitTasks } from "../../engine/task-splits";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

function taskSet(): TaskDescriptor[] {
	return Array.from({ length: 100 }, (_, index) => ({
		id: `task-${index}`,
		path: null,
		timeBudgetSec: 60,
		instructionPath: null,
		metadata: {},
	}));
}

const criteria = { minimumImprovement: 0, hash: "predeclared-criteria" };

function sourceBinding(
	tasks: readonly TaskDescriptor[],
	sourceHash: string,
	version: string | null = "v1",
	archivePath = "/fixture/corpus.tar",
	cohortSize: 80 | 100 = 100,
) {
	return createCandidateSourceBinding(
		{
			version: 1,
			cohortSize,
			buildHash: "build",
			registryHash: "registry",
			graderHash: "grader",
			criteriaHash: criteria.hash,
			suiteIdentity: { suite: "example", version: "1", sha: "verified-corpus-sha", metadata: { archivePath, touchedAt: archivePath } },
			requestedModels: ["provider/model"],
		},
		tasks,
		sourceHash,
		criteria,
		"seed",
		{ provider: "provider", id: "model", version },
		cohortSize,
	);
}

function candidate(tasks: readonly TaskDescriptor[], version: string | null = "v1"): SkillCandidateArtifact {
	const sourceHash = "a".repeat(64);
	return {
		version: 1,
		kind: "veyyon-skill-candidate",
		skillName: "example",
		sourceHash,
		candidateHash: "b".repeat(64),
		content: "candidate",
		model: "provider/model",
		splitSeed: "seed",
		feedbackTaskIds: splitTasks(tasks, "seed").feedback.map(task => task.id),
		createdAt: "2026-10-29T00:00:00.000Z",
		binding: sourceBinding(tasks, sourceHash, version),
		resolvedModel: { provider: "provider", id: "model", version },
	};
}

describe("skill outcome lifecycle", () => {
	it("builds revision requests from feedback tasks only", () => {
		const tasks = taskSet();
		const split = splitTasks(tasks, "seed");
		const source = 'const x = "<tag>&";';
		const feedback = 'assertion failed: <tag>&';
		const outcomes = split.feedback.map(task => ({ taskId: task.id, reward: 0, feedback }));
		const prompt = buildFeedbackOnlyPrompt({
			skillName: "example",
			content: source,
			tasks,
			splitSeed: "seed",
			outcomes,
		});
		const promptTaskIds = [...prompt.matchAll(/"taskId":"([^"]+)"/g)].map(match => match[1]);
		expect(promptTaskIds).toEqual(split.feedback.map(task => task.id));
		expect(prompt).toContain(source);
		expect(prompt).toContain(feedback);
		expect(() =>
			buildFeedbackOnlyPrompt({
				skillName: "example",
				content: "skill text",
				tasks,
				splitSeed: "seed",
				outcomes: [...outcomes, { taskId: split.final[0]!.id, reward: 0, feedback: "holdout" }],
			}),
		).toThrow(/feedback tasks only/);
	});

	it("keeps lineage stable across descriptor order and corpus location metadata", () => {
		const tasks = taskSet();
		const sourceHash = "a".repeat(64);
		const original = sourceBinding(tasks, sourceHash, "v1", "/fixture/original.tar");
		const copied = sourceBinding([...tasks].reverse(), sourceHash, "v1", "/fixture/copied.tar");
		expect(copied.datasetFingerprint).toBe(original.datasetFingerprint);
		expect(copied.splitFingerprint).toBe(original.splitFingerprint);
	});

	it("binds the declared 80-task cohort separately from the default 100-task split", () => {
		const sourceHash = "a".repeat(64);
		const eightyTasks = taskSet().slice(0, 80);
		const eighty = sourceBinding(eightyTasks, sourceHash, "v1", "/fixture/corpus.tar", 80);
		const hundred = sourceBinding(taskSet(), sourceHash);
		const split = splitTasks(eightyTasks, "seed", eighty.cohortSize);
		expect(eighty.cohortSize).toBe(80);
		expect(eighty.splitFingerprint).not.toBe(hundred.splitFingerprint);
		expect([split.feedback.length, split.score.length, split.final.length]).toEqual([16, 16, 48]);
		expect(() =>
			selectSkillCandidate({
				tasks: taskSet(),
				splitSeed: "seed",
				outcomes: [],
				candidate: { ...candidate(taskSet()), binding: eighty },
				sourceHash,
				binding: hundred,
			}),
		).toThrow(/does not match/);
	});
	it("uses only complete score outcomes and retains incumbent on incomplete or tied data", () => {
		const tasks = taskSet();
		const score = splitTasks(tasks, "seed").score;
		const outcomes: SkillScoreOutcome[] = score.map(task => ({
			taskId: task.id,
			incumbentReward: 0.5,
			candidateReward: 0.6,
		}));
		const winner = selectSkillCandidate({
			tasks,
			splitSeed: "seed",
			outcomes,
			candidate: candidate(tasks),
			sourceHash: "a".repeat(64),
			binding: candidate(tasks).binding,
		});
		expect(winner.selected).toBe("b".repeat(64));
		const incomplete = selectSkillCandidate({
			tasks,
			splitSeed: "seed",
			outcomes: outcomes.slice(1),
			candidate: candidate(tasks),
			sourceHash: "a".repeat(64),
			binding: candidate(tasks).binding,
		});
		expect(incomplete).toEqual({
			selected: "incumbent",
			reason: "incomplete-score-data",
			incumbentMean: null,
			candidateMean: null,
		});
		const tied = selectSkillCandidate({
			tasks,
			splitSeed: "seed",
			outcomes: outcomes.map(row => ({ ...row, candidateReward: row.incumbentReward })),
			candidate: candidate(tasks),
			binding: candidate(tasks).binding,
			sourceHash: "a".repeat(64),
		});
		expect(tied.selected).toBe("incumbent");
		const unknownRevision = selectSkillCandidate({
			tasks,
			splitSeed: "seed",
			outcomes,
			candidate: candidate(tasks, null),
			sourceHash: "a".repeat(64),
			binding: candidate(tasks, null).binding,
		});
		expect(unknownRevision).toMatchObject({ selected: "incumbent", reason: "unknown-model-revision" });
	});

	it("freezes the predeclared score criterion and binds selection to the verified score-run hash", async () => {
		const tasks = taskSet();
		const base = candidate(tasks);
		const binding = Object.freeze({
			...base.binding,
			minimumImprovement: 0.2,
			criteriaHash: "frozen-criteria-hash",
		});
		const frozenCandidate = { ...base, binding };
		const outcomes = splitTasks(tasks, "seed").score.map(task => ({
			taskId: task.id,
			incumbentReward: 0.5,
			candidateReward: 0.6,
		}));
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-selection-"));
		temporaryDirectories.push(directory);
		const outputPath = path.join(directory, "selection.json");
		const scoreRunHash = "c".repeat(64);
		const selection = await createSkillSelection({
			tasks,
			splitSeed: "seed",
			outcomes,
			candidate: frozenCandidate,
			sourceHash: base.sourceHash,
			binding,
			scoreRunHash,
			outputPath,
		});
		const verified = await readFrozenSkillSelection(
			outputPath,
			frozenCandidate,
			base.sourceHash,
			"seed",
			tasks,
			outcomes,
			splitTasks(tasks, "seed").score.map(task => task.id),
			binding,
			scoreRunHash,
		);
		expect(selection.winner).toBe("incumbent");
		expect(verified.scoreRunHash).toBe(scoreRunHash);
		expect(verified.minimumImprovement).toBe(0.2);
		expect(Object.isFrozen(verified)).toBe(true);

		const tamperedPath = path.join(directory, "tampered-selection.json");
		await fs.writeFile(tamperedPath, JSON.stringify({ ...selection, minimumImprovement: 0.01 }), "utf8");
		await expect(
			readFrozenSkillSelection(
				tamperedPath,
				frozenCandidate,
				base.sourceHash,
				"seed",
				tasks,
				outcomes,
				splitTasks(tasks, "seed").score.map(task => task.id),
				binding,
				scoreRunHash,
			),
		).rejects.toThrow(/verified frozen score selection/);

		const alteredOutcomePath = path.join(directory, "altered-outcomes.json");
		await fs.writeFile(
			alteredOutcomePath,
			JSON.stringify({ ...selection, score: { ...selection.score, candidateMean: 0.8 } }),
			"utf8",
		);
		await expect(
			readFrozenSkillSelection(
				alteredOutcomePath,
				frozenCandidate,
				base.sourceHash,
				"seed",
				tasks,
				outcomes,
				splitTasks(tasks, "seed").score.map(task => task.id),
				binding,
				scoreRunHash,
			),
		).rejects.toThrow(/does not match the verified score-run outcomes/);
		const unknownBase = candidate(tasks, null);
		const unknownBinding = Object.freeze({
			...unknownBase.binding,
			minimumImprovement: 0.2,
			criteriaHash: "frozen-criteria-hash",
		});
		const unknownCandidate = { ...unknownBase, binding: unknownBinding };
		const unknownPath = path.join(directory, "unknown-revision-selection.json");
		const unknownSelection = await createSkillSelection({
			tasks,
			splitSeed: "seed",
			outcomes,
			candidate: unknownCandidate,
			sourceHash: unknownBase.sourceHash,
			binding: unknownBinding,
			scoreRunHash,
			outputPath: unknownPath,
		});
		const verifiedUnknown = await readFrozenSkillSelection(
			unknownPath,
			unknownCandidate,
			unknownBase.sourceHash,
			"seed",
			tasks,
			outcomes,
			splitTasks(tasks, "seed").score.map(task => task.id),
			unknownBinding,
			scoreRunHash,
		);
		expect(verifiedUnknown).toMatchObject({ winner: "incumbent", score: { reason: "unknown-model-revision" } });
		const forgedPromotionPath = path.join(directory, "unknown-revision-promotion.json");
		await fs.writeFile(
			forgedPromotionPath,
			JSON.stringify({
				...unknownSelection,
				winner: "candidate",
				score: {
					selected: unknownCandidate.candidateHash,
					reason: "candidate-improved",
					incumbentMean: 0.5,
					candidateMean: 0.8,
				},
			}),
			"utf8",
		);
		await expect(
			readFrozenSkillSelection(
				forgedPromotionPath,
				unknownCandidate,
				unknownBase.sourceHash,
				"seed",
				tasks,
				outcomes,
				splitTasks(tasks, "seed").score.map(task => task.id),
				unknownBinding,
				scoreRunHash,
			),
		).rejects.toThrow(/verified frozen score selection/);
	});

	it("persists a canonical final-use claim across restart and excludes concurrent callers", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-final-claim-"));
		temporaryDirectories.push(directory);
		const identity = {
			sourceHash: "source",
			datasetFingerprint: "dataset",
			splitFingerprint: "split",
			model: "provider/model@revision",
			harness: "veyyon",
			grader: "verifier-v1",
		};
		const details = { candidateHash: "candidate-a", executionFingerprint: "plan-a" };
		const results = await Promise.allSettled([
			claimFinalSkillUse(directory, identity, details),
			claimFinalSkillUse(directory, identity, details),
		]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
		const claimPath = results.find(result => result.status === "fulfilled")?.value;
		if (claimPath === undefined) throw new Error("The concurrent final-use claim did not persist.");
		const reorderedIdentity = {
			grader: identity.grader,
			harness: identity.harness,
			model: identity.model,
			splitFingerprint: identity.splitFingerprint,
			datasetFingerprint: identity.datasetFingerprint,
			sourceHash: identity.sourceHash,
		};
		await expect(claimFinalSkillUse(directory, reorderedIdentity, details)).rejects.toThrow();
		await expect(
			claimFinalSkillUse(directory, identity, { ...details, candidateHash: "candidate-b", resume: true }),
		).rejects.toThrow();
		await expect(claimFinalSkillUse(directory, identity, { ...details, executionFingerprint: "changed", resume: true })).rejects.toThrow();
		await expect(claimFinalSkillUse(directory, reorderedIdentity, { ...details, resume: true })).resolves.toBe(claimPath);
		const release = await acquireFinalSkillRunLock(claimPath!, details.executionFingerprint);
		await expect(acquireFinalSkillRunLock(claimPath!, details.executionFingerprint)).rejects.toThrow(/already executing/);
		await release();
		const resumedRelease = await acquireFinalSkillRunLock(claimPath!, details.executionFingerprint);
		await resumedRelease();
		const files = await fs.readdir(directory);
		expect(files.filter(file => file.endsWith(".json"))).toHaveLength(1);
	});

	it("serializes concurrent recovery of a stale final-use lock", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "skill-stale-lock-"));
		temporaryDirectories.push(directory);
		const claimPath = await claimFinalSkillUse(
			directory,
			{
				sourceHash: "source",
				datasetFingerprint: "dataset",
				splitFingerprint: "split",
				model: "provider/model@unknown",
				harness: "veyyon",
				grader: "verifier-v1",
			},
			{ candidateHash: "candidate", executionFingerprint: "frozen-plan" },
		);
		const lockPath = `${claimPath}.lock`;
		await fs.writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, executionFingerprint: "frozen-plan" }), "utf8");
		const attempts = await Promise.allSettled([
			acquireFinalSkillRunLock(claimPath, "frozen-plan"),
			acquireFinalSkillRunLock(claimPath, "frozen-plan"),
		]);
		expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
		const acquired = attempts.find(result => result.status === "fulfilled");
		if (!acquired || acquired.status !== "fulfilled") throw new Error("No final-use lock recovery succeeded.");
		await acquired.value();
		await expect(fs.stat(`${lockPath}.recovery`)).rejects.toThrow();
	});
});
