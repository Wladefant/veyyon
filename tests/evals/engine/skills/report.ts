import { canonicalizeConfig } from "../plan/variant-matrix";
import { pairArms } from "../compare/paired";
import type { ArmTrial, PairedArms } from "../compare/paired";
import { classifyTrialOutcome } from "../trial/outcomes";
import type { EvalRunRecord, TrialResultRecord } from "../run/record";
import type { FrozenSkillArm } from "./arms";

export const SKILL_EXPERIMENT_REPORT_FILE = "skill-experiment.json";

export type SkillBinding = Readonly<Record<string, unknown>>;

export interface SkillStaleness {
	readonly status: "current" | "stale" | "unverified";
	readonly changed: readonly string[];
	readonly unknown: readonly string[];
}

/** Compare the binding union supplied by the run and caller; no synthetic resource keys are required. */
export function assessSkillStaleness(recordBinding: SkillBinding, currentBinding: SkillBinding): SkillStaleness {
	const changed: string[] = [];
	const unknown: string[] = [];
	const fields = new Set([...Object.keys(recordBinding), ...Object.keys(currentBinding)]);
	for (const key of fields) {
		const recorded = recordBinding[key];
		const current = currentBinding[key];
		if (recorded === undefined || current === undefined) {
			unknown.push(key);
			continue;
		}
		const recordedUnknown = recorded === null || recorded === "";
		const currentUnknown = current === null || current === "";
		if (recordedUnknown || currentUnknown) {
			unknown.push(key);
			if (recorded !== current && recorded !== "" && current !== "") changed.push(key);
			continue;
		}
		if (canonicalizeConfig(recorded) !== canonicalizeConfig(current)) changed.push(key);
	}
	if (!fields.has("revision") && !fields.has("modelRevision")) unknown.push("revision");
	return { status: changed.length > 0 ? "stale" : unknown.length > 0 ? "unverified" : "current", changed, unknown };
}



export interface SkillArmBinding {
	readonly id: string;
	readonly kind: FrozenSkillArm["kind"];
	readonly sourceHash: string;
	readonly contentHash: string;
	readonly recipeHash: string;
	readonly model: string;
}

export interface SkillArmOutcomeCounts {
	readonly scored: number;
	readonly timedOut: number;
	readonly infrastructureErrors: number;
	readonly unscored: number;
	readonly cancelled: number;
	readonly missing: number;
}

export interface SkillObservation {
	readonly variant: string;
	readonly task: string;
	readonly repeat: number;
	readonly artifacts: Readonly<Record<string, unknown>>;
}

export interface SkillExperimentGroup {
	readonly model: string;
	readonly harness: string;
	readonly build: string | null;
	readonly pairs: readonly PairedArms[];
	readonly outcomes: Readonly<Record<string, SkillArmOutcomeCounts>>;
	readonly observations: readonly SkillObservation[];
	readonly executed: number;
	readonly graded: number;
	readonly status: "reported" | "not-run";
}

export interface SkillExperimentReport {
	readonly version: 1;
	readonly runId: string;
	readonly skillName: string;
	readonly bindings: {
		readonly record: SkillBinding;
		readonly current: SkillBinding;
		readonly staleness: SkillStaleness;
		readonly arms: readonly SkillArmBinding[];
	};
	readonly groups: readonly SkillExperimentGroup[];
	readonly limits: readonly string[];
}

function isCancelled(result: TrialResultRecord): boolean {
	const extra = result.artifacts?.extra;
	return extra?.cancelled === true || extra?.cancellation === true || extra?.outcome === "cancelled";
}

/** Build paired skill-arm outcomes without crossing model, harness, build, task, or repeat. */
export function createSkillExperimentReport(run: EvalRunRecord, currentBinding: SkillBinding = {}): SkillExperimentReport | null {
	const variants = run.variants.filter(variant => variant.skillArm !== undefined);
	if (variants.length === 0) return null;
	const recorded = (run.metadata?.skillBinding ?? {}) as SkillBinding;
	const arms: SkillArmBinding[] = variants.map(variant => ({
		id: variant.name,
		kind: variant.skillArm!.kind,
		sourceHash: variant.skillArm!.sourceHash,
		contentHash: variant.skillArm!.contentHash,
		recipeHash: variant.skillArm!.recipeHash,
		model: variant.model,
	}));
	const groups = new Map<string, { model: string; harness: string; build: string | null; variants: typeof variants }>();
	for (const variant of variants) {
		const build = variant.build ?? null;
		const key = JSON.stringify([variant.model, variant.harness, build, variant.configPath, variant.promptVariantPath, variant.attachments]);
		let group = groups.get(key);
		if (!group) {
			group = { model: variant.model, harness: variant.harness, build, variants: [] };
			groups.set(key, group);
		}
		group.variants.push(variant);
	}
	const reportGroups: SkillExperimentGroup[] = [...groups.values()].map(group => {
		const members = new Set(group.variants.map(variant => variant.name));
		const trials = run.results.filter(result => members.has(result.cell.variant));
		const counts: Record<string, { scored: number; timedOut: number; infrastructureErrors: number; unscored: number; cancelled: number; missing: number }> = {};
		const gradedTrials: ArmTrial[] = [];
		const seen = new Set<string>();
		const observations: SkillObservation[] = [];
		for (const result of trials) {
			const variant = group.variants.find(item => item.name === result.cell.variant)!;
			const arm = variant.skillArm!.id;
			const count = counts[arm] ??= { scored: 0, timedOut: 0, infrastructureErrors: 0, unscored: 0, cancelled: 0, missing: 0 };
			const outcome = classifyTrialOutcome(result.score.error, result.score.extra.timedOut === true || result.artifacts?.extra?.timedOut === true, result.score.reward);
			if (isCancelled(result)) count.cancelled++;
			else if (outcome === "infrastructure-error") count.infrastructureErrors++;
			else if (outcome === "unscored") count.unscored++;
			else if (outcome === "timed-out") count.timedOut++;
			else count.scored++;
			const id = `${arm}\u0000${result.cell.task}\u0000${result.cell.repeat}`;
			seen.add(id);
			const extra = result.artifacts?.extra ?? {};
			observations.push({ variant: variant.name, task: result.cell.task, repeat: result.cell.repeat, artifacts: extra });
			const usage = result.artifacts?.usage;
			gradedTrials.push({
				arm,
				key: `${result.cell.task}\u0000${result.cell.repeat}`,
				passed: isCancelled(result) || outcome === "infrastructure-error" || outcome === "unscored" ? null : outcome === "scored" ? result.score.reward === 1 : false,
				tokens: usage?.inputTokens == null || usage.outputTokens == null ? null : usage.inputTokens + usage.outputTokens,
				turns: typeof extra.turns === "number" ? extra.turns : null,
				wallSec: result.durationMs == null ? null : result.durationMs / 1000,
			});
		}
		for (const variant of group.variants) {
			const arm = variant.skillArm!.id;
			const count = counts[arm] ??= { scored: 0, timedOut: 0, infrastructureErrors: 0, unscored: 0, cancelled: 0, missing: 0 };
			for (const task of run.tasks) for (let repeat = 1; repeat <= run.repeats; repeat++) {
				if (!seen.has(`${arm}\u0000${task}\u0000${repeat}`)) count.missing++;
			}
		}
		const pairs: PairedArms[] = [];
		const baselines = group.variants.filter(variant => variant.skillArm!.kind === "baseline");
		const candidates = baselines.length > 0
			? group.variants.filter(variant => variant.skillArm!.kind !== "baseline")
			: group.variants.filter(variant => variant.skillArm!.kind === "candidate");
		for (const baseline of baselines.length > 0 ? baselines : group.variants.filter(variant => variant.skillArm!.kind === "full")) {
			for (const candidate of candidates) {
				pairs.push(pairArms(gradedTrials, baseline.skillArm!.id, candidate.skillArm!.id));
			}
		}
		const executed = trials.length;
		const graded = Object.values(counts).reduce((sum, count) => sum + count.scored + count.timedOut, 0);
		return { model: group.model, harness: group.harness, build: group.build, pairs, outcomes: counts, observations, executed, graded, status: executed === 0 || graded === 0 ? "not-run" : "reported" };
	});
	return {
		version: 1,
		runId: run.id,
		skillName: variants[0]!.skillArm!.skillName,
		bindings: { record: recorded, current: currentBinding, staleness: assessSkillStaleness(recorded, currentBinding), arms },
		groups: reportGroups,
		limits: ["No statistical-gain claim is made.", "Unknown upstream revision or binding fields are unverified, never assumed fresh."],
	};
}

