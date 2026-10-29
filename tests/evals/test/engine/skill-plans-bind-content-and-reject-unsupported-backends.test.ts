/**
 * WHY: A skill experiment must bind the resource actually used by each trial and refuse a
 * harness/backend pair that cannot honor that snapshot. Otherwise the run can claim an ablation
 * while silently running without the arm, or resume a journal under changed experiment inputs.
 *
 * This suite drives buildRunPlan, expandVariantMatrix and planIdentity. It covers frozen baseline,
 * full and ablation snapshots; task-major pairing order across repeats; skill/backend refusal; and
 * identity changes for resource content, recipe, model, build, registry and grader inputs.
 *
 * WHAT IT DOES NOT CATCH: whether a supported backend delivers each snapshot correctly during a
 * live trial. That belongs to the backend's execution tests.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import type { RunPlan } from "../../engine/contracts";
import { harnesses } from "../../engine/members/loaded";
import { buildRunPlan } from "../../engine/plan/run-plan";
import { expandVariantMatrix } from "../../engine/plan/variant-matrix";
import { planIdentity } from "../../engine/plan/plan-identity";
import { buildSkillArms } from "../../engine/skills/arms";
import { InProcessBackend } from "../../backends/in-process/main";
import { executeRun } from "../../engine/run/execute";
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
	tasks: taskIds,
	repeats: 2,
	runId: "skill-plan-test",
});


describe("skill-bound run plans", () => {
	it("retains frozen snapshots for baseline, full content and each ablation in paired task order", async () => {
		expect(arms.map(arm => arm.kind)).toEqual(["baseline", "full", "ablation", "ablation"]);
		const variants = expandVariantMatrix({ harnesses: ["veyyon"], models: [MODEL], skillArms: arms });
		expect(variants.map(variant => variant.skillArm)).toEqual(arms);
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
		expect(run.variants.map(variant => variant.skillArm)).toEqual(arms);
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
			suite: { ...suite, backend: "harbor" },
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
});
