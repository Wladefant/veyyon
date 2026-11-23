/**
 * Measurement for one context-compaction experiment run, and its projection
 * onto the offline scorer's sample row (Superboard `context_compaction_eval.py`).
 *
 * The meter reads only normalized {@link Usage} counters. It never sees prompts,
 * messages, output text or credentials, and the receipt carries none of them.
 */

import type { Model, Usage } from "@veyyon/ai";
import { resolveRequestCost } from "@veyyon/catalog";

const CASE_ID_PATTERN = /^[a-z0-9-]{1,80}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;
const SETTINGS_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARM_PATTERN = /^(?:baseline|36k-48k|24k-32k|\d{1,6}-\d{1,6})$/;
const AA_ARM_PATTERN = /^aa[1-5]$/;
/** Treatment arms the scorer accepts, besides `baseline`. */
const SCORER_TREATMENT_ARMS: Record<string, true> = {
	"36k-48k": true,
	"24k-32k": true,
	"12k-16k": true,
	"file-backed": true,
};

const RECEIPT_KEYS: Record<string, true> = {
	case_id: true,
	model: true,
	settings_sha256: true,
	arm: true,
	success: true,
	uncached_input_tokens: true,
	cache_read_tokens: true,
	cache_write_tokens: true,
	output_tokens: true,
	compactions: true,
	peak_context_tokens: true,
	wall_ms: true,
	long_context_price_tier_splits: true,
};
const SCORER_ROW_KEYS: Record<string, true> = {
	case: true,
	arm: true,
	success: true,
	tokens: true,
	compactions: true,
	peak_context: true,
	wall_ms: true,
};
const BUCKET_KEYS: Record<string, true> = { uncached: true, cache_read: true, cache_write: true, output: true };

/** One price tier's billed tokens, named as the scorer names its buckets. */
export interface CompactionTokenCounters {
	uncached: number;
	cache_read: number;
	cache_write: number;
	output: number;
}

/**
 * Billed tokens per catalog price tier. `standard` is always present. `long` is
 * present only when at least one request billed at the long-context card.
 */
export interface CompactionPriceTierSplits {
	standard: CompactionTokenCounters;
	long?: CompactionTokenCounters;
}

/** The measured outcome of one experiment run, with flat keys. */
export interface CompactionExperimentReceipt {
	case_id: string;
	/** `provider/id` of the model the run was billed against. */
	model: string;
	settings_sha256: string;
	arm: string;
	success: boolean;
	uncached_input_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	output_tokens: number;
	compactions: number;
	/** Largest single billed request's context, output included. */
	peak_context_tokens: number;
	wall_ms: number;
	long_context_price_tier_splits: CompactionPriceTierSplits;
}

/** One sample row as `context_compaction_eval.py` reads it. */
export interface CompactionScorerRow {
	case: string;
	arm: string;
	success: boolean;
	tokens: CompactionPriceTierSplits;
	compactions: number;
	peak_context: number;
	wall_ms: number;
}

type PriceTier = keyof CompactionPriceTierSplits;

interface MutableTierSplits {
	standard: CompactionTokenCounters;
	long: CompactionTokenCounters;
}

function requireCounter(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
	return value;
}

function optionalCounter(value: number | undefined, name: string): number {
	return value === undefined ? 0 : requireCounter(value, name);
}

/**
 * The catalog's own tier rule: the long card applies exactly when
 * `resolveRequestCost` returns it. A model without a long card is always standard.
 */
function priceTierOf(model: Model, usage: Usage): PriceTier {
	const tier = model.longContextCost;
	return tier !== undefined && resolveRequestCost(model, usage) === tier ? "long" : "standard";
}

function assertExactKeys(value: object, keys: Record<string, true>, name: string): void {
	const expected = Object.keys(keys);
	const actual = Object.keys(value);
	if (actual.length !== expected.length || actual.some(key => !Object.hasOwn(keys, key))) {
		throw new Error(`${name} has unexpected fields`);
	}
}

function validateCounters(value: unknown, name: string): CompactionTokenCounters {
	if (typeof value !== "object" || value === null) throw new Error(`${name} must be an object`);
	assertExactKeys(value, BUCKET_KEYS, name);
	const counters = value as CompactionTokenCounters;
	return {
		uncached: requireCounter(counters.uncached, `${name}.uncached`),
		cache_read: requireCounter(counters.cache_read, `${name}.cache_read`),
		cache_write: requireCounter(counters.cache_write, `${name}.cache_write`),
		output: requireCounter(counters.output, `${name}.output`),
	};
}

function validateSplits(value: unknown): CompactionPriceTierSplits {
	if (typeof value !== "object" || value === null) throw new Error("price tier splits must be an object");
	const splits = value as Record<string, unknown>;
	const keys = Object.keys(splits);
	if (!("standard" in splits) || keys.some(key => key !== "standard" && key !== "long")) {
		throw new Error("price tier splits must hold standard and optionally long");
	}
	const result: CompactionPriceTierSplits = {
		standard: validateCounters(splits.standard, "standard tier"),
	};
	if ("long" in splits) result.long = validateCounters(splits.long, "long tier");
	return result;
}

function sumTotals(splits: CompactionPriceTierSplits): CompactionTokenCounters {
	const total: CompactionTokenCounters = { uncached: 0, cache_read: 0, cache_write: 0, output: 0 };
	for (const counters of [splits.standard, splits.long]) {
		if (counters === undefined) continue;
		total.uncached += counters.uncached;
		total.cache_read += counters.cache_read;
		total.cache_write += counters.cache_write;
		total.output += counters.output;
	}
	return total;
}

function validateUsageShape(usage: Usage): void {
	requireCounter(usage.input, "usage.input");
	requireCounter(usage.output, "usage.output");
	requireCounter(usage.cacheRead, "usage.cacheRead");
	requireCounter(usage.cacheWrite, "usage.cacheWrite");
	optionalCounter(usage.orchestration?.input, "usage.orchestration.input");
	optionalCounter(usage.orchestration?.cacheRead, "usage.orchestration.cacheRead");
	optionalCounter(usage.orchestration?.output, "usage.orchestration.output");
	const discarded = usage.discarded;
	if (discarded === undefined) return;
	requireCounter(discarded.attempts, "usage.discarded.attempts");
	requireCounter(discarded.input, "usage.discarded.input");
	requireCounter(discarded.output, "usage.discarded.output");
	requireCounter(discarded.cacheRead, "usage.discarded.cacheRead");
	requireCounter(discarded.cacheWrite, "usage.discarded.cacheWrite");
	if (
		discarded.attempts === 0 &&
		(discarded.input > 0 || discarded.output > 0 || discarded.cacheRead > 0 || discarded.cacheWrite > 0)
	) {
		throw new Error("usage.discarded carries tokens without any attempts");
	}
}

/**
 * Accumulates one run's billed usage. Create it when the run starts, feed it
 * each response's {@link Usage} at the end of that response, then call
 * {@link finish} once.
 *
 * Token totals count orchestration tokens in the bucket the cost helper bills
 * them in: orchestration input and cache read join the uncached input and
 * cache read buckets, and orchestration output joins output.
 *
 * Peak context is the largest single billed request in the run: a delivered
 * response's input, cache read, cache write and output. A discarded aggregate
 * counts toward peak only when it holds exactly one attempt, because the
 * aggregate of several attempts does not give any one of them.
 */
export class CompactionExperimentMeter {
	readonly #caseId: string;
	readonly #settingsSha256: string;
	readonly #arm: string;
	readonly #model: Model;
	readonly #modelId: string;
	readonly #startedAt: number;
	#splits: MutableTierSplits = {
		standard: { uncached: 0, cache_read: 0, cache_write: 0, output: 0 },
		long: { uncached: 0, cache_read: 0, cache_write: 0, output: 0 },
	};
	#longSeen = false;
	#compactions = 0;
	#peak = 0;
	#gated = false;
	#finished = false;

	constructor(caseId: string, settingsSha256: string, arm: string, model: Model) {
		if (!CASE_ID_PATTERN.test(caseId)) throw new Error("case_id must match [a-z0-9-]{1,80}");
		if (!SETTINGS_SHA256_PATTERN.test(settingsSha256))
			throw new Error("settings_sha256 must be 64 lowercase hex digits");
		if (!ARM_PATTERN.test(arm)) throw new Error("arm must be baseline, 36k-48k, 24k-32k, or a numeric N-M");
		const modelId = `${model.provider}/${model.id}`;
		if (!MODEL_ID_PATTERN.test(modelId))
			throw new Error("model must be provider/id within the scorer's character set");
		this.#caseId = caseId;
		this.#settingsSha256 = settingsSha256;
		this.#arm = arm;
		this.#model = model;
		this.#modelId = modelId;
		this.#startedAt = performance.now();
	}

	/** Records one finished response's usage. Discarded attempts it reports are billed here too. */
	observe(usage: Usage): void {
		this.#assertOpen();
		validateUsageShape(usage);
		const orchestration = usage.orchestration;
		const tier = priceTierOf(this.#model, usage);
		this.#add(
			tier,
			usage.input + optionalCounter(orchestration?.input, "usage.orchestration.input"),
			usage.cacheRead + optionalCounter(orchestration?.cacheRead, "usage.orchestration.cacheRead"),
			usage.cacheWrite,
			usage.output + optionalCounter(orchestration?.output, "usage.orchestration.output"),
		);
		this.#notePeak(usage.input + usage.cacheRead + usage.cacheWrite + usage.output);
		if (usage.discarded !== undefined) this.#observeDiscarded(usage.discarded);
	}

	/** Counts one compaction pass that ran during the run. */
	noteCompaction(): void {
		this.#assertOpen();
		this.#compactions += 1;
	}

	/**
	 * Closes the run and returns its receipt.
	 *
	 * Throws when a discarded aggregate of several attempts could straddle the
	 * long-context threshold. Its per-attempt tiers are not recoverable, so the
	 * run has no supported receipt.
	 */
	finish(success: boolean): CompactionExperimentReceipt {
		this.#assertOpen();
		if (typeof success !== "boolean") throw new Error("success must be a boolean");
		if (this.#gated) {
			throw new Error(
				"compaction experiment receipt gated: a discarded aggregate of several attempts may straddle the long-context threshold; per-attempt tiers are unrecoverable",
			);
		}
		this.#finished = true;
		const splits: CompactionPriceTierSplits = { standard: { ...this.#splits.standard } };
		if (this.#longSeen) splits.long = { ...this.#splits.long };
		const totals = sumTotals(splits);
		return {
			case_id: this.#caseId,
			model: this.#modelId,
			settings_sha256: this.#settingsSha256,
			arm: this.#arm,
			success,
			uncached_input_tokens: totals.uncached,
			cache_read_tokens: totals.cache_read,
			cache_write_tokens: totals.cache_write,
			output_tokens: totals.output,
			compactions: this.#compactions,
			peak_context_tokens: this.#peak,
			wall_ms: Math.round(performance.now() - this.#startedAt),
			long_context_price_tier_splits: splits,
		};
	}

	#observeDiscarded(discarded: NonNullable<Usage["discarded"]>): void {
		if (discarded.attempts === 0) return;
		const aggregate: Usage = {
			input: discarded.input,
			output: discarded.output,
			cacheRead: discarded.cacheRead,
			cacheWrite: discarded.cacheWrite,
			totalTokens: discarded.input + discarded.output + discarded.cacheRead + discarded.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const tier = priceTierOf(this.#model, aggregate);
		// A standard aggregate bounds every attempt below the threshold, since each
		// attempt's prompt is a part of the sum. A long aggregate pins a single
		// attempt to the long card; with several attempts it may hold a mix.
		if (tier === "standard" || discarded.attempts === 1) {
			this.#add(tier, discarded.input, discarded.cacheRead, discarded.cacheWrite, discarded.output);
		} else {
			this.#gated = true;
		}
		if (discarded.attempts === 1) {
			this.#notePeak(discarded.input + discarded.cacheRead + discarded.cacheWrite + discarded.output);
		}
	}

	#add(tier: PriceTier, uncached: number, cacheRead: number, cacheWrite: number, output: number): void {
		const counters = this.#splits[tier];
		if (tier === "long") this.#longSeen = true;
		counters.uncached += uncached;
		counters.cache_read += cacheRead;
		counters.cache_write += cacheWrite;
		counters.output += output;
	}

	#notePeak(context: number): void {
		if (context > this.#peak) this.#peak = context;
	}

	#assertOpen(): void {
		if (this.#finished) throw new Error("compaction experiment meter is already finished");
	}
}

function resolveScorerArm(receiptArm: string, armOverride: string | undefined): string {
	const arm = armOverride ?? receiptArm;
	if (receiptArm === "baseline") {
		if (arm === "baseline" || AA_ARM_PATTERN.test(arm)) return arm;
		throw new Error("a baseline receipt may only be relabeled as baseline or an A/A control (aa1-aa5)");
	}
	if (AA_ARM_PATTERN.test(arm) || arm === "baseline" || !Object.hasOwn(SCORER_TREATMENT_ARMS, arm)) {
		throw new Error(`arm ${arm} is not a scorer treatment arm; pass a native preset as armOverride`);
	}
	return arm;
}

/**
 * Projects a receipt onto the scorer's sample row. `armOverride` maps a receipt
 * to the scorer's arm name: a native preset for a receipt whose arm is numeric,
 * or an A/A label (`aa1`-`aa5`) for a baseline receipt. It never relabels a
 * treatment as baseline.
 *
 * Throws on any receipt that holds extra or malformed fields, or whose token
 * splits do not sum to its flat totals.
 */
export function toCompactionScorerRow(receipt: CompactionExperimentReceipt, armOverride?: string): CompactionScorerRow {
	assertExactKeys(receipt, RECEIPT_KEYS, "compaction experiment receipt");
	if (!CASE_ID_PATTERN.test(receipt.case_id)) throw new Error("case_id must match [a-z0-9-]{1,80}");
	if (!MODEL_ID_PATTERN.test(receipt.model))
		throw new Error("model must be provider/id within the scorer's character set");
	if (!SETTINGS_SHA256_PATTERN.test(receipt.settings_sha256))
		throw new Error("settings_sha256 must be 64 lowercase hex digits");
	if (!ARM_PATTERN.test(receipt.arm)) throw new Error("arm must be baseline, 36k-48k, 24k-32k, or a numeric N-M");
	if (typeof receipt.success !== "boolean") throw new Error("success must be a boolean");
	const splits = validateSplits(receipt.long_context_price_tier_splits);
	const totals = sumTotals(splits);
	if (
		totals.uncached !== requireCounter(receipt.uncached_input_tokens, "uncached_input_tokens") ||
		totals.cache_read !== requireCounter(receipt.cache_read_tokens, "cache_read_tokens") ||
		totals.cache_write !== requireCounter(receipt.cache_write_tokens, "cache_write_tokens") ||
		totals.output !== requireCounter(receipt.output_tokens, "output_tokens")
	) {
		throw new Error("price tier splits do not sum to the receipt's token totals");
	}
	const row: CompactionScorerRow = {
		case: receipt.case_id,
		arm: resolveScorerArm(receipt.arm, armOverride),
		success: receipt.success,
		tokens: splits,
		compactions: requireCounter(receipt.compactions, "compactions"),
		peak_context: requireCounter(receipt.peak_context_tokens, "peak_context_tokens"),
		wall_ms: requireCounter(receipt.wall_ms, "wall_ms"),
	};
	assertExactKeys(row, SCORER_ROW_KEYS, "scorer row");
	return row;
}
