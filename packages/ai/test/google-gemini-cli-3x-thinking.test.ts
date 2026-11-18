import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@veyyon/ai";
import { streamSimple } from "@veyyon/ai/stream";
import type { Context, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { ThinkingConfig } from "@veyyon/catalog/types";

// Declared thinking surfaces per fixture id. models.dev does not catalog the
// cloudcode-pa endpoint, so these mirror the endpoint-verified CCA collapse
// families (geminiProFamily/geminiFlashFamily on the google-level transport,
// budget mode for 2.5): a bare spec derives NO surface, and identity-derived
// ladders are gone.
const FIXTURE_THINKING: Record<string, ThinkingConfig> = {
	"gemini-3.1-pro-preview": { mode: "google-level", efforts: [Effort.Low, Effort.High] },
	"gemini-3.1-flash-preview": {
		mode: "google-level",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	"gemini-2.5-pro": {
		mode: "budget",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
};

interface GeminiCliThinkingConfig {
	thinkingLevel?: string;
	thinkingBudget?: number;
	includeThoughts?: boolean;
}

interface CapturedRequestBody {
	model?: string;
	request?: {
		generationConfig?: {
			thinkingConfig?: GeminiCliThinkingConfig;
		};
	};
}

function createModel(id: string): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-gemini-cli",
		baseUrl: "https://cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking: FIXTURE_THINKING[id],
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	});
}

function createHydrogenModel(
	id: string,
	thinking: ThinkingConfig,
	provider = "google-antigravity",
): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider,
		baseUrl: "https://daily-cloudcode-pa.googleapis.com",
		reasoning: true,
		thinking,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	});
}

const HYDROGEN_XHIGH = "gemini-4-hydrogen-xhigh";
const hydrogenXHighLegacy = createHydrogenModel(HYDROGEN_XHIGH, {
	mode: "budget",
	efforts: [Effort.XHigh],
	requiresEffort: true,
});
const hydrogenLogicalRouted = createHydrogenModel("gemini-4-hydrogen", {
	mode: "google-level",
	efforts: [Effort.Medium, Effort.XHigh],
	requiresEffort: true,
	effortRouting: {
		[Effort.Medium]: "gemini-4-hydrogen",
		[Effort.XHigh]: HYDROGEN_XHIGH,
	},
});
const hydrogenMedium = createHydrogenModel("gemini-4-hydrogen-medium", {
	mode: "google-level",
	efforts: [Effort.Medium],
	requiresEffort: true,
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function extractThinking(bodyText: string | undefined): GeminiCliThinkingConfig | undefined {
	if (!bodyText) return undefined;
	const parsed = JSON.parse(bodyText) as CapturedRequestBody;
	return parsed.request?.generationConfig?.thinkingConfig;
}

describe("google-gemini-cli Gemini 3.x thinking mapping", () => {
	const createFetchMock =
		(capture: (body: string | undefined) => void): FetchImpl =>
		(_input, init) => {
			capture(typeof init?.body === "string" ? init.body : undefined);
			return Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
		};
	it("routes the raw Antigravity xhigh SKU without adding thinkingConfig", async () => {
		let requestBody: string | undefined;
		const stream = streamSimple(hydrogenXHighLegacy, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.XHigh,
			fetch: createFetchMock(body => {
				requestBody = body;
			}),
		});
		await stream.result();

		const parsed = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(parsed.model).toBe("gemini-4-hydrogen-xhigh");
		expect(parsed.request?.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("omits thinkingConfig when logical Hydrogen routing resolves to the fixed xhigh SKU", async () => {
		let requestBody: string | undefined;
		const stream = streamSimple(hydrogenLogicalRouted, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.XHigh,
			fetch: createFetchMock(body => {
				requestBody = body;
			}),
		});
		await stream.result();

		const parsed = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(parsed.model).toBe("gemini-4-hydrogen-xhigh");
		expect(parsed.request?.generationConfig?.thinkingConfig).toBeUndefined();
	});

	it("keeps explicit Hydrogen medium on its routed model with a medium level", async () => {
		let requestBody: string | undefined;
		const model = createHydrogenModel("gemini-4-hydrogen", {
			mode: "google-level",
			efforts: [Effort.Medium],
			requiresEffort: true,
			effortRouting: { [Effort.Medium]: "gemini-4-hydrogen-medium" },
		});
		const stream = streamSimple(model, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
			fetch: createFetchMock(body => {
				requestBody = body;
			}),
		});
		await stream.result();

		const parsed = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(parsed.model).toBe("gemini-4-hydrogen-medium");
		expect(parsed.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe("MEDIUM");
		expect(parsed.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeUndefined();
	});

	it("keeps Hydrogen medium default behavior on the base model", async () => {
		let requestBody: string | undefined;
		const stream = streamSimple(hydrogenMedium, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			fetch: createFetchMock(body => {
				requestBody = body;
			}),
		});
		await stream.result();

		const parsed = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(parsed.model).toBe("gemini-4-hydrogen-medium");
		expect(parsed.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe("MEDIUM");
		expect(parsed.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeUndefined();
	});
	it("preserves explicit thinking-off suppression on a Hydrogen model", async () => {
		let requestBody: string | undefined;
		const model = createHydrogenModel("gemini-4-hydrogen", {
			mode: "google-level",
			efforts: [Effort.Low, Effort.Medium],
			requiresEffort: true,
			suppressWhenOff: true,
		});
		const stream = streamSimple(model, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			forceReasoningOff: true,
			fetch: createFetchMock(body => {
				requestBody = body;
			}),
		});
		await stream.result();

		const parsed = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(parsed.model).toBe("gemini-4-hydrogen");
		expect(parsed.request?.generationConfig?.thinkingConfig).toEqual({
			includeThoughts: false,
			thinkingLevel: "LOW",
		});
	});
	it("uses thinkingLevel for gemini-3.1-pro-preview when the effort is supported", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-pro-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("HIGH");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("keeps Cloud Code Assist reasoning enabled when only summaries are hidden", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-pro-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.High,
			hideThinkingSummary: true,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.includeThoughts).toBe(false);
		expect(thinking?.thinkingLevel).toBe("HIGH");
	});

	it("rejects unsupported gemini-3.1-pro-preview efforts instead of promoting them", () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		expect(() =>
			streamSimple(createModel("gemini-3.1-pro-preview"), context, {
				apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
				reasoning: Effort.Medium,
				fetch: fetchMock,
			}),
		).toThrow(/Supported efforts: low, high/);
		expect(requestBody).toBeUndefined();
	});

	it("uses thinkingLevel for gemini-3.1-flash-preview", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-3.1-flash-preview"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBe("MEDIUM");
		expect(thinking?.thinkingBudget).toBeUndefined();
	});

	it("keeps thinkingBudget for gemini-2.5-pro", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const stream = streamSimple(createModel("gemini-2.5-pro"), context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Medium,
			fetch: fetchMock,
		});
		await stream.result();

		const thinking = extractThinking(requestBody);
		expect(thinking?.thinkingLevel).toBeUndefined();
		expect(thinking?.thinkingBudget).toBeDefined();
	});
	it("sends LOW not MINIMAL when gemini-3.7-flash minimal aliases the -low SKU", async () => {
		let requestBody: string | undefined;
		const fetchMock = createFetchMock(body => {
			requestBody = body;
		});

		const model = buildModel({
			id: "gemini-3.7-flash",
			name: "Gemini 3.7 Flash",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				requiresEffort: true,
				effortRouting: {
					[Effort.Minimal]: "gemini-3.7-flash-low",
					[Effort.Low]: "gemini-3.7-flash-low",
					[Effort.Medium]: "gemini-3.7-flash-medium",
					[Effort.High]: "gemini-3.7-flash-high",
				},
			},
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		});

		const stream = streamSimple(model, context, {
			apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
			reasoning: Effort.Minimal,
			fetch: fetchMock,
		});
		await stream.result();

		const parsed = JSON.parse(requestBody ?? "{}") as CapturedRequestBody;
		expect(parsed.model).toBe("gemini-3.7-flash-low");
		expect(parsed.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe("LOW");
	});
});
