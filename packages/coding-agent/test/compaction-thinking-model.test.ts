/**
 * Compaction summary requests on thinking models stay inside their output budget.
 *
 * A summary request asks for `maxTokens` of output at a reasoning effort. Enabled thinking
 * needs its `budget_tokens` (or Gemini `thinkingBudget`) below the request's output cap, or the
 * provider rejects the request. These cases drive `generateSummary` through the real request
 * builder and read the body each provider puts on the wire. The fetch is an offline fixture
 * that answers 400, so nothing streams and no credentials are needed.
 */
import { describe, expect, it } from "bun:test";
import { type AgentMessage, ThinkingLevel } from "@veyyon/agent-core";
import { generateSummary } from "@veyyon/agent-core/compaction";
import type { FetchImpl, Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { ModelSpec } from "@veyyon/catalog/types";

const conversation: AgentMessage[] = [
	{ role: "user", content: [{ type: "text", text: "Refactor the parser to stream tokens." }], timestamp: 1 },
];

/** `summaryOutputBudget` gives 80% of the reserve to the summary: floor(0.8 × reserve). */
const summaryBudget = (reserveTokens: number): number => Math.floor(0.8 * reserveTokens);

interface AnthropicWire {
	max_tokens: number;
	thinking?: { type: string; budget_tokens?: number };
}

interface GeminiWire {
	request?: {
		generationConfig?: {
			maxOutputTokens?: number;
			thinkingConfig?: { thinkingBudget?: number };
		};
	};
}

function anthropicBudgetModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"anthropic-messages">);
}

function anthropicAdaptiveModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		},
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	} satisfies ModelSpec<"anthropic-messages">);
}

/** Claude routed through Antigravity: the same request, carried by the Cloud Code `google-gemini-cli` wire. */
function antigravityClaudeModel(): Model<"google-gemini-cli"> {
	return buildModel({
		id: "claude-sonnet-4-6",
		requestModelId: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortRouting: {
				off: "claude-sonnet-4-6",
				[Effort.Minimal]: "claude-sonnet-4-6-thinking",
				[Effort.Low]: "claude-sonnet-4-6-thinking",
				[Effort.Medium]: "claude-sonnet-4-6-thinking",
				[Effort.High]: "claude-sonnet-4-6-thinking",
			},
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	} satisfies ModelSpec<"google-gemini-cli">);
}

/**
 * Run one summary request at High effort and return every body the provider sent. The fetch
 * stops each request with a 400 after its body is recorded, so the summary error that follows
 * is expected; the assertions below require at least one captured body.
 */
async function captureSummaryBodies(
	model: Model,
	reserveTokens: number,
	apiKey: string,
): Promise<Record<string, unknown>[]> {
	const bodies: Record<string, unknown>[] = [];
	const fetch: FetchImpl = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return new Response('{"error":{"message":"offline fixture"}}', { status: 400 });
	};
	await generateSummary(conversation, model, reserveTokens, apiKey, undefined, undefined, undefined, {
		fetch,
		thinkingLevel: ThinkingLevel.High,
	}).catch(() => undefined);
	return bodies;
}

describe("Compaction summary thinking budget on Anthropic", () => {
	it.each([16_384, 4_096])(
		"keeps a budget-mode thinking budget under the summary cap (reserve %i)",
		async reserveTokens => {
			const model = anthropicBudgetModel();
			const bodies = await captureSummaryBodies(model, reserveTokens, "test-key");
			expect(bodies.length).toBeGreaterThan(0);
			for (const body of bodies) {
				const wire = body as unknown as AnthropicWire;
				expect(wire.max_tokens).toBeGreaterThanOrEqual(summaryBudget(reserveTokens));
				expect(wire.max_tokens).toBeLessThanOrEqual(model.maxTokens);
				expect(wire.thinking?.type).toBe("enabled");
				expect(wire.thinking?.budget_tokens).toBeGreaterThan(0);
				expect(wire.thinking?.budget_tokens).toBeLessThan(wire.max_tokens);
			}
		},
	);

	it.each([16_384, 4_096])(
		"sends adaptive thinking without a budget that could exceed the summary cap (reserve %i)",
		async reserveTokens => {
			const model = anthropicAdaptiveModel();
			const bodies = await captureSummaryBodies(model, reserveTokens, "test-key");
			expect(bodies.length).toBeGreaterThan(0);
			for (const body of bodies) {
				const wire = body as unknown as AnthropicWire;
				expect(wire.max_tokens).toBeGreaterThanOrEqual(summaryBudget(reserveTokens));
				expect(wire.max_tokens).toBeLessThanOrEqual(model.maxTokens);
				expect(wire.thinking?.type).toBe("adaptive");
				expect(wire.thinking?.budget_tokens).toBeUndefined();
			}
		},
	);
});

describe("Compaction summary thinking budget on Antigravity", () => {
	it.each([16_384, 4_096])(
		"keeps a Claude thinking budget under the summary cap (reserve %i)",
		async reserveTokens => {
			const model = antigravityClaudeModel();
			const apiKey = JSON.stringify({ token: "token", projectId: "proj-123" });
			const bodies = await captureSummaryBodies(model, reserveTokens, apiKey);
			expect(bodies.length).toBeGreaterThan(0);
			for (const body of bodies) {
				const generation = (body as unknown as GeminiWire).request?.generationConfig;
				const maxOutputTokens = generation?.maxOutputTokens;
				expect(maxOutputTokens).toBeGreaterThanOrEqual(summaryBudget(reserveTokens));
				expect(maxOutputTokens).toBeLessThanOrEqual(model.maxTokens);
				const budget = generation?.thinkingConfig?.thinkingBudget;
				expect(budget).toBeGreaterThan(0);
				expect(budget).toBeLessThan(maxOutputTokens ?? 0);
			}
		},
	);
});
