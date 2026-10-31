/**
 * WHY: A skill experiment must bind the resource actually used by each trial and refuse a
 * harness/backend pair that cannot honor that snapshot. Otherwise the run can claim an ablation
 * while silently running without the arm, or resume a journal under changed experiment inputs.
 *
 * This suite drives buildRunPlan, expandVariantMatrix, planIdentity and executeRun. It covers
 * frozen resource snapshots, task-major pairing, unsupported execution, missing final declarations,
 * persistent final claims, lock exclusion, exact journal resume and refusals for changed run id,
 * run directory, repeats, or candidate.
 *
 * WHAT IT DOES NOT CATCH: provider-side model revision drift or real provider execution. The
 * final-use path uses a deterministic backend seam and makes no model calls; the TypeScript Edit
 * integration test separately exercises the real grader with a controlled client boundary.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import type { RunPlan } from "../../engine/plan/run-plan";
import { harnesses } from "../../engine/members/loaded";
import { buildRunPlan } from "../../engine/plan/run-plan";
import { canonicalizeConfig, expandVariantMatrix } from "../../engine/plan/variant-matrix";
import { planIdentity } from "../../engine/plan/plan-identity";
import { buildSkillArms } from "../../engine/skills/arms";
import { InProcessBackend } from "../../backends/in-process/main";
import { executeRun } from "../../engine/run/execute";
import { finalExecutionFingerprint, markFinalSkillSelectionVerified } from "../../engine/skills/final-use";
import type { FinalSkillUseDeclaration } from "../../engine/skills/final-use";
import { cacheDir } from "../../engine/package-paths";
import { TempDir } from "@veyyon/utils";
import { typescriptEditSuite } from "../../suites/typescript-edit/main";

const MODEL = "anthropic/claude-sonnet-4-6";
const content = "Opening notes.\nCOMPONENT ALPHA\nMiddle notes.\nCOMPONENT BETA\nClosing notes.";
const manifest = {
	version: 1 as const,
	skillName: "sample-skill",
	sourceHash: createHash("sha256").update(content, "utf8").digest("hex"),
	content,
	components: [
		{ name: "alpha", content: "COMPONENT ALPHA\n" },
		{ name: "beta", content: "COMPONENT BETA\n" },
	],
};
const arms = buildSkillArms(manifest);
const full = arms[1]!;

const suite = typescriptEditSuite;
const taskIds = ["access-remove-optional-chain-001", "call-swap-call-args-001"];
const plannedRun = buildRunPlan({
	suite,
	harnesses,
	selection: { harnesses: ["veyyon"], models: [MODEL], skillArms: arms },
	skillCriteria: { minimumImprovement: 0 },
	tasks: taskIds,
	repeats: 2,
	runId: "skill-plan-test",
});


describe("skill-bound run plans", () => {
	it("retains frozen snapshots for baseline, full content and each ablation in paired task order", async () => {
		expect(arms.map(arm => arm.kind)).toEqual(["baseline", "full", "ablation", "ablation"]);
		const variants = expandVariantMatrix({ harnesses: ["veyyon"], models: [MODEL], skillArms: arms });
		expect(variants.map(variant => variant.skillArm)).toEqual([...arms]);
		expect(variants.map(variant => variant.skillArm?.content)).toEqual([
			null,
			content,
			"Opening notes.\nMiddle notes.\nCOMPONENT BETA\nClosing notes.",
			"Opening notes.\nCOMPONENT ALPHA\nMiddle notes.\nClosing notes.",
		]);
		for (const variant of variants) {
			expect(Object.isFrozen(variant.skillArm)).toBe(true);
			expect(Object.isFrozen(variant.skillArm?.omittedComponents)).toBe(true);
		}

		const run = await plannedRun;
		const variantNames = run.variants.map(variant => variant.name);
		expect(run.cells.map(cell => [cell.task, cell.repeat, cell.variant])).toEqual([
			...variantNames.map(name => [taskIds[0], 1, name]),
			...variantNames.map(name => [taskIds[1], 1, name]),
			...variantNames.map(name => [taskIds[0], 2, name]),
			...variantNames.map(name => [taskIds[1], 2, name]),
		]);
		expect(run.tasks.map(task => task.id)).toEqual(taskIds);
		expect(run.variants.map(variant => variant.skillArm)).toEqual([...arms]);
		expect(run.skillBinding?.modelRevision).toBeNull();
	}, 180_000);

	it("refuses a non-veyyon harness instead of dropping its skill resource", async () => {
		const nonVeyyon = harnesses.ids().find(id => id !== "veyyon");
		expect(nonVeyyon).toBeDefined();
		await expect(buildRunPlan({
			suite,
			harnesses,
			selection: { harnesses: [nonVeyyon!], models: [MODEL], skillArms: arms },
		})).rejects.toThrow("Skill experiments require the veyyon in-process resource snapshot boundary");
	});

	it("refuses a backend outside the veyyon in-process boundary instead of dropping its skill resource", async () => {
		await expect(buildRunPlan({
			suite: {
				...suite,
				backend: "harbor",
				discoverTasks: suite.discoverTasks,
				describeTask: suite.describeTask,
				provenance: suite.provenance,
				scoreTrial: suite.scoreTrial,
				preflight: suite.preflight,
			},
			harnesses,
			selection: { harnesses: ["veyyon"], models: [MODEL], skillArms: arms },
		})).rejects.toThrow("Skill experiments require the veyyon in-process resource snapshot boundary");
	});

	it("changes plan identity when skill content, recipe, model, build, registry or grader hashes change", async () => {
		const original = await plannedRun;
		const identity = planIdentity(original);
		const changedContent = `${full!.content}Changed body.`;
		const changedArm = {
			...full!,
			content: changedContent,
			contentHash: createHash("sha256").update(changedContent, "utf8").digest("hex"),
		};
		const cases: RunPlan[] = [
			{ ...original, variants: original.variants.map(variant => variant.skillArm?.id === "full" ? { ...variant, skillArm: changedArm } : variant) },
			{ ...original, variants: original.variants.map(variant => variant.skillArm?.id === "full" ? { ...variant, skillArm: { ...variant.skillArm, recipeHash: "a".repeat(64) } } : variant) },
			{ ...original, variants: original.variants.map(variant => ({ ...variant, model: "anthropic/claude-opus-4-6" })) },
			{ ...original, variants: original.variants.map(variant => ({ ...variant, build: "/builds/changed" })) },
			{ ...original, skillBinding: { ...original.skillBinding!, buildHash: "d".repeat(64) } },
			{ ...original, skillBinding: { ...original.skillBinding!, registryHash: "b".repeat(64) } },
			{ ...original, skillBinding: { ...original.skillBinding!, graderHash: "c".repeat(64) } },
		];
		for (const changed of cases) expect(planIdentity(changed)).not.toBe(identity);
	});

	it("runs the real TypeScript Edit grader across baseline, full and ablation arms", async () => {
		const run = await plannedRun;
		const observed: Array<{ task: string; armId: string | null; content: string | null }> = [];
		const backend = new InProcessBackend({
			clientFactory: clientOptions => ({
				async start() {},
				async prompt() {
					const task = path.basename(path.dirname(clientOptions.cwd));
					observed.push({
						task,
						armId: clientOptions.skillArm?.id ?? null,
						content: clientOptions.skillArm?.content ?? null,
					});
					const descriptor = run.tasks.find(candidate => candidate.id === task);
					if (!descriptor) throw new Error(`Unknown fixture task: ${task}`);
					const expectedDir = descriptor.metadata.expectedDir as string;
					for (const file of descriptor.metadata.files as string[]) {
						const destination = path.join(clientOptions.cwd, file);
						await fs.mkdir(path.dirname(destination), { recursive: true });
						if (!clientOptions.skillArm || clientOptions.skillArm.content === null) {
							await fs.writeFile(destination, "export const incorrect = true;\n");
						} else {
							await fs.copyFile(path.join(expectedDir, file), destination);
						}
					}
				},
				async getSessionStats() {
					return { tokens: { input: 1, output: 1, total: 2 }, assistantMessages: 1, cost: 0 };
				},
				async getLastAssistantText() {
					return "Completed the fixture.";
				},
				async dispose() {},
			}),
		});
		const temp = await TempDir.create("@evals-skill-plan-execute-");
		try {
			const record = await executeRun({
				plan: run,
				backend,
				workDir: temp.path(),
				runsDir: temp.join("runs"),
				harnesses,
			});
			expect(record.results).toHaveLength(run.cells.length);
			expect(observed.map(item => [item.task, item.armId, item.content])).toEqual(
				run.cells.map(cell => {
					const arm = run.variants.find(variant => variant.name === cell.variant)?.skillArm;
					return [cell.task, arm?.id ?? null, arm?.content ?? null];
				}),
			);
			for (const result of record.results) {
				const arm = run.variants.find(variant => variant.name === result.cell.variant)?.skillArm;
				expect(result.score.error).toBeNull();
				expect(result.score.reward).toBe(arm?.content === null ? 0 : 1);
			}
		} finally {
			await temp.remove();
		}
	}, 180_000);
	it("omits cancelled skill trials from the journal and reruns them on resume", async () => {
		const base = await plannedRun;
		const temp = await TempDir.create("@evals-skill-cancel-resume-");
		const task = base.tasks[0]!;
		const variant = base.variants[0]!;
		const suiteForRun = {
			...base.suite,
			async preflight() {
				return { ok: true };
			},
			async scoreTrial() {
				return { reward: 1, partial: 1, error: null, usage: null, extra: {} };
			},
			writeRunReport: undefined,
		};
		const plan: RunPlan = {
			...base,
			runId: `skill-cancel-${process.pid}-${Date.now()}`,
			suite: suiteForRun,
			variants: [variant],
			tasks: [task],
			cells: [{ variant: variant.name, suite: base.suite.id, task: task.id, repeat: 1 }],
			repeats: 1,
			skillPhase: "pilot",
		};
		const controller = new AbortController();
		let firstCalls = 0;
		let resumedCalls = 0;
		let cleanups = 0;
		const cancelledBackend = {
			id: "in-process" as const,
			appliesVariantAxes: [] as const,
			async preflight() {
				return { ok: true };
			},
			async prepare() {},
			async runTrial() {
				firstCalls++;
				controller.abort();
				return { extra: { cancelled: true, error: "aborted" } };
			},
			async cleanup() {
				cleanups++;
			},
		};
		const runsDir = temp.join("runs");
		try {
			const cancelled = await executeRun({
				plan,
				backend: cancelledBackend,
				workDir: temp.path(),
				runsDir,
				harnesses,
				signal: controller.signal,
			});
			expect(firstCalls).toBe(1);
			expect(cleanups).toBe(1);
			expect(cancelled.results).toHaveLength(0);
			expect(cancelled.metadata).toMatchObject({ skillPhase: "pilot", cancelled: true });
			const resumed = await executeRun({
				plan,
				backend: {
					...cancelledBackend,
					async runTrial() {
						resumedCalls++;
						return { extra: { cancelled: false } };
					},
				},
				workDir: temp.path(),
				runsDir,
				harnesses,
				resume: true,
			});
			expect(resumedCalls).toBe(1);
			expect(resumed.results).toHaveLength(1);
			expect(resumed.metadata).toMatchObject({ skillPhase: "pilot", cancelled: false });
		} finally {
			await temp.remove();
		}
	}, 180_000);
	it("requires an engine-owned final-use claim and permits only exact journal resume", async () => {
		const base = await plannedRun;
		const temp = await TempDir.create("@evals-skill-final-use-");
		const task = base.tasks[0]!;
		const candidateContent = "Candidate skill content.";
		const candidateHash = createHash("sha256").update(candidateContent, "utf8").digest("hex");
		const candidateArm = Object.freeze({
			id: `candidate-${candidateHash.slice(0, 12)}`,
			kind: "candidate" as const,
			skillName: full!.skillName,
			content: candidateContent,
			contentHash: candidateHash,
			sourceHash: full!.sourceHash,
			omittedComponents: Object.freeze([] as string[]),
			recipeHash: candidateHash,
		});
		const selectedVariant = Object.freeze({ ...base.variants[0]!, name: "candidate", skillArm: candidateArm });
		const suiteForFinal = {
			...base.suite,
			async preflight() {
				return { ok: true };
			},
			async scoreTrial() {
				return { reward: 1, partial: 1, error: null, usage: null, extra: {} };
			},
			writeRunReport: undefined,
		};
		const plan: RunPlan = {
			...base,
			runId: `skill-final-${process.pid}-${Date.now()}`,
			suite: suiteForFinal,
			variants: [selectedVariant],
			tasks: [task],
			cells: [{ variant: selectedVariant.name, suite: base.suite.id, task: task.id, repeat: 1 }],
			repeats: 1,
			skillPhase: "final",
		};
		const planBinding = plan.skillBinding!;
		const suiteIdentity = planBinding.suiteIdentity;
		const candidateBinding = {
			version: 1 as const,
			sourceHash: full!.sourceHash,
			datasetFingerprint: createHash("sha256")
				.update(canonicalizeConfig({ suite: suiteIdentity.suite, version: suiteIdentity.version, sha: suiteIdentity.sha }))
				.digest("hex"),
			splitFingerprint: createHash("sha256")
				.update(canonicalizeConfig({ seed: "test-seed", taskIds: [task.id], membership: { feedback: [], score: [], final: [task.id] } }))
				.digest("hex"),
			criteriaHash: planBinding.criteriaHash!,
			minimumImprovement: 0,
			buildHash: planBinding.buildHash,
			registryHash: planBinding.registryHash,
			graderHash: planBinding.graderHash,
			suiteIdentity,
			requestedModels: planBinding.requestedModels,
			resolvedModel: { provider: "anthropic", id: "claude-sonnet-4-6", version: "test-revision" },
		};
		const candidate = {
			candidateHash,
			sourceHash: full!.sourceHash,
			resolvedModel: candidateBinding.resolvedModel,
			binding: candidateBinding,
		};
		const selection = Object.freeze({
			winner: "candidate" as const,
			candidateHash,
			sourceHash: full!.sourceHash,
			binding: candidateBinding,
			scoreRunHash: "e".repeat(64),
			minimumImprovement: 0,
			score: Object.freeze({ selected: candidateHash, reason: "candidate-improved", incumbentMean: 0, candidateMean: 1 }),
		});
		const runsDir = temp.join("runs");
		const claimIdentity = {
			sourceHash: candidateBinding.sourceHash,
			datasetFingerprint: candidateBinding.datasetFingerprint,
			splitFingerprint: candidateBinding.splitFingerprint,
			model: "anthropic/claude-sonnet-4-6@test-revision",
			harness: selectedVariant.harness,
			grader: candidateBinding.graderHash,
		};
		const declarationFor = (
			activePlan: RunPlan,
			activeRunsDir: string,
			activeCandidate: FinalSkillUseDeclaration["candidate"] = candidate,
			activeSelection: FinalSkillUseDeclaration["selection"] = selection,
			resume = false,
			identity = claimIdentity,
		): FinalSkillUseDeclaration => ({
			identity,
			candidate: activeCandidate,
			selection: activeSelection,
			executionFingerprint: finalExecutionFingerprint({
				planIdentity: planIdentity(activePlan),
				runId: activePlan.runId,
				runsDir: activeRunsDir,
				tasks: activePlan.tasks.map(item => item.id),
				repeats: activePlan.repeats,
				cells: activePlan.cells,
				options: {},
				jobs: 1,
			}),
			resume,
		});
		let started = 0;
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const backend = {
			id: "in-process" as const,
			appliesVariantAxes: [] as const,
			async preflight() {
				return { ok: true };
			},
			async prepare() {},
			async runTrial() {
				started++;
				entered.resolve();
				await gate.promise;
				return {
					extra: {
						resolvedModel: candidate.resolvedModel,
						skillArm: { id: candidateArm.id, kind: "candidate", contentHash: candidateHash, sourceHash: full!.sourceHash, recipeHash: candidateHash },
						observedSkillHashes: [{ name: full!.skillName, contentHash: candidateHash }],
					},
				};
			},
			async cleanup() {},
		};
		const common = { plan, backend, workDir: temp.path(), runsDir, harnesses };
		const incompatibleCalls = { preflight: 0, prepare: 0, trial: 0 };
		const incompatibleBackend = {
			...backend,
			id: "container" as const,
			async preflight() {
				incompatibleCalls.preflight++;
				return { ok: true };
			},
			async prepare() {
				incompatibleCalls.prepare++;
			},
			async runTrial() {
				incompatibleCalls.trial++;
				return {};
			},
		};
		await expect(
			executeRun({
				...common,
				plan: { ...plan, skillPhase: "pilot" },
				runsDir: temp.join("unsupported-backend"),
				backend: incompatibleBackend,
			}),
		).rejects.toThrow(/Skill experiments require the veyyon in-process resource snapshot boundary/);
		expect(incompatibleCalls).toEqual({ preflight: 0, prepare: 0, trial: 0 });
		const cacheClaimPath = path.join(
			cacheDir(),
			"skill-final-claims",
			`${createHash("sha256").update(canonicalizeConfig(claimIdentity)).digest("hex")}.json`,
		);
		let incumbentClaimPath: string | null = null;
		try {
			await expect(executeRun(common)).rejects.toThrow(/requires a frozen candidate-use declaration/);
			await expect(
				executeRun({ ...common, finalSkillUse: declarationFor(plan, runsDir) }),
			).rejects.toThrow(/verified frozen score selection/);
			expect(started).toBe(0);
			markFinalSkillSelectionVerified(selection);
			const firstExecution = executeRun({ ...common, finalSkillUse: declarationFor(plan, runsDir) });
			await Promise.race([
				entered.promise,
				firstExecution.then(() => {
					throw new Error("Final run completed before its backend entered a trial.");
				}),
			]);
			expect(started).toBe(1);
			await expect(
				executeRun({ ...common, finalSkillUse: declarationFor(plan, runsDir, candidate, selection, true), resume: true }),
			).rejects.toThrow(/already executing/);
			gate.resolve();
			const record = await firstExecution;
			expect(record.results).toHaveLength(1);
			await executeRun({
				...common,
				finalSkillUse: declarationFor(plan, runsDir, candidate, selection, true),
				resume: true,
				onSkip(skipped) {
					expect(skipped).toBe(1);
				},
			});
			expect(started).toBe(1);

			const changedPlan = { ...plan, runId: `${plan.runId}-changed` };
			await expect(
				executeRun({
					...common,
					plan: changedPlan,
					finalSkillUse: declarationFor(changedPlan, runsDir, candidate, selection, true),
					resume: true,
				}),
			).rejects.toThrow();
			const changedRunsDir = temp.join("different-runs");
			await expect(
				executeRun({
					...common,
					runsDir: changedRunsDir,
					finalSkillUse: declarationFor(plan, changedRunsDir, candidate, selection, true),
					resume: true,
				}),
			).rejects.toThrow();
			const repeatedPlan: RunPlan = {
				...plan,
				repeats: 2,
				cells: [
					plan.cells[0]!,
					{ ...plan.cells[0]!, repeat: 2 },
				],
			};
			await expect(
				executeRun({
					...common,
					plan: repeatedPlan,
					finalSkillUse: declarationFor(repeatedPlan, runsDir, candidate, selection, true),
					resume: true,
				}),
			).rejects.toThrow();
			const replacementHash = "c".repeat(64);
			const replacementCandidate = { ...candidate, candidateHash: replacementHash };
			const replacementArm = { ...candidateArm, id: `candidate-${replacementHash.slice(0, 12)}`, content: "Different candidate.", contentHash: replacementHash, recipeHash: replacementHash };
			const replacementVariant = { ...selectedVariant, skillArm: replacementArm };
			const replacementPlan = { ...plan, variants: [replacementVariant] };
			const replacementSelection = Object.freeze({
				...selection,
				candidateHash: replacementHash,
				score: Object.freeze({ ...selection.score, selected: replacementHash }),
			});
			markFinalSkillSelectionVerified(replacementSelection);
			await expect(
				executeRun({
					...common,
					plan: replacementPlan,
					finalSkillUse: declarationFor(replacementPlan, runsDir, replacementCandidate, replacementSelection, true),
					resume: true,
				}),
			).rejects.toThrow();
			const incumbentVariantBase = base.variants.find(variant => variant.skillArm?.kind === "full")!;
			const incumbentVariant = Object.freeze({ ...incumbentVariantBase, name: "incumbent" });
			const incumbentPlan: RunPlan = {
				...plan,
				runId: `${plan.runId}-incumbent`,
				variants: [incumbentVariant],
				cells: [{ ...plan.cells[0]!, variant: incumbentVariant.name }],
			};
			const incumbentBinding = {
				...candidateBinding,
				datasetFingerprint: "d".repeat(64),
				splitFingerprint: "f".repeat(64),
				resolvedModel: { provider: "anthropic", id: "claude-sonnet-4-6", version: null },
			};
			const incumbentCandidate = {
				...candidate,
				resolvedModel: { provider: "anthropic", id: "claude-sonnet-4-6", version: null },
				binding: incumbentBinding,
			};
			const incumbentSelection = Object.freeze({
				winner: "incumbent" as const,
				candidateHash,
				sourceHash: full!.sourceHash,
				binding: incumbentBinding,
				scoreRunHash: "a".repeat(64),
				minimumImprovement: 0,
				score: Object.freeze({
					selected: "incumbent",
					reason: "unknown-model-revision",
					incumbentMean: 0,
					candidateMean: 1,
				}),
			});
			markFinalSkillSelectionVerified(incumbentSelection);
			const incumbentIdentity = {
				...claimIdentity,
				model: "anthropic/claude-sonnet-4-6@unknown",
				datasetFingerprint: incumbentBinding.datasetFingerprint,
				splitFingerprint: incumbentBinding.splitFingerprint,
			};
			incumbentClaimPath = path.join(
				cacheDir(),
				"skill-final-claims",
				`${createHash("sha256").update(canonicalizeConfig(incumbentIdentity)).digest("hex")}.json`,
			);
			const incumbentRecord = await executeRun({
				...common,
				plan: incumbentPlan,
				backend: {
					...backend,
					async runTrial() {
						started++;
						return {
							extra: {
								resolvedModel: incumbentCandidate.resolvedModel,
								skillArm: {
									id: full!.id,
									kind: "full",
									contentHash: full!.contentHash,
									sourceHash: full!.sourceHash,
									recipeHash: full!.recipeHash,
								},
								observedSkillHashes: [{ name: full!.skillName, contentHash: full!.contentHash }],
							},
						};
					},
				},
				finalSkillUse: declarationFor(
					incumbentPlan,
					runsDir,
					incumbentCandidate,
					incumbentSelection,
					false,
					incumbentIdentity,
				),
			});
			expect(incumbentRecord.results).toHaveLength(1);
			expect(incumbentRecord.variants[0]?.skillArm?.kind).toBe("full");
			expect(started).toBe(2);
		} finally {
			gate.resolve();
			await fs.rm(cacheClaimPath, { force: true });
			await fs.rm(`${cacheClaimPath}.lock`, { force: true });
			if (incumbentClaimPath !== null) {
				await fs.rm(incumbentClaimPath, { force: true });
				await fs.rm(`${incumbentClaimPath}.lock`, { force: true });
			}
			await temp.remove();
		}
	}, 180_000);
});
