import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { EvalSuite, Variant } from "../../engine/contracts";
import { writeRunOutput } from "../../engine/run/output";
import type { EvalRunRecord } from "../../engine/run/record";
import { buildSkillArms } from "../../engine/skills/arms";
import {
	assessSkillStaleness,
	createSkillExperimentReport,
	SKILL_EXPERIMENT_REPORT_FILE,
} from "../../engine/skills/report";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
const content = "whole content";
const sourceHash = createHash("sha256").update(content, "utf8").digest("hex");
const [baseline, full] = buildSkillArms({
	version: 1,
	skillName: "sample",
	sourceHash,
	content,
	components: [{ name: "part", content: "whole" }],
});

function variant(
	name: string,
	model: string,
	skillArm: NonNullable<typeof baseline>,
	overrides: Partial<Variant> = {},
): Variant {
	return {
		name,
		harness: "harness-a",
		configPath: null,
		promptVariantPath: null,
		model,
		attachments: [],
		skillArm,
		...overrides,
	};
}

function record(
	results: EvalRunRecord["results"],
	models: readonly string[] = ["model-a", "model-a"],
	repeats = 1,
): EvalRunRecord {
	return {
		id: "run-1",
		suite: { name: "suite", version: "1" },
		variants: [variant("base", models[0]!, baseline!), variant("full", models[1]!, full!)],
		tasks: ["task-1"],
		repeats,
		results,
		createdAt: "2026-10-29T00:00:00.000Z",
		metadata: {
			skillBinding: {
				version: 1,
				buildHash: "build-a",
				registryHash: "registry-a",
				graderHash: "grader-a",
				suiteIdentity: { suite: "suite", version: "1" },
				requestedModels: [...new Set(models)].sort(),
				modelRevision: null,
				armFingerprint: "fingerprint-a",
			},
		},
	};
}

function result(
	variantName: string,
	reward: number | null,
	error: string | null = null,
	repeat = 1,
	extra: Record<string, unknown> = {},
) {
	return {
		cell: { variant: variantName, suite: "suite", task: "task-1", repeat },
		score: { reward, partial: null, error, usage: null, extra: {} },
		artifacts: { extra },
	};
}

describe("skill experiment report evidence", () => {
	// WHY: this suite closes repeat indexing, partial-reward grading and cross-binding pair leakage.
	// Its gap is backend-specific evidence semantics beyond the public run record and binding fields.
	it("counts missing repeats from one and excludes partial credit from wins", () => {
		const report = createSkillExperimentReport(
			record(
				[
					result("base", 0, null, 1),
					result("full", 1, null, 1),
					result("base", 0, null, 2),
					result("full", 0.5, null, 2),
				],
				["model-a", "model-a"],
				2,
			),
		)!;
		expect(report.groups[0]?.outcomes.baseline?.missing).toBe(0);
		expect(report.groups[0]?.outcomes.full?.missing).toBe(0);
		expect(report.groups[0]?.outcomes.full?.scored).toBe(2);
		expect(report.groups[0]?.pairs[0]?.pairs).toBe(2);
		expect(report.groups[0]?.pairs[0]?.wins).toBe(1);
		expect(report.groups[0]?.pairs[0]?.bothFailed).toBe(1);
		const missingRepeat = createSkillExperimentReport(
			record([result("base", 0), result("full", 1)], ["model-a", "model-a"], 2),
		)!;
		expect(missingRepeat.groups[0]?.outcomes.baseline?.missing).toBe(1);
		expect(missingRepeat.groups[0]?.outcomes.full?.missing).toBe(1);
	});
	it("pairs full against candidate in score runs without treating unpaired outcomes as wins", () => {
		const candidate = { ...full!, id: "candidate", kind: "candidate" as const };
		const scoreRecord = {
			...record(
				[
					result("full", 0),
					result("candidate", 1),
					result("full", 0, null, 2),
					result("candidate", 1, "backend failed", 2),
				],
				["model-a", "model-a"],
				2,
			),
			variants: [variant("full", "model-a", full!), variant("candidate", "model-a", candidate)],
		};
		const report = createSkillExperimentReport(scoreRecord)!;
		expect(report.groups[0]?.pairs[0]).toMatchObject({
			baseline: full!.id,
			candidate: candidate.id,
			pairs: 1,
			wins: 1,
			losses: 0,
		});
		expect(report.groups[0]?.outcomes.candidate?.infrastructureErrors).toBe(1);
	});

	it("does not pair score variants across task/repeat mismatches", () => {
		const candidate = { ...full!, id: "candidate", kind: "candidate" as const };
		const run = record([result("full", 0), result("candidate", 1)], ["model-a", "model-a"]);
		const report = createSkillExperimentReport({
			...run,
			variants: [variant("full", "model-a", full!), variant("candidate", "model-a", candidate)],
			results: [
				result("full", 0, null, 1),
				{
					...result("candidate", 1, null, 1),
					cell: { variant: "candidate", suite: "suite", task: "task-other", repeat: 1 },
				},
			],
		})!;
		expect(report.groups[0]?.pairs[0]?.pairs).toBe(0);
		expect(report.groups[0]?.pairs[0]?.wins).toBe(0);
	});

	it("does not pair variants across different config, model, harness, build, or attachment groups", () => {
		for (const overrides of [
			{ configPath: "config-b" },
			{ model: "model-b" },
			{ harness: "harness-b" },
			{ build: "build-b" },
			{ attachments: ["attachment-b"] },
		]) {
			const run = record([result("base", 0), result("full", 1)]);
			const changedVariants = [...run.variants];
			changedVariants[1] = { ...changedVariants[1]!, ...overrides };
			const report = createSkillExperimentReport({ ...run, variants: changedVariants })!;
			expect(report.groups).toHaveLength(2);
			expect(report.groups.every(group => group.pairs.length === 0)).toBe(true);
		}
	});

	it("compares only provided bindings and requires a known upstream revision", () => {
		expect(
			assessSkillStaleness(
				{ armFingerprint: "arm-a", buildHash: "build-a", requestedModels: ["model-a"], modelRevision: null },
				{ armFingerprint: "arm-b", buildHash: "build-b", requestedModels: ["model-b"], modelRevision: null },
			),
		).toEqual({
			status: "stale",
			changed: ["armFingerprint", "buildHash", "requestedModels"],
			unknown: ["modelRevision"],
		});
		expect(assessSkillStaleness({ buildHash: "build-a" }, { buildHash: "build-a" })).toEqual({
			status: "unverified",
			changed: [],
			unknown: ["revision"],
		});
		expect(
			assessSkillStaleness(
				{ sourceHash: "source-a", contentHash: "content-a", model: "model-a", revision: "" },
				{ sourceHash: "source-b", contentHash: "content-a", model: "model-b", revision: null },
			),
		).toEqual({ status: "stale", changed: ["sourceHash", "model"], unknown: ["revision"] });
	});
	it("distinguishes changed, unknown, and canonically equal bindings", () => {
		expect(assessSkillStaleness({ revision: "rev-a" }, { revision: null })).toEqual({
			status: "stale",
			changed: ["revision"],
			unknown: ["revision"],
		});
		expect(assessSkillStaleness({ revision: null }, { revision: null })).toEqual({
			status: "unverified",
			changed: [],
			unknown: ["revision"],
		});
		expect(assessSkillStaleness({ revision: "rev-a" }, {})).toEqual({
			status: "unverified",
			changed: [],
			unknown: ["revision"],
		});
		expect(
			assessSkillStaleness(
				{ suiteIdentity: { suite: "suite-a", version: "1" }, revision: "rev-a" },
				{ suiteIdentity: { version: "1", suite: "suite-a" }, revision: "rev-a" },
			),
		).toEqual({ status: "current", changed: [], unknown: [] });
	});

	it("preserves outcome kinds, resource observations, and zero-work Not run status", () => {
		const report = createSkillExperimentReport(
			record([
				result("base", 0),
				result("full", null, "backend failed", 1, { turns: 3, resource: { hash: "resource-a" } }),
				result("base", null, null, 1, { cancelled: true }),
				result("full", null),
			]),
		)!;
		expect(report.groups[0]?.outcomes.full?.infrastructureErrors).toBe(1);
		expect(report.groups[0]?.outcomes.baseline?.cancelled).toBe(1);
		expect(report.groups[0]?.outcomes.full?.unscored).toBe(1);
		expect(report.groups[0]?.observations.find(item => item.variant === "full")?.artifacts).toEqual({
			turns: 3,
			resource: { hash: "resource-a" },
		});
		const absent = createSkillExperimentReport(record([]))!;
		expect(absent.groups[0]?.status).toBe("not-run");
		expect(absent.groups[0]?.executed).toBe(0);
	});

	it("writes skill experiment JSON beside run.json only for skill-arm runs", async () => {
		const runsDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-report-"));
		tempDirs.push(runsDir);
		const skillRecord = record([result("base", 0, null, 1, { resourceHash: "resource-a" })]);
		await writeRunOutput({
			runsDir,
			suite: { id: "suite" } as EvalSuite,
			record: skillRecord,
			models: ["model-a"],
			tasks: ["task-1"],
			repeats: 1,
		});
		const reportPath = path.join(runsDir, skillRecord.id, SKILL_EXPERIMENT_REPORT_FILE);
		const persisted = JSON.parse(await fs.readFile(reportPath, "utf8"));
		expect(persisted.bindings.record).toEqual(skillRecord.metadata?.skillBinding);
		expect(persisted.bindings.arms).toEqual([
			{
				id: "base",
				kind: "baseline",
				sourceHash: baseline!.sourceHash,
				contentHash: baseline!.contentHash,
				recipeHash: baseline!.recipeHash,
				model: "model-a",
			},
			{
				id: "full",
				kind: "full",
				sourceHash: full!.sourceHash,
				contentHash: full!.contentHash,
				recipeHash: full!.recipeHash,
				model: "model-a",
			},
		]);
		expect(persisted.groups[0].observations[0].artifacts).toEqual({ resourceHash: "resource-a" });

		const ordinary = {
			...skillRecord,
			id: "ordinary",
			variants: skillRecord.variants.map(({ skillArm: _skillArm, ...item }) => item),
		};
		await writeRunOutput({
			runsDir,
			suite: { id: "suite" } as EvalSuite,
			record: ordinary,
			models: ["model-a"],
			tasks: ["task-1"],
			repeats: 1,
		});
		await expect(fs.access(path.join(runsDir, ordinary.id, SKILL_EXPERIMENT_REPORT_FILE))).rejects.toThrow();
	});
});
