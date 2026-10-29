import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import revisionPrompt from "./revision-prompt.md" with { type: "text" };
import { prompt } from "@veyyon/utils";
import { InProcessClient, discoverSharedInfra } from "../../backends/in-process/client";
import { splitTasks } from "../task-splits";
import type { TaskDescriptor } from "../contracts";
import type { FrozenSkillArm } from "./arms";
import { markFinalSkillSelectionVerified } from "./final-use";
import { canonicalizeConfig, computeVariantFingerprint } from "../plan/variant-matrix";
import { parseModelId } from "../trial/model";
import { buildSkillArms } from "./arms";

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export { acquireFinalSkillRunLock, claimFinalSkillUse, finalExecutionFingerprint } from "./final-use";
export type { FinalUseIdentity } from "./final-use";

export interface SkillExperimentCriteria {
	readonly minimumImprovement: number;
	readonly hash: string;
}
export interface FeedbackOutcome {
	readonly taskId: string;
	readonly reward: number | null;
	readonly error?: string | null;
	readonly feedback?: string;
}

export interface SkillScoreOutcome {
	readonly taskId: string;
	readonly incumbentReward: number | null;
	readonly candidateReward: number | null;
	readonly error?: string | null;
}

export type SkillOutcome = FeedbackOutcome;

export interface CandidateSourceBinding extends Record<string, unknown> {
	readonly version: 1;
	readonly sourceHash: string;
	readonly datasetFingerprint: string;
	readonly criteriaHash: string;
	readonly minimumImprovement: number;
	readonly splitFingerprint: string;
	readonly buildHash: string;
	readonly registryHash: string;
	readonly graderHash: string;
	readonly suiteIdentity: unknown;
	readonly resolvedModel: { readonly provider: string | null; readonly id: string | null; readonly version: string | null };
	readonly requestedModels: readonly string[];
	readonly cohortSize: 80 | 100;
}


export interface SkillCandidateArtifact {
	readonly version: 1;
	readonly kind: "veyyon-skill-candidate";
	readonly skillName: string;
	readonly sourceHash: string;
	readonly candidateHash: string;
	readonly content: string;
	readonly model: string;
	readonly splitSeed: string;
	readonly feedbackTaskIds: readonly string[];
	readonly createdAt: string;
	readonly binding: CandidateSourceBinding;
	readonly resolvedModel: { readonly provider: string; readonly id: string; readonly version: string | null };
}

export interface SkillSelection {
	readonly selected: string;
	readonly reason: "incomplete-score-data" | "unknown-model-revision" | "candidate-not-better" | "candidate-improved";
	readonly incumbentMean: number | null;
	readonly candidateMean: number | null;
}

function isSkillSelectionReason(value: unknown): value is SkillSelection["reason"] {
	return (
		value === "incomplete-score-data" ||
		value === "unknown-model-revision" ||
		value === "candidate-not-better" ||
		value === "candidate-improved"
	);
}

export interface FrozenSkillSelection {
	readonly version: 1;
	readonly kind: "veyyon-skill-selection";
	readonly sourceHash: string;
	readonly binding: CandidateSourceBinding;
	readonly splitSeed: string;
	readonly minimumImprovement: number;
	readonly candidateHash: string;
	readonly winner: "incumbent" | "candidate";
	readonly scoreTaskIds: readonly string[];
	readonly scoreRunHash: string;
	readonly score: SkillSelection;
	readonly createdAt: string;
}
export async function readSkillCohortSize(manifestPath: string): Promise<80 | 100> {
	const manifest = await readJson(path.resolve(manifestPath));
	const declared = isRecord(manifest) ? manifest.cohortSize : undefined;
	if (declared === undefined) return 100;
	if (declared !== 80 && declared !== 100) {
		throw new Error("Skill manifest cohortSize must be 80 or 100 when declared.");
	}
	return declared;
}
export async function readSkillExperimentCriteria(manifestPath: string): Promise<SkillExperimentCriteria> {
	const manifest = await readJson(path.resolve(manifestPath));
	const criteria = isRecord(manifest) && isRecord(manifest.criteria) ? manifest.criteria : null;
	const value = criteria?.minimumImprovement;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("Skill tuning requires a predeclared manifest criteria.minimumImprovement >= 0.");
	}
	return Object.freeze({
		minimumImprovement: value,
		hash: computeVariantFingerprint({ config: { minimumImprovement: value } }),
	});
}
function candidateSourceBindingsMatch(left: CandidateSourceBinding, right: CandidateSourceBinding): boolean {
	return (
		left.version === right.version &&
		left.sourceHash === right.sourceHash &&
		left.cohortSize === right.cohortSize &&
		left.datasetFingerprint === right.datasetFingerprint &&
		left.criteriaHash === right.criteriaHash &&
		left.minimumImprovement === right.minimumImprovement &&
		left.splitFingerprint === right.splitFingerprint &&
		left.buildHash === right.buildHash &&
		left.registryHash === right.registryHash &&
		left.graderHash === right.graderHash &&
		canonicalizeConfig(left.requestedModels) === canonicalizeConfig(right.requestedModels)
	);
}

function candidateBindingsMatch(left: CandidateSourceBinding, right: CandidateSourceBinding): boolean {
	return (
		candidateSourceBindingsMatch(left, right) &&
		canonicalizeConfig(left.resolvedModel) === canonicalizeConfig(right.resolvedModel)
	);
}

export function createCandidateSourceBinding(
	value: unknown,
	tasks: readonly TaskDescriptor[],
	sourceHash: string,
	criteria: SkillExperimentCriteria,
	splitSeed: string,
	resolvedModel: CandidateSourceBinding["resolvedModel"] = { provider: null, id: null, version: null },
	cohortSize: 100 | 80 = 100,
): CandidateSourceBinding {
	const outer = isRecord(value) ? value : null;
	if (!outer) throw new Error("Binding input must be an engine run object or skill binding.");
	const metadata = isRecord(outer.metadata) ? outer.metadata : {};
	const rawValue = metadata.skillBinding ?? outer;
	if (!isRecord(rawValue)) throw new Error("Binding input has no valid skillBinding object.");
	const raw = rawValue;
	if (
		(raw.cohortSize !== cohortSize && !(cohortSize === 100 && raw.cohortSize === undefined)) ||
		raw.version !== 1 ||
		typeof raw.buildHash !== "string" ||
		typeof raw.registryHash !== "string" ||
		typeof raw.graderHash !== "string" ||
		raw.criteriaHash !== criteria.hash ||
		!Array.isArray(raw.requestedModels) ||
		!raw.requestedModels.every(model => typeof model === "string") ||
		!isRecord(raw.suiteIdentity) ||
		typeof raw.suiteIdentity.suite !== "string" ||
		!raw.suiteIdentity.suite ||
		typeof raw.suiteIdentity.version !== "string" ||
		!raw.suiteIdentity.version ||
		typeof raw.suiteIdentity.sha !== "string" ||
		!raw.suiteIdentity.sha
	) {
		throw new Error("Binding input needs criteria, models, hashes, and a verified suite/version/SHA identity.");
	}
	const taskIds = tasks.map(task => task.id);
	if (taskIds.length !== cohortSize || new Set(taskIds).size !== cohortSize) {
		throw new Error(`Candidate generation requires exactly ${cohortSize} unique verified task descriptors.`);
	}
	const split = splitTasks(tasks, splitSeed, cohortSize);
	const splitIdentity = {
		seed: splitSeed,
		taskIds: [...taskIds].sort(),
		membership: {
			feedback: split.feedback.map(task => task.id).sort(),
			score: split.score.map(task => task.id).sort(),
			final: split.final.map(task => task.id).sort(),
		},
		cohortSize,
	};
	const requestedModels = raw.requestedModels.filter((model): model is string => typeof model === "string");
	return Object.freeze({
		version: 1,
		sourceHash,
		datasetFingerprint: digest(
			canonicalizeConfig({
				suite: raw.suiteIdentity.suite,
				version: raw.suiteIdentity.version,
				sha: raw.suiteIdentity.sha,
			}),
		),
		splitFingerprint: digest(canonicalizeConfig(splitIdentity)),
		criteriaHash: criteria.hash,
		minimumImprovement: criteria.minimumImprovement,
		buildHash: raw.buildHash,
		registryHash: raw.registryHash,
		graderHash: raw.graderHash,
		suiteIdentity: raw.suiteIdentity,
		requestedModels: Object.freeze(requestedModels),
		cohortSize,
		resolvedModel,
	});
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await fs.readFile(file, "utf8"));
}

/** Read a skill manifest and build the frozen experimental arms. */
export async function loadSkillArms(
	manifestPath: string,
	candidatePath?: string,
	expectedSplitSeed?: string,
): Promise<readonly FrozenSkillArm[]> {
	const arms = buildSkillArms(await readJson(path.resolve(manifestPath)));
	if (!candidatePath) return arms;
	const full = arms.find(arm => arm.kind === "full");
	if (!full) throw new Error("Skill manifest has no full arm.");
	const artifact = await readSkillCandidateArtifact(manifestPath, candidatePath, expectedSplitSeed);
	const candidate: FrozenSkillArm = Object.freeze({
		id: `candidate-${artifact.candidateHash.slice(0, 12)}`,
		kind: "candidate",
		skillName: full.skillName,
		content: artifact.content,
		contentHash: artifact.candidateHash,
		sourceHash: full.sourceHash,
		omittedComponents: Object.freeze([]),
		recipeHash: artifact.candidateHash,
	});
	return Object.freeze([...arms, candidate]);
}

export async function readSkillCandidateArtifact(
	manifestPath: string,
	candidatePath: string,
	expectedSplitSeed?: string,
): Promise<SkillCandidateArtifact> {
	const arms = await loadSkillArms(manifestPath);
	const full = arms.find(arm => arm.kind === "full");
	const value: unknown = await readJson(path.resolve(candidatePath));
	const bindingValue = isRecord(value) && isRecord(value.binding) ? value.binding : null;
	const modelValue = isRecord(value) && isRecord(value.resolvedModel) ? value.resolvedModel : null;
	const bindingModel = bindingValue && isRecord(bindingValue.resolvedModel) ? bindingValue.resolvedModel : null;
	const suiteIdentity = bindingValue && isRecord(bindingValue.suiteIdentity) ? bindingValue.suiteIdentity : null;
	const feedbackTaskIds =
		isRecord(value) && Array.isArray(value.feedbackTaskIds) && value.feedbackTaskIds.every(id => typeof id === "string")
			? value.feedbackTaskIds
			: null;
	const cohortSize = await readSkillCohortSize(manifestPath);
	if (
		!full ||
		!isRecord(value) ||
		!bindingValue ||
		value.version !== 1 ||
		value.kind !== "veyyon-skill-candidate" ||
		value.skillName !== full.skillName ||
		value.sourceHash !== full.sourceHash ||
		typeof value.content !== "string" ||
		value.content.length === 0 ||
		typeof value.candidateHash !== "string" ||
		value.candidateHash !== digest(value.content) ||
		typeof value.model !== "string" ||
		typeof value.splitSeed !== "string" ||
		(expectedSplitSeed !== undefined && value.splitSeed !== expectedSplitSeed) ||
		typeof value.createdAt !== "string" ||
		!feedbackTaskIds ||
		new Set(feedbackTaskIds).size !== feedbackTaskIds.length ||
		bindingValue.version !== 1 ||
		bindingValue.cohortSize !== cohortSize ||
		bindingValue.sourceHash !== full.sourceHash ||
		typeof bindingValue.datasetFingerprint !== "string" ||
		typeof bindingValue.criteriaHash !== "string" ||
		typeof bindingValue.minimumImprovement !== "number" ||
		!Number.isFinite(bindingValue.minimumImprovement) ||
		bindingValue.minimumImprovement < 0 ||
		typeof bindingValue.splitFingerprint !== "string" ||
		typeof bindingValue.buildHash !== "string" ||
		typeof bindingValue.registryHash !== "string" ||
		typeof bindingValue.graderHash !== "string" ||
		!suiteIdentity ||
		typeof suiteIdentity.suite !== "string" ||
		typeof suiteIdentity.version !== "string" ||
		typeof suiteIdentity.sha !== "string" ||
		!bindingModel ||
		(bindingModel.provider !== null && typeof bindingModel.provider !== "string") ||
		(bindingModel.id !== null && typeof bindingModel.id !== "string") ||
		(bindingModel.version !== null && typeof bindingModel.version !== "string") ||
		!Array.isArray(bindingValue.requestedModels) ||
		!bindingValue.requestedModels.every(model => typeof model === "string") ||
		!modelValue ||
		typeof modelValue.provider !== "string" ||
		!modelValue.provider ||
		typeof modelValue.id !== "string" ||
		!modelValue.id ||
		(modelValue.version !== null && typeof modelValue.version !== "string")
	) {
		throw new Error("Candidate artifact is malformed or does not match its source skill manifest.");
	}
	const binding: CandidateSourceBinding = Object.freeze({
		version: 1,
		sourceHash: full.sourceHash,
		datasetFingerprint: bindingValue.datasetFingerprint,
		criteriaHash: bindingValue.criteriaHash,
		cohortSize,
		minimumImprovement: bindingValue.minimumImprovement,
		splitFingerprint: bindingValue.splitFingerprint,
		buildHash: bindingValue.buildHash,
		registryHash: bindingValue.registryHash,
		graderHash: bindingValue.graderHash,
		suiteIdentity,
		resolvedModel: Object.freeze({
			provider: bindingModel.provider,
			id: bindingModel.id,
			version: bindingModel.version,
		}),
		requestedModels: Object.freeze([...bindingValue.requestedModels]),
	});
	return Object.freeze({
		version: 1,
		kind: "veyyon-skill-candidate",
		skillName: full.skillName,
		sourceHash: full.sourceHash,
		candidateHash: value.candidateHash,
		content: value.content,
		model: value.model,
		splitSeed: value.splitSeed,
		feedbackTaskIds: Object.freeze([...feedbackTaskIds]),
		createdAt: value.createdAt,
		binding,
		resolvedModel: Object.freeze({
			provider: modelValue.provider,
			id: modelValue.id,
			version: modelValue.version,
		}),
	});
}

export interface SkillPhaseRunData {
	readonly binding: CandidateSourceBinding;
	readonly feedbackOutcomes: readonly FeedbackOutcome[];
	readonly scoreOutcomes: readonly SkillScoreOutcome[];
	readonly runHash: string;
}

/** Read only complete, phase-matched grader rows from an engine run record. */

export async function readSkillPhaseRun(input: {
	readonly runPath: string;
	readonly phase: "feedback" | "score";
	readonly tasks: readonly TaskDescriptor[];
	readonly splitSeed: string;
	readonly manifestPath: string;
	readonly candidate?: SkillCandidateArtifact;
}): Promise<SkillPhaseRunData> {
	const runBytes = await fs.readFile(path.resolve(input.runPath));
	const runHash = createHash("sha256").update(runBytes).digest("hex");
	const record: unknown = JSON.parse(runBytes.toString("utf8"));
	if (!isRecord(record) || !isRecord(record.metadata) || !isRecord(record.metadata.skillBinding)) {
		throw new Error("Skill phase input must be a Veyyon eval run record with a frozen binding.");
	}
	const metadata = record.metadata;
	if (metadata.skillPhase !== input.phase) throw new Error(`Run record must be a ${input.phase} skill phase.`);
	const arms = buildSkillArms(await readJson(path.resolve(input.manifestPath)));
	const full = arms.find(arm => arm.kind === "full");
	if (!full) throw new Error("Skill manifest has no full arm.");
	const criteria = await readSkillExperimentCriteria(input.manifestPath);
	const cohortSize = await readSkillCohortSize(input.manifestPath);
	const bindingBase = createCandidateSourceBinding(record, input.tasks, full.sourceHash, criteria, input.splitSeed, undefined, cohortSize);
	if (bindingBase.requestedModels.length !== 1) throw new Error("Skill candidate tuning requires exactly one requested model.");
	const split = splitTasks(input.tasks, input.splitSeed, cohortSize);
	const expectedTasks = split[input.phase].map(task => task.id);
	if (
		!Array.isArray(record.tasks) ||
		!record.tasks.every(task => typeof task === "string") ||
		canonicalizeConfig([...record.tasks].sort()) !== canonicalizeConfig([...expectedTasks].sort()) ||
		!isRecord(record.suite) ||
		typeof record.suite.name !== "string" ||
		typeof record.suite.version !== "string" ||
		typeof record.suite.provenanceSha !== "string" ||
		record.suite.provenanceSha.length === 0
	) {
		throw new Error("Run record does not match the exact single-repeat task split and suite identity.");
	}
	const suiteTag = record.suite;
	const suiteIdentity = bindingBase.suiteIdentity;
	if (
		!isRecord(suiteIdentity) ||
		suiteIdentity.suite !== suiteTag.name ||
		suiteIdentity.version !== suiteTag.version ||
		suiteIdentity.sha !== suiteTag.provenanceSha
	) {
		throw new Error("Run suite identity does not match its frozen skill binding.");
	}
	if (!Array.isArray(record.variants) || record.variants.length !== (input.phase === "feedback" ? 1 : 2)) {
		throw new Error("Run record has the wrong number of variants for its skill phase.");
	}
	const variants: { name: string; model: string; kind: string; arm: Record<string, unknown> }[] = [];
	const variantByKind = new Map<string, { name: string; model: string; arm: Record<string, unknown> }>();
	for (const value of record.variants) {
		if (!isRecord(value) || typeof value.name !== "string" || value.harness !== "veyyon" || typeof value.model !== "string") {
			throw new Error("Run record has an unsupported skill arm or model.");
		}
		if (!isRecord(value.skillArm)) throw new Error("Run record has a variant without a frozen skill arm.");
		const arm = value.skillArm;
		const armKind = arm.kind;
		if (typeof armKind !== "string") throw new Error("Run record has a variant without a frozen skill arm.");
		if (
			typeof arm.id !== "string" ||
			typeof arm.skillName !== "string" ||
			typeof arm.contentHash !== "string" ||
			typeof arm.sourceHash !== "string" ||
			typeof arm.recipeHash !== "string"
		) {
			throw new Error("Run record has an invalid frozen skill arm.");
		}
		if (value.model !== bindingBase.requestedModels[0]) throw new Error("Run model does not match the skill binding.");
		if (arm.sourceHash !== full.sourceHash) throw new Error("Run arm has a different skill source hash.");
		if (armKind === "full" && (arm.recipeHash !== full.recipeHash || arm.contentHash !== full.contentHash)) {
			throw new Error("Run full arm does not match the current manifest.");
		}
		if (armKind === "candidate" && (!input.candidate || arm.recipeHash !== input.candidate.candidateHash || arm.contentHash !== input.candidate.candidateHash)) {
			throw new Error("Run candidate arm does not match the frozen candidate artifact.");
		}
		if (variantByKind.has(armKind)) throw new Error("Run record repeats a skill arm kind.");
		const normalized = { name: value.name, model: value.model, kind: armKind, arm };
		variants.push(normalized);
		variantByKind.set(armKind, normalized);
	}
	if (!variantByKind.has("full") || (input.phase === "score" && (!variantByKind.has("candidate") || !input.candidate))) {
		throw new Error("Run record is missing the required full or candidate arm.");
	}
	if (input.phase === "score" && input.candidate && !candidateSourceBindingsMatch(input.candidate.binding, bindingBase)) {
		throw new Error("Score run source binding does not match the frozen candidate artifact.");
	}
	const resultsByCell = new Map<string, Record<string, unknown>>();
	if (!Array.isArray(record.results)) throw new Error("Run record has no grader results.");
	for (const value of record.results) {
		if (!isRecord(value) || !isRecord(value.cell)) throw new Error("Run record contains an invalid grader result.");
		const cell = value.cell;
		if (
			typeof cell.task !== "string" ||
			typeof cell.variant !== "string" ||
			cell.repeat !== 1 ||
			!expectedTasks.includes(cell.task) ||
			!variants.some(variant => variant.name === cell.variant)
		) {
			throw new Error("Run contains an outcome outside the verified skill phase cells.");
		}
		const key = `${cell.task}\u0000${cell.variant}`;
		if (resultsByCell.has(key)) throw new Error("Run record contains duplicate skill phase outcomes.");
		resultsByCell.set(key, value);
	}
	const actualModels: ({ provider: string; id: string; version: string | null } | null)[] = [];
	for (const taskId of expectedTasks) {
		for (const variant of variants) {
			const result = resultsByCell.get(`${taskId}\u0000${variant.name}`);
			if (!result) {
				actualModels.push(null);
				continue;
			}
			if (!isRecord(result.artifacts) || !isRecord(result.artifacts.extra)) {
				throw new Error("Completed run outcome has no observed skill-arm or model provenance.");
			}
			const extra = result.artifacts.extra;
			if (!isRecord(extra.skillArm)) throw new Error("Run outcome has no observed loaded skill arm.");
			const observedArm = extra.skillArm;
			if (
				observedArm.id !== variant.arm.id ||
				observedArm.kind !== variant.arm.kind ||
				observedArm.contentHash !== variant.arm.contentHash ||
				observedArm.sourceHash !== variant.arm.sourceHash ||
				observedArm.recipeHash !== variant.arm.recipeHash
			) {
				throw new Error("Run outcome did not load the exact frozen skill arm.");
			}
			const observedHashes = extra.observedSkillHashes;
			if (!Array.isArray(observedHashes) || !observedHashes.every(isRecord)) {
				throw new Error("Run outcome has no proof of the skill hashes loaded by the agent.");
			}
			const observedSkill = observedHashes.find(skill => skill.name === variant.arm.skillName);
			if (variant.arm.kind === "baseline" || variant.arm.content === null) {
				if (observedSkill) throw new Error("Baseline run loaded the target skill.");
			} else if (!observedSkill || observedSkill.contentHash !== variant.arm.contentHash) {
				throw new Error("Run outcome loaded a different target skill content hash.");
			}
			const resolved = extra.resolvedModel;
			if (!isRecord(resolved) || typeof resolved.provider !== "string" || !resolved.provider || typeof resolved.id !== "string" || !resolved.id) {
				throw new Error("Run outcome has no observed resolved provider/model identity.");
			}
			const requested = parseModelId(variant.model);
			if (resolved.provider !== requested.provider || resolved.id !== requested.model) {
				throw new Error(`Run outcome resolved ${resolved.provider}/${resolved.id}, not requested ${requested.id}.`);
			}
			actualModels.push({
				provider: resolved.provider,
				id: resolved.id,
				version: typeof resolved.version === "string" && resolved.version.length > 0 ? resolved.version : null,
			});
		}
	}
	const observedModels = actualModels.filter((model): model is { provider: string; id: string; version: string | null } => model !== null);
	const firstModel = observedModels[0] ?? null;
	if (
		firstModel &&
		observedModels.some(model => model.provider !== firstModel.provider || model.id !== firstModel.id)
	) {
		throw new Error("Run outcomes resolved more than one provider/model identity.");
	}
	const knownVersions = new Set(observedModels.flatMap(model => model.version === null ? [] : [model.version]));
	if (knownVersions.size > 1) throw new Error("Run outcomes resolved more than one model revision.");
	const resolvedModel =
		firstModel && observedModels.every(model => model.version === firstModel.version)
			? firstModel
			: firstModel
				? { provider: firstModel.provider, id: firstModel.id, version: null }
				: { provider: null, id: null, version: null };
	const binding = createCandidateSourceBinding(record, input.tasks, full.sourceHash, criteria, input.splitSeed, resolvedModel, cohortSize);
	if (
		input.phase === "score" &&
		input.candidate &&
		input.candidate.binding.resolvedModel.provider !== null &&
		binding.resolvedModel.provider !== null &&
		(input.candidate.binding.resolvedModel.provider !== binding.resolvedModel.provider ||
			input.candidate.binding.resolvedModel.id !== binding.resolvedModel.id ||
			(input.candidate.binding.resolvedModel.version !== null &&
				binding.resolvedModel.version !== null &&
				input.candidate.binding.resolvedModel.version !== binding.resolvedModel.version))
	) {
		throw new Error("Score run resolved a different provider/model or model revision than the candidate feedback run.");
	}
	const rewardFor = (taskId: string, kind: string): number | null => {
		const variant = variantByKind.get(kind);
		const result = variant ? resultsByCell.get(`${taskId}\u0000${variant.name}`) : undefined;
		const score = result && isRecord(result.score) ? result.score : null;
		return score && typeof score.reward === "number" && Number.isFinite(score.reward) ? score.reward : null;
	};
	const errorFor = (taskId: string, kind: string): string | null => {
		const variant = variantByKind.get(kind);
		const result = variant ? resultsByCell.get(`${taskId}\u0000${variant.name}`) : undefined;
		const score = result && isRecord(result.score) ? result.score : null;
		return score && typeof score.error === "string" ? score.error : null;
	};
	const feedbackOutcomes = input.phase === "feedback"
		? expectedTasks.map(taskId => {
				const variant = variantByKind.get("full");
				const result = variant ? resultsByCell.get(`${taskId}\u0000${variant.name}`) : undefined;
				const score = result && isRecord(result.score) ? result.score : null;
				const extra = score && isRecord(score.extra) ? score.extra : {};
				const feedback = [extra.feedback, extra.failureSummary].find(value => typeof value === "string");
				return {
					taskId,
					reward: rewardFor(taskId, "full"),
					error: errorFor(taskId, "full"),
					...(typeof feedback === "string" ? { feedback } : {}),
				};
			})
		: [];
	const scoreOutcomes = input.phase === "score"
		? expectedTasks.map(taskId => ({
				taskId,
				incumbentReward: rewardFor(taskId, "full"),
				candidateReward: rewardFor(taskId, "candidate"),
				error: errorFor(taskId, "full") ?? errorFor(taskId, "candidate"),
			}))
		: [];
	return { binding, feedbackOutcomes, scoreOutcomes, runHash };
}
export function buildFeedbackOnlyPrompt(input: {
	readonly skillName: string;
	readonly content: string;
	readonly tasks: readonly TaskDescriptor[];
	readonly splitSeed: string;
	readonly outcomes: readonly FeedbackOutcome[];
	readonly cohortSize?: 80 | 100;
}): string {
	const feedbackTasks = splitTasks(input.tasks, input.splitSeed, input.cohortSize ?? 100).feedback;
	const feedbackIds = new Set(feedbackTasks.map(task => task.id));
	const received = new Map(input.outcomes.map(row => [row.taskId, row]));
	if (received.size !== input.outcomes.length) throw new Error("Feedback outcomes contain duplicate task ids.");
	if (input.outcomes.some(row => !feedbackIds.has(row.taskId))) {
		throw new Error("Revision outcomes must contain feedback tasks only; score/final outcomes are forbidden.");
	}
	if (feedbackTasks.some(task => !received.has(task.id))) throw new Error("Every feedback task needs an outcome before revision.");
	const feedback = feedbackTasks.map(task => {
		const outcome = received.get(task.id)!;
		if (outcome.reward === null || outcome.error) throw new Error(`Feedback task ${task.id} has no graded outcome.`);
		return { taskId: task.id, reward: outcome.reward, feedback: outcome.feedback ?? "" };
	});
	return prompt.render(revisionPrompt, {
		skillName: input.skillName,
		content: input.content,
		feedback: JSON.stringify(feedback),
	});
}

export async function reviseSkillCandidate(input: {
	readonly manifestPath: string;
	readonly tasks: readonly TaskDescriptor[];
	readonly splitSeed: string;
	readonly outcomes: readonly SkillOutcome[];
	readonly model: string;
	readonly binding: CandidateSourceBinding;
	readonly outputPath: string;
	readonly cwd: string;
}): Promise<SkillCandidateArtifact> {
	const manifest = await readJson(path.resolve(input.manifestPath));
	const arms = buildSkillArms(manifest);
	const incumbent = arms.find(arm => arm.kind === "full");
	const cohortSize = await readSkillCohortSize(input.manifestPath);
	if (!incumbent) throw new Error("Skill manifest has no full arm.");
	const criteria = await readSkillExperimentCriteria(input.manifestPath);
	const splits = splitTasks(input.tasks, input.splitSeed, cohortSize);
	const splitFingerprint = digest(
		canonicalizeConfig({
			seed: input.splitSeed,
			taskIds: input.tasks.map(task => task.id).sort(),
			membership: {
				feedback: splits.feedback.map(task => task.id).sort(),
				score: splits.score.map(task => task.id).sort(),
				final: splits.final.map(task => task.id).sort(),
			},
			cohortSize,
		}),
	);
	if (
		input.binding.version !== 1 ||
		input.binding.sourceHash !== incumbent.sourceHash ||
		input.binding.criteriaHash !== criteria.hash ||
		input.binding.cohortSize !== cohortSize ||
		input.binding.minimumImprovement !== criteria.minimumImprovement ||
		input.binding.splitFingerprint !== splitFingerprint ||
		!input.binding.requestedModels.includes(input.model)
	) {
		throw new Error("Candidate source binding does not match this skill, model, or exact 100-task split.");
	}
	const requestedModel = parseModelId(input.model);
	const feedbackModel = input.binding.resolvedModel;
	if (
		!feedbackModel.provider ||
		!feedbackModel.id ||
		feedbackModel.provider !== requestedModel.provider ||
		feedbackModel.id !== requestedModel.model
	) {
		throw new Error("Feedback run has no verified resolved model identity for the requested model.");
	}
	const prompt = buildFeedbackOnlyPrompt({
		skillName: incumbent.skillName,
		content: incumbent.content ?? "",
		tasks: input.tasks,
		splitSeed: input.splitSeed,
		outcomes: input.outcomes,
		cohortSize,
	});
	const shared = await discoverSharedInfra();
	const client = new InProcessClient({
		cwd: input.cwd,
		model: input.model,
		tools: [],
		shared,
	});
	let content: string;
	let resolvedModel: SkillCandidateArtifact["resolvedModel"];
	try {
		await client.start();
		const model = (await client.getState()).model;
		if (!model?.provider || !model.id) throw new Error("In-process client did not resolve a provider model identity.");
		if (model.provider !== requestedModel.provider || model.id !== requestedModel.model) {
			throw new Error(`Candidate model mismatch: requested ${requestedModel.id}, resolved ${model.provider}/${model.id}.`);
		}
		const version = isRecord(model) && typeof model.version === "string" && model.version.length > 0 ? model.version : null;
		if (feedbackModel.version !== null && version !== feedbackModel.version) {
			throw new Error("Candidate generation resolved a different model revision than the feedback run.");
		}
		resolvedModel = { provider: model.provider, id: model.id, version };
		await client.prompt(prompt);
		content = (await client.getLastAssistantText()) ?? "";
	} finally {
		await client.dispose();
	}
	if (!content.trim()) throw new Error("Model returned an empty skill candidate.");
	const artifact: SkillCandidateArtifact = Object.freeze({
		version: 1,
		kind: "veyyon-skill-candidate",
		binding: input.binding,
		skillName: incumbent.skillName,
		sourceHash: incumbent.sourceHash,
		candidateHash: digest(content),
		content,
		model: input.model,
		resolvedModel,
		splitSeed: input.splitSeed,
		feedbackTaskIds: Object.freeze(splits.feedback.map(task => task.id)),
		createdAt: new Date().toISOString(),
	});
	const target = path.resolve(input.outputPath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.${createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex")}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		await handle.sync();
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	} finally {
		await handle.close();
	}
	try {
		await fs.link(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}
	await fs.rm(temporary, { force: true });
	return artifact;
}

/** Select by mean known reward; incomplete scores and ties retain the incumbent. */
export function selectSkillCandidate(input: {
	readonly tasks: readonly TaskDescriptor[];
	readonly splitSeed: string;
	readonly outcomes: readonly SkillScoreOutcome[];
	readonly candidate: SkillCandidateArtifact;
	readonly sourceHash: string;
	readonly binding: CandidateSourceBinding;
}): SkillSelection {
	if (!Number.isFinite(input.binding.minimumImprovement) || input.binding.minimumImprovement < 0) {
		throw new Error("Candidate binding has no valid predeclared minimum-improvement criterion.");
	}
	const splits = splitTasks(input.tasks, input.splitSeed, input.binding.cohortSize);
	const expectedFeedbackIds = splits.feedback.map(task => task.id);
	if (
		input.candidate.splitSeed !== input.splitSeed ||
		input.candidate.sourceHash !== input.sourceHash ||
		input.candidate.binding.sourceHash !== input.sourceHash ||
		!candidateSourceBindingsMatch(input.candidate.binding, input.binding) ||
		canonicalizeConfig([...input.candidate.feedbackTaskIds].sort()) !== canonicalizeConfig([...expectedFeedbackIds].sort())
	) {
		throw new Error("Candidate artifact does not match the source skill, run binding, or task split.");
	}
	const requestedModel = parseModelId(input.candidate.model);
	if (
		input.candidate.resolvedModel.provider !== requestedModel.provider ||
		input.candidate.resolvedModel.id !== requestedModel.model
	) {
		throw new Error("Candidate artifact resolved a model different from its requested provider/model id.");
	}
	const scoreIds = new Set(splits.score.map(task => task.id));
	const byTask = new Map(input.outcomes.map(row => [row.taskId, row]));
	if (
		byTask.size !== input.outcomes.length ||
		input.outcomes.some(row => !scoreIds.has(row.taskId)) ||
		splits.score.some(task => !byTask.has(task.id))
	) {
		return { selected: "incumbent", reason: "incomplete-score-data", incumbentMean: null, candidateMean: null };
	}
	const rows = splits.score.map(task => byTask.get(task.id)!);
	if (
		rows.some(
			row =>
				row.error ||
				row.incumbentReward === null ||
				row.candidateReward === null ||
				!Number.isFinite(row.incumbentReward) ||
				!Number.isFinite(row.candidateReward),
		)
	) {
		return { selected: "incumbent", reason: "incomplete-score-data", incumbentMean: null, candidateMean: null };
	}
	const incumbentMean = rows.reduce((sum, row) => sum + (row.incumbentReward as number), 0) / rows.length;
	const candidateMean = rows.reduce((sum, row) => sum + (row.candidateReward as number), 0) / rows.length;
	const feedbackModel = input.candidate.binding.resolvedModel;
	const scoreModel = input.binding.resolvedModel;
	if (
		(feedbackModel.provider !== null && feedbackModel.provider !== input.candidate.resolvedModel.provider) ||
		(feedbackModel.id !== null && feedbackModel.id !== input.candidate.resolvedModel.id) ||
		(scoreModel.provider !== null && scoreModel.provider !== requestedModel.provider) ||
		(scoreModel.id !== null && scoreModel.id !== requestedModel.model) ||
		(feedbackModel.version !== null && input.candidate.resolvedModel.version !== null && feedbackModel.version !== input.candidate.resolvedModel.version) ||
		(scoreModel.version !== null && input.candidate.resolvedModel.version !== null && scoreModel.version !== input.candidate.resolvedModel.version)
	) {
		throw new Error("Candidate, feedback, and score runs do not share one resolved model identity.");
	}
	if (
		!feedbackModel.provider ||
		!feedbackModel.id ||
		!feedbackModel.version ||
		!scoreModel.provider ||
		!scoreModel.id ||
		!scoreModel.version ||
		!input.candidate.resolvedModel.version
	) {
		return { selected: "incumbent", reason: "unknown-model-revision", incumbentMean, candidateMean };
	}
	return candidateMean > incumbentMean + input.binding.minimumImprovement
		? { selected: input.candidate.candidateHash, reason: "candidate-improved", incumbentMean, candidateMean }
		: { selected: "incumbent", reason: "candidate-not-better", incumbentMean, candidateMean };
}

export async function createSkillSelection(input: {
	readonly tasks: readonly TaskDescriptor[];
	readonly splitSeed: string;
	readonly outcomes: readonly SkillScoreOutcome[];
	readonly candidate: SkillCandidateArtifact;
	readonly sourceHash: string;
	readonly binding: CandidateSourceBinding;
	readonly scoreRunHash: string;
	readonly outputPath: string;
}): Promise<FrozenSkillSelection> {
	if (!/^[a-f0-9]{64}$/.test(input.scoreRunHash)) throw new Error("Skill selection requires a verified score-run hash.");
	const score = Object.freeze(selectSkillCandidate(input));
	const splits = splitTasks(input.tasks, input.splitSeed, input.binding.cohortSize);
	const artifact: FrozenSkillSelection = Object.freeze({
		version: 1,
		kind: "veyyon-skill-selection",
		sourceHash: input.sourceHash,
		binding: input.binding,
		splitSeed: input.splitSeed,
		candidateHash: input.candidate.candidateHash,
		winner: score.selected === input.candidate.candidateHash ? "candidate" : "incumbent",
		scoreTaskIds: Object.freeze(splits.score.map(task => task.id).sort()),
		minimumImprovement: input.binding.minimumImprovement,
		scoreRunHash: input.scoreRunHash,
		score,
		createdAt: new Date().toISOString(),
	});
	const target = path.resolve(input.outputPath);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const handle = await fs.open(target, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	return artifact;
}

export async function readFrozenSkillSelection(
	selectionPath: string,
	candidate: SkillCandidateArtifact,
	sourceHash: string,
	splitSeed: string,
	tasks: readonly TaskDescriptor[],
	verifiedScoreOutcomes: readonly SkillScoreOutcome[],
	scoreTaskIds: readonly string[],
	expectedBinding: CandidateSourceBinding,
	expectedScoreRunHash: string,
): Promise<FrozenSkillSelection> {
	const value: unknown = await readJson(path.resolve(selectionPath));
	const score = isRecord(value) && isRecord(value.score) ? value.score : null;
	const bindingMatches =
		isRecord(value) &&
		isRecord(value.binding) &&
		canonicalizeConfig(value.binding) === canonicalizeConfig(candidate.binding);
	const idsMatch =
		isRecord(value) &&
		Array.isArray(value.scoreTaskIds) &&
		value.scoreTaskIds.every(id => typeof id === "string") &&
		canonicalizeConfig([...value.scoreTaskIds].sort()) === canonicalizeConfig([...scoreTaskIds].sort());
	const reason = score?.reason;
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		value.kind !== "veyyon-skill-selection" ||
		value.sourceHash !== sourceHash ||
		!bindingMatches ||
		!candidateBindingsMatch(candidate.binding, expectedBinding) ||
		(value.winner === "candidate" && !candidate.resolvedModel.version) ||
		value.splitSeed !== splitSeed ||
		value.candidateHash !== candidate.candidateHash ||
		!idsMatch ||
		value.minimumImprovement !== expectedBinding.minimumImprovement ||
		typeof value.scoreRunHash !== "string" ||
		value.scoreRunHash !== expectedScoreRunHash ||
		!/^[a-f0-9]{64}$/.test(value.scoreRunHash) ||
		typeof value.createdAt !== "string" ||
		!score ||
		!isSkillSelectionReason(reason) ||
		typeof score.selected !== "string" ||
		(typeof score.incumbentMean !== "number" && score.incumbentMean !== null) ||
		(typeof score.candidateMean !== "number" && score.candidateMean !== null) ||
		(typeof score.incumbentMean === "number" && !Number.isFinite(score.incumbentMean)) ||
		(typeof score.candidateMean === "number" && !Number.isFinite(score.candidateMean))
	) {
		throw new Error("Final phase requires a verified frozen score selection for this candidate and task split.");
	}
	const recomputedScore = selectSkillCandidate({
		tasks,
		splitSeed,
		outcomes: verifiedScoreOutcomes,
		candidate,
		sourceHash,
		binding: expectedBinding,
	});
	const recomputedWinner = recomputedScore.selected === candidate.candidateHash ? "candidate" : "incumbent";
	if (
		value.winner !== recomputedWinner ||
		score.selected !== recomputedScore.selected ||
		reason !== recomputedScore.reason ||
		score.incumbentMean !== recomputedScore.incumbentMean ||
		score.candidateMean !== recomputedScore.candidateMean
	) {
		throw new Error("Frozen score selection does not match the verified score-run outcomes.");
	}
	const winner = value.winner;
	if (winner === "candidate") {
		if (
			reason !== "candidate-improved" ||
			score.selected !== candidate.candidateHash ||
			typeof score.incumbentMean !== "number" ||
			typeof score.candidateMean !== "number" ||
			score.candidateMean <= score.incumbentMean + expectedBinding.minimumImprovement
		) {
			throw new Error("Frozen candidate selection does not meet its predeclared score threshold.");
		}
	} else if (winner === "incumbent") {
		if (score.selected !== "incumbent") throw new Error("Frozen incumbent selection has an invalid selected arm.");
		if (
			reason === "candidate-not-better" &&
			(typeof score.incumbentMean !== "number" ||
				typeof score.candidateMean !== "number" ||
				score.candidateMean > score.incumbentMean + expectedBinding.minimumImprovement)
		) {
			throw new Error("Frozen incumbent selection contradicts its predeclared score threshold.");
		}
		if (
			reason === "incomplete-score-data" &&
			(score.incumbentMean !== null || score.candidateMean !== null)
		) {
			throw new Error("Incomplete frozen scores must not contain means.");
		}
		if (reason === "candidate-improved") throw new Error("Improved candidate cannot select the incumbent.");
	} else {
		throw new Error("Frozen skill selection has an invalid winner.");
	}
	const frozenScore: SkillSelection = Object.freeze({
		selected: score.selected,
		reason,
		incumbentMean: score.incumbentMean,
		candidateMean: score.candidateMean,
	});
	const verified: FrozenSkillSelection = Object.freeze({
		version: 1,
		kind: "veyyon-skill-selection",
		sourceHash,
		binding: candidate.binding,
		splitSeed,
		minimumImprovement: expectedBinding.minimumImprovement,
		candidateHash: candidate.candidateHash,
		winner,
		scoreTaskIds: Object.freeze([...scoreTaskIds].sort()),
		scoreRunHash: expectedScoreRunHash,
		score: frozenScore,
		createdAt: value.createdAt,
	});
	markFinalSkillSelectionVerified(verified);
	return verified;
}

