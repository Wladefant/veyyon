/**
 * What the ChatGPT-subscription Codex endpoint does not say about its own models.
 *
 * `GET /codex/models` publishes a context window, a maximum and an effort ladder,
 * and nothing about prices, service-tier billing or the window OpenAI actually
 * honors. This module is that missing half, as data keyed by the served id, so
 * the discovery mapper and the generation pass read the same numbers. Ported
 * from oh-my-pi's `providers/openai-codex.kdl` (6d2bae2c41, 85f2a364ef,
 * df8d87207d, 682680e186, 93e95c7dfc).
 *
 * Not covered: the table is a snapshot. A SKU the endpoint adds later arrives
 * with the discovered window, the default tier multipliers and no price patch
 * until someone adds a row here.
 */
import { CODEX_BASE_URL } from "../wire/codex";
import type { LongContextCost, Model, ModelSpec } from "../types";

type CodexTier = NonNullable<Model["serviceTierCost"]>;
type CodexCost = Pick<Model["cost"], "input" | "output" | "cacheRead" | "cacheWrite">;

/** The worker `-wm` sibling of a SKU bills and windows like its plain id. */
const WORKER_SUFFIX = "-wm";

/** OpenAI enabled a 1M window for subscription GPT-5.6 (2026-08-16); the endpoint still reports 272K. */
export const CODEX_GPT_5_6_CONTEXT_WINDOW = 1_000_000;

const CODEX_GPT_5_6_FLOOR_IDS: Readonly<Record<string, true>> = {
	"gpt-5.6-luna": true,
	"gpt-5.6-sol": true,
	"gpt-5.6-terra": true,
};

/** flex halves the bill; priority doubles it, except where the subscription rates it higher. */
const DEFAULT_SERVICE_TIER_COST: CodexTier = { flex: 0.5, priority: 2 };
const PRIORITY_2_5_SERVICE_TIER_COST: CodexTier = { flex: 0.5, priority: 2.5 };
const PRIORITY_2_5_IDS: Readonly<Record<string, true>> = { "gpt-5.5": true, "gpt-6-astra": true };

/**
 * Curated extended-context ceilings. `/codex/models` reports an 872K maximum
 * (observed 2026-10-02) that an offline regeneration cannot see, so it is
 * recorded here. Astra and GPT-6.1 Sol report a stale 872K: OpenAI documents
 * 1.05M total with at most 922K input. A higher live maximum still wins.
 */
const CURATED_MAX_CONTEXT_WINDOW: Readonly<Record<string, number>> = {
	"gpt-5.6-luna": 872_000,
	"gpt-5.6-sol": 872_000,
	"gpt-5.6-terra": 872_000,
	"gpt-6-luna": 872_000,
	"gpt-6-sol": 872_000,
	"gpt-daybreak-blue-latest": 872_000,
	"gpt-6-astra": 922_000,
	"gpt-6.1-sol": 922_000,
};

/**
 * Subscription credit-equivalent pricing for SKUs the endpoint publishes no
 * price for: free cache writes, exempt from the API long-context multiplier.
 * The Daybreak aliases carry the standard GPT-5.6 Sol/Cyber list price so cost
 * reads as API-equivalent spend.
 */
const COST_PATCH: Readonly<Record<string, CodexCost>> = {
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
	"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
	"gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
	"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0 },
	"gpt-daybreak-blue-latest": { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
	"gpt-daybreak-red-latest": { input: 12.5, output: 75, cacheRead: 1.25, cacheWrite: 15.625 },
};

/**
 * Subscription Codex rates GPT-5.6 on the same whole-request premium tier as
 * the first-party API once prompt input passes 272K tokens (openai/codex#32486).
 */
const LONG_CONTEXT_COST: Readonly<Record<string, LongContextCost>> = {
	"gpt-5.6-luna": { inputThreshold: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
	"gpt-5.6-sol": { inputThreshold: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 },
	"gpt-5.6-terra": { inputThreshold: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 },
};

/** A table row for `key`, never an `Object.prototype` member of a served id like `constructor`. */
function own<V>(table: Readonly<Record<string, V>>, key: string): V | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

function plainId(id: string): string {
	return id.endsWith(WORKER_SUFFIX) ? id.slice(0, -WORKER_SUFFIX.length) : id;
}

/** The tier family of a GPT-5.6 id: `gpt-5.6-sol-pro` and a bare `gpt-5.6` price as Sol. */
function longContextKey(id: string): string | undefined {
	const plain = plainId(id);
	if (plain === "gpt-5.6") return "gpt-5.6-sol";
	for (const key of Object.keys(LONG_CONTEXT_COST)) {
		if (plain === key || plain.startsWith(`${key}-`)) return key;
	}
	return undefined;
}

/** The window a SKU holds even when the endpoint reports less, or `undefined` when it holds none. */
export function codexContextWindowFloor(id: string): number | undefined {
	return own(CODEX_GPT_5_6_FLOOR_IDS, plainId(id)) ? CODEX_GPT_5_6_CONTEXT_WINDOW : undefined;
}

/**
 * The extended-context ceiling: the larger of the live maximum and the curated
 * one, or `undefined` when neither exists.
 */
export function resolveCodexMaxContextWindow(id: string, live: number | undefined): number | undefined {
	const curated = own(CURATED_MAX_CONTEXT_WINDOW, plainId(id));
	if (live === undefined) return curated;
	return curated === undefined ? live : Math.max(live, curated);
}

/** Per-tier bill multipliers for one Codex SKU. */
export function codexServiceTierCost(id: string): CodexTier {
	return own(PRIORITY_2_5_IDS, plainId(id)) ? PRIORITY_2_5_SERVICE_TIER_COST : DEFAULT_SERVICE_TIER_COST;
}

/** The subscription price patch for one SKU, or `undefined` when the endpoint's own pricing stands. */
export function codexCostPatch(id: string): CodexCost | undefined {
	return own(COST_PATCH, plainId(id));
}

/** The >272K rate card for one SKU, or `undefined` when it bills one rate. */
export function codexLongContextCost(id: string): LongContextCost | undefined {
	const key = longContextKey(id);
	return key === undefined ? undefined : own(LONG_CONTEXT_COST, key);
}

/**
 * The Codex backend's hosted image tool. The backend ignores the `tool.model`
 * label and runs gpt-image-2-codex, and `/codex/models` never lists it, so the
 * catalog seeds it (53cca0393e, 3b9e426ae9). `kind: "image"` keeps it out of
 * chat model lists.
 */
export const CODEX_IMAGE_MODEL: ModelSpec<"openai-codex-responses"> = {
	id: "gpt-image-2",
	name: "GPT Image 2",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: CODEX_BASE_URL,
	kind: "image",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: null,
	supportsTools: false,
};
