/**
 * Generic trial execution: drive one plan's cells through one execution backend and
 * score each with the suite that owns them.
 *
 * The engine knows nothing about Pier, Harbor, or in-process sessions. It owns four
 * things a per-suite runner kept re-implementing: a bounded worker pool, the mapping
 * from a thrown error to a scored-error row, cleanup that runs whether or not the
 * trial threw, and result order that follows the PLAN rather than completion time so
 * two runs of the same plan produce comparable records.
 */

import { setTimeout as sleepFor } from "node:timers/promises";
import { isVerifiedFinalSkillSelection } from "../skills/final-use";
import { errorMessage } from "@veyyon/utils";
import type {
	ExecutionBackend,
	HarnessLookup,
	RunContext,
	RunProvenance,
	TrialArtifacts,
	TrialCell,
	TrialScore,
} from "../contracts";
import type { EvalRunRecord, TrialResultRecord } from "./record";
import { requireVariantSupport, variantSupportQuery } from "../plan/variant-axes"
import { isRetryableTrialFailure, resolveTrialAttempts, trialRetryDelayMs } from "../trial/retry"
import { createRunRecord } from "./record";
import { preflightHarnesses } from "../harness/preflight";
import { requireRunDirectories } from "./directories";
import {
	cellKey,
	journalExists,
	journalPathFor,
	openRunJournal,
	ResumeWithoutJournalError,
	readRunJournal,
	requireJournalPlan,
	sanitizeTrialRecord,
} from "./journal";
import type { RunPlan } from "../plan/run-plan";
import { canonicalizeConfig } from "../plan/variant-matrix";
import { planIdentity } from "../plan/plan-identity";
import { finalExecutionFingerprint, claimFinalSkillUse, acquireFinalSkillRunLock } from "../skills/final-use";
import type { FinalSkillUseDeclaration } from "../skills/final-use";
import * as path from "node:path";
import { writeRunOutput } from "./output";
import { requireSkillArmSupport } from "../skills/binding";
import { cacheDir } from "../package-paths";

export class BackendPreflightError extends Error {
	readonly backendId: string;
	readonly missingRequirements: readonly string[];

	constructor(backendId: string, reason: string | null | undefined, missing: readonly string[] | undefined) {
		const detail = reason ?? "no reason given";
		const requirements = missing && missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
		super(`Execution backend "${backendId}" refused to start: ${detail}.${requirements}`);
		this.name = "BackendPreflightError";
		this.backendId = backendId;
		this.missingRequirements = missing ? [...missing] : [];
	}
}

export class SuitePreflightError extends Error {
	readonly suiteName: string;
	readonly missingRequirements: readonly string[];

	constructor(suiteName: string, reason: string | null | undefined, missing: readonly string[] | undefined) {
		const detail = reason ?? "no reason given";
		const requirements = missing && missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
		super(`Eval suite "${suiteName}" refused to start: ${detail}.${requirements}`);
		this.name = "SuitePreflightError";
		this.suiteName = suiteName;
		this.missingRequirements = missing ? [...missing] : [];
	}
}

export class HarnessPreflightError extends Error {
	readonly harness: string;
	readonly variant: string;
	readonly reason: string | null;
	readonly missingRequirements: readonly string[];

	constructor(
		harness: string,
		variant: string,
		reason: string | null | undefined,
		missing: readonly string[] | undefined,
	) {
		const detail = reason ?? "no reason given";
		const requirements = missing && missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "";
		super(`Harness "${harness}" refused preflight for variant "${variant}": ${detail}.${requirements}`);
		this.name = "HarnessPreflightError";
		this.harness = harness;
		this.variant = variant;
		this.reason = reason ?? null;
		this.missingRequirements = missing ? [...missing] : [];
	}
}

export class InvalidConcurrencyError extends Error {
	constructor(jobs: number) {
		super(`jobs must be an integer >= 1, got ${jobs}.`);
		this.name = "InvalidConcurrencyError";
	}
}

export interface ExecuteRunOptions {
	readonly plan: RunPlan;
	readonly backend: ExecutionBackend;
	readonly workDir: string;
	readonly runsDir: string;
	readonly harnesses: HarnessLookup;
	readonly jobs?: number;
	readonly signal?: AbortSignal;
	readonly provenance?: RunProvenance;
	/** Called as each trial settles, in completion order, for live progress. */
	readonly onTrial?: (record: TrialResultRecord, index: number) => void;
	/** Called when resuming an existing run and skipping already-settled cells. */
	readonly onSkip?: (skippedCount: number, total: number) => void;
	/** Required for the final skill phase; the durable claim is acquired before preflight. */
	readonly finalSkillUse?: FinalSkillUseDeclaration;
	/** Called before a retried attempt, with the attempt that just failed and why. */
	readonly onRetry?: (cell: TrialCell, failedAttempt: number, cause: unknown) => void;
	/** When true, read existing trials.jsonl and skip already-settled cells. */
	readonly resume?: boolean;
	readonly options?: Readonly<Record<string, unknown>>;
	/** Called when the suite's report renderer failed. The run and its record stand. */
	readonly onReportFailure?: (reason: string) => void;
	readonly now?: () => number;
	/** Waits between attempts. Injected so a suite does not sit through the backoff. */
	readonly sleep?: (ms: number) => Promise<void>;
}

function erroredScore(cause: unknown): TrialScore {
	return { reward: null, partial: null, error: errorMessage(cause), usage: null, extra: {} };
}

function requireFinalSkillUseDeclaration(plan: RunPlan, declaration: FinalSkillUseDeclaration): void {
	const binding = declaration.candidate.binding;
	const selection = declaration.selection;
	const planBinding = plan.skillBinding;
	const variant = plan.variants[0];
	const arm = variant?.skillArm;
	const model = declaration.candidate.resolvedModel;
	const suiteIdentity = binding.suiteIdentity;
	const planSuiteIdentity = planBinding?.suiteIdentity;
	const grader = typeof binding.graderHash === "string" ? binding.graderHash : "";
	const expectedModel = `${model.provider}/${model.id}@${model.version ?? "unknown"}`;
	const incumbentMean = selection.score.incumbentMean;
	const candidateMean = selection.score.candidateMean;
	const boundModel = binding.resolvedModel;
	const bindingModelMatches =
		typeof boundModel === "object" &&
		boundModel !== null &&
		"provider" in boundModel &&
		boundModel.provider === model.provider &&
		"id" in boundModel &&
		boundModel.id === model.id &&
		"version" in boundModel &&
		boundModel.version === model.version;
	const stableSuiteMatches =
		typeof suiteIdentity === "object" &&
		suiteIdentity !== null &&
		typeof planSuiteIdentity === "object" &&
		planSuiteIdentity !== null &&
		"suite" in suiteIdentity &&
		"version" in suiteIdentity &&
		"sha" in suiteIdentity &&
		"suite" in planSuiteIdentity &&
		"version" in planSuiteIdentity &&
		"sha" in planSuiteIdentity &&
		suiteIdentity.suite === planSuiteIdentity.suite &&
		suiteIdentity.version === planSuiteIdentity.version &&
		suiteIdentity.sha === planSuiteIdentity.sha;
	const candidateWinner = selection.winner === "candidate";
	const selectedArmMatches =
		candidateWinner
			? arm?.kind === "candidate" && arm.contentHash === declaration.candidate.candidateHash
			: selection.winner === "incumbent" && arm?.kind === "full" && arm.sourceHash === declaration.candidate.sourceHash;
	const scoreSelectionValid =
		candidateWinner
			? selection.score.reason === "candidate-improved" &&
				selection.score.selected === declaration.candidate.candidateHash &&
				typeof incumbentMean === "number" &&
				typeof candidateMean === "number" &&
				Number.isFinite(incumbentMean) &&
				Number.isFinite(candidateMean) &&
				candidateMean > incumbentMean + selection.minimumImprovement
			: selection.winner === "incumbent" &&
				selection.score.selected === "incumbent" &&
				((selection.score.reason === "candidate-not-better" &&
					typeof incumbentMean === "number" &&
					typeof candidateMean === "number" &&
					Number.isFinite(incumbentMean) &&
					Number.isFinite(candidateMean) &&
					candidateMean <= incumbentMean + selection.minimumImprovement) ||
					(selection.score.reason === "incomplete-score-data" &&
						incumbentMean === null &&
						candidateMean === null) ||
					(selection.score.reason === "unknown-model-revision" &&
						typeof incumbentMean === "number" &&
						typeof candidateMean === "number" &&
						Number.isFinite(incumbentMean) &&
						Number.isFinite(candidateMean)));
	if (
		plan.skillPhase !== "final" ||
		!isVerifiedFinalSkillSelection(selection) ||
		!planBinding ||
		plan.variants.length !== 1 ||
		!variant ||
		!selectedArmMatches ||
		arm?.sourceHash !== declaration.candidate.sourceHash ||
		!model.provider ||
		!model.id ||
		(selection.winner === "candidate" && !model.version) ||
		!declaration.candidate.candidateHash ||
		declaration.candidate.sourceHash !== binding.sourceHash ||
		typeof binding.datasetFingerprint !== "string" ||
		typeof binding.splitFingerprint !== "string" ||
		!bindingModelMatches ||
		!stableSuiteMatches ||
		binding.buildHash !== planBinding.buildHash ||
		binding.registryHash !== planBinding.registryHash ||
		binding.graderHash !== planBinding.graderHash ||
		binding.criteriaHash !== planBinding.criteriaHash ||
		!Array.isArray(binding.requestedModels) ||
		!binding.requestedModels.includes(variant.model) ||
		declaration.identity.sourceHash !== declaration.candidate.sourceHash ||
		declaration.identity.datasetFingerprint !== binding.datasetFingerprint ||
		declaration.identity.splitFingerprint !== binding.splitFingerprint ||
		declaration.identity.model !== expectedModel ||
		declaration.identity.harness !== variant.harness ||
		declaration.identity.grader !== grader ||
		selection.candidateHash !== declaration.candidate.candidateHash ||
		selection.sourceHash !== declaration.candidate.sourceHash ||
		!/^[a-f0-9]{64}$/.test(selection.scoreRunHash) ||
		canonicalizeConfig(selection.binding) !== canonicalizeConfig(binding) ||
		!Number.isFinite(selection.minimumImprovement) ||
		selection.minimumImprovement !== binding.minimumImprovement ||
		!scoreSelectionValid
	) {
		throw new Error("Final skill execution requires a verified frozen score selection and resolved model revision.");
	}
}

function executionFingerprint(options: ExecuteRunOptions): string {
	const { plan } = options;
	return finalExecutionFingerprint({
		planIdentity: planIdentity(plan),
		runId: plan.runId,
		runsDir: options.runsDir,
		tasks: plan.tasks.map(task => task.id),
		repeats: plan.repeats,
		cells: plan.cells,
		options: options.options ?? {},
		jobs: options.jobs ?? 1,
	});
}

/**
 * Runs every cell in the plan after the public final-use guard has accepted its declaration.
 */
async function executeRunBody(options: ExecuteRunOptions): Promise<EvalRunRecord> {
	const jobs = options.jobs ?? 1;
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new InvalidConcurrencyError(jobs);
	}

	const { plan, backend } = options;
	requireSkillArmSupport(plan.variants, backend.id);
	const clock = options.now ?? (() => Date.now());
	const datasetDir = typeof options.options?.datasetDir === "string" ? options.options.datasetDir : undefined;
	const context: RunContext = {
		runId: plan.runId,
		suite: plan.suite,
		workDir: options.workDir,
		runsDir: options.runsDir,
		datasetDir,
		signal: options.signal,
		harnesses: options.harnesses,
		options: {
			...options.options,
			variants: plan.variants,
		},
	};

	// Every directory this run reaches, before any of them is written to. A runs directory
	// that is a regular file, or a work directory that does not exist, otherwise fails after
	// preflight said `ok` — one as an ENOTDIR from `fs.mkdir`, the other as a backend
	// spawning into nothing.
	await requireRunDirectories({
		runsDir: options.runsDir,
		workDir: options.workDir,
		datasetDir,
	});

	// A resume names a prior run. When that run has no journal, the honest outcome is a
	// refusal: a mistyped --run-id otherwise reads as a fresh run and pays for every task
	// the operator believed was already settled. Checked before any preflight, because
	// nothing about this invocation can be fixed by staging assets.
	if (options.resume && !(await journalExists(options.runsDir, plan.runId))) {
		throw new ResumeWithoutJournalError(journalPathFor(options.runsDir, plan.runId), plan.runId);
	}

	// A run id names one plan. The cell key does not carry the model of a single-model run,
	// so resuming under a different --model matched the prior model's trials as settled and
	// reported them as this arm's; a rerun without --resume appended to the same journal.
	await requireJournalPlan(options.runsDir, plan.runId, planIdentity(plan));

	// An axis nobody applies is refused before a preflight can say `ok`. A dropped
	// `--prompts` path otherwise runs the whole matrix and reports two identical arms as a
	// comparison.
	requireVariantSupport(variantSupportQuery(backend, plan.variants, harness => options.harnesses.require(harness).capabilities));

	const suiteVerdict = await plan.suite.preflight(plan.context);
	if (!suiteVerdict.ok) {
		throw new SuitePreflightError(plan.suite.id, suiteVerdict.reason, suiteVerdict.missingRequirements);
	}

	const harnessReports = await preflightHarnesses(plan.variants, {
		backend: plan.suite.backend,
		harnesses: options.harnesses,
		options: context.options,
		signal: options.signal,
	});
	for (const report of harnessReports) {
		if (!report.verdict.ok) {
			throw new HarnessPreflightError(
				report.harness,
				report.variant,
				report.verdict.reason,
				report.verdict.missingRequirements,
			);
		}
	}

	const backendVerdict = await backend.preflight(context);
	if (!backendVerdict.ok) {
		throw new BackendPreflightError(backend.id, backendVerdict.reason, backendVerdict.missingRequirements);
	}

	await backend.prepare(context);

	const journal = await openRunJournal(options.runsDir, plan.runId, planIdentity(plan));

	const results = new Array<TrialResultRecord | undefined>(plan.cells.length);
	let nextIndex = 0;
	let settled = 0;

	if (options.resume) {
		const priorRecords = await readRunJournal(options.runsDir, plan.runId);
		const settledMap = new Map<string, TrialResultRecord>();
		for (const record of priorRecords) {
			settledMap.set(cellKey(record.cell), record);
		}
		let skipped = 0;
		for (let i = 0; i < plan.cells.length; i++) {
			const cell = plan.cells[i];
			if (cell) {
				const existing = settledMap.get(cellKey(cell));
				if (existing) {
					results[i] = existing;
					skipped++;
				}
			}
		}
		settled = skipped;
		if (skipped > 0) {
			options.onSkip?.(skipped, plan.cells.length);
		}
	}

	const attemptsAllowed = resolveTrialAttempts(context.options);
	// A cancel ends the backoff: the run stops rather than waiting out a delay for an attempt it
	// will not make.
	const sleep =
		options.sleep ??
		(async (ms: number) => {
			await sleepFor(ms, undefined, { signal: options.signal }).catch(() => {});
		});

	const runOne = async (cell: TrialCell, index: number): Promise<void> => {
		const startedAtMs = clock();
		const startedAt = new Date(startedAtMs).toISOString();
		let artifacts: TrialArtifacts | undefined;
		let score: TrialScore;
		let attempt = 0;
		// A trial that threw measured nothing, so the task is lost unless it is attempted again.
		// A graded outcome — including a trial that spent its whole deadline — is never retried.
		// Every attempt cleans up after itself: a retry starts from the state a fresh trial would.
		// A trial the run's cancellation cut short settled nothing: it gets no row, in the journal
		// or the record, so a resume of the run runs it.
		for (;;) {
			attempt += 1;
			try {
				artifacts = await backend.runTrial(cell, context);
				if (options.signal?.aborted || artifacts.extra?.cancelled === true) return;
				score = await plan.suite.scoreTrial(cell, artifacts);
				break;
			} catch (cause) {
				if (options.signal?.aborted) return;
				if (attempt >= attemptsAllowed || !isRetryableTrialFailure(cause, options.signal)) {
					score = erroredScore(cause);
					break;
				}
				options.onRetry?.(cell, attempt, cause);
			} finally {
				// Runs before either `break` takes effect, so every attempt cleans up exactly once.
				try {
					await backend.cleanup(cell, context);
				} catch {
					// A cleanup failure must not discard a scored trial, and must not stop a retry.
					// The backend owns reporting it; losing the row would be the larger loss.
				}
			}
			await sleep(trialRetryDelayMs(attempt + 1));
			if (options.signal?.aborted) return;
		}
		if (attempt > 1) score = { ...score, extra: { ...score.extra, attempts: attempt } };
		const finishedAtMs = clock();
		const record: TrialResultRecord = sanitizeTrialRecord({
			cell,
			score,
			artifacts,
			startedAt,
			finishedAt: new Date(finishedAtMs).toISOString(),
			durationMs: finishedAtMs - startedAtMs,
		});
		await journal.append(record);
		results[index] = record;
		options.onTrial?.(record, settled++);
	};

	// A trial that cannot be recorded ends the run. `Promise.all` rejects on the first
	// failure while every other worker keeps pulling cells, so a runs directory that filled
	// up mid-run, or a score holding a value JSON cannot write, went on paying for trials
	// whose rows were then appended to a closed handle. The failure is held and rethrown
	// once every worker has stopped, so nothing outlives this call.
	const failures: unknown[] = [];

	const worker = async (): Promise<void> => {
		while (true) {
			if (failures.length > 0) return;
			if (options.signal?.aborted) return;
			const index = nextIndex++;
			if (index >= plan.cells.length) return;
			if (results[index] !== undefined) continue;
			const cell = plan.cells[index];
			if (!cell) continue;
			try {
				await runOne(cell, index);
			} catch (cause) {
				failures.push(cause);
				return;
			}
		}
	};

	try {
		await Promise.all(Array.from({ length: Math.min(jobs, plan.cells.length) }, worker));
		if (failures.length > 0) throw failures[0];
	} finally {
		await journal.close();
	}

	const record = createRunRecord({
		id: plan.runId,
		suite: {
			name: plan.suite.id,
			version: plan.suite.version,
			provenanceSha: plan.provenance.sha ?? null,
		},
		variants: plan.variants,
		tasks: plan.tasks.map(task => task.id),
		repeats: plan.repeats,
		results: results.filter((record): record is TrialResultRecord => record !== undefined),
		provenance: options.provenance,
		completedAt: new Date(clock()).toISOString(),
		...(plan.skillBinding ? { metadata: { skillBinding: plan.skillBinding, skillPhase: plan.skillPhase ?? "unverified", cancelled: options.signal?.aborted === true } } : {}),
	});

	// The run's own directory states what it measured. Without this a finished run left one
	// journal of raw rows: `mergeIntoReport` refused the directory, the manager's snapshot
	// found no results, and the only report was the summary already scrolled off a terminal.
	const reportFailure = await writeRunOutput({
		runsDir: options.runsDir,
		suite: plan.suite,
		record,
		models: plan.variants.map(variant => variant.model),
		tasks: record.tasks,
		repeats: plan.repeats,
	});
	if (reportFailure !== null) options.onReportFailure?.(reportFailure);

	return record;
}
/** Execute a run, claiming any final skill holdout before preflight or backend work. */
export async function executeRun(options: ExecuteRunOptions): Promise<EvalRunRecord> {
	if (options.plan.skillPhase !== "final") {
		if (options.finalSkillUse) throw new Error("A final skill-use declaration is valid only for a final skill phase.");
		return executeRunBody(options);
	}
	const declaration = options.finalSkillUse;
	if (!declaration) throw new Error("Final skill execution requires a frozen candidate-use declaration.");
	requireFinalSkillUseDeclaration(options.plan, declaration);
	const fingerprint = executionFingerprint(options);
	if (declaration.executionFingerprint !== fingerprint) {
		throw new Error("Final skill-use declaration does not match this exact plan, run id, task set, repeats, or options.");
	}
	const claimPath = await claimFinalSkillUse(path.join(cacheDir(), "skill-final-claims"), declaration.identity, {
		candidateHash: declaration.candidate.candidateHash,
		executionFingerprint: fingerprint,
		resume: options.resume,
	});
	const releaseLock = await acquireFinalSkillRunLock(claimPath, fingerprint);
	try {
		return await executeRunBody(options);
	} finally {
		await releaseLock();
	}
}
