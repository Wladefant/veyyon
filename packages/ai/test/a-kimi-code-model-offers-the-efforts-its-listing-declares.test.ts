/**
 * WHY: Kimi Code's K3.1 Pro offered Off, Low, High and Max with no default, while the Kimi Code client
 * offers Low, High and Max, opens at Max, and sends the chosen effort on every request. Three causes:
 * the models.dev key moved from `kimi-for-coding` to `kimi-code-plan-cn`, so the bundle never
 * received K3.1 Pro; discovery read `supports_reasoning` and ignored the listing's `reasoning` object,
 * which states each model's ladder, default and whether thinking can be turned off; and the Anthropic
 * wire sent a token budget with no effort, so Low and Max reached the endpoint as the same request.
 *
 * Class closed: every model the Kimi Code `/models` listing serves offers exactly the ladder, default
 * and off state its `reasoning` object declares, after the merge with the bundled row and the
 * models.dev overlay; every `reasoning` shape the parser distinguishes (`only`, `both`, `none`, no
 * effort block, an unlisted default, levels Veyyon does not know, no object, an unknown type) lands
 * where it should; every bundled and overlaid Kimi Code row with a ladder has no off state; and every
 * effort of every discovered model reaches both wires as the effort, with thinking kept on and a forced
 * tool choice dropped when the caller turns thinking off. The listing's ids are pinned by exact
 * equality, so a model added to the fixture without an expectation turns this suite red.
 *
 * NOT CAUGHT: whether the endpoint honours the efforts (there is no network here; the recorded probe
 * is what showed Low and Max spend different thinking tokens), and the level picker, which reads
 * `thinking` through coding-agent and has its own suite there.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageCreateParamsStreaming } from "@veyyon/ai/providers/anthropic-wire";
import { streamSimple } from "@veyyon/ai/stream";
import type { Context, Model, ThinkingConfig } from "@veyyon/ai/types";
import { getBundledModels } from "@veyyon/catalog";
import { Effort } from "@veyyon/catalog/effort";
import { createModelManager } from "@veyyon/catalog/model-manager";
import { defaultModelsDevFallback } from "@veyyon/catalog/modelsdev-overlay";
import { kimiCodeModelManagerOptions } from "@veyyon/catalog/provider-models/openai-compat";

/** The recorded Kimi Code `/models` listing, reduced to the fields discovery reads. */
const LISTING = [
	{
		id: "kimi-for-coding",
		display_name: "K2.8 Preview",
		context_length: 1048576,
		supports_reasoning: true,
		supports_image_in: true,
		reasoning: { type: "only", effort: { valid: ["low", "high", "max"], default: "max" } },
	},
	{
		id: "kimi-for-coding-highspeed",
		display_name: "K2.7 Code Highspeed",
		context_length: 262144,
		supports_reasoning: true,
		supports_image_in: true,
		reasoning: { type: "only" },
	},
	{
		id: "k3",
		display_name: "K3",
		context_length: 1048576,
		supports_reasoning: true,
		supports_image_in: true,
		reasoning: { type: "only", effort: { valid: ["low", "high", "max"], default: "high" } },
	},
	{
		id: "k3-256k",
		display_name: "K3-256k",
		context_length: 262144,
		supports_reasoning: true,
		supports_image_in: true,
		reasoning: { type: "only", effort: { valid: ["low", "high", "max"], default: "high" } },
	},
	{
		id: "k3.1-pro",
		display_name: "K3.1 Pro",
		context_length: 1048576,
		supports_reasoning: true,
		supports_image_in: true,
		reasoning: { type: "only", effort: { valid: ["low", "high", "max"], default: "max" } },
	},
	{
		id: "k3.1-pro-highspeed",
		display_name: "K3.1 Pro Highspeed",
		context_length: 1048576,
		supports_reasoning: true,
		supports_image_in: true,
		reasoning: { type: "only", effort: { valid: ["low", "high", "max"], default: "max" } },
	},
];

/** The surface a model's `thinking` states to the picker and the request mapping. */
interface Surface {
	efforts: readonly Effort[];
	defaultLevel: Effort | undefined;
	requiresEffort: boolean;
}

const LADDER = [Effort.Low, Effort.High, Effort.Max] as const;

/** What each listed model must offer; `undefined` is a model that reasons with no effort control. */
const EXPECTED: Record<string, Surface | undefined> = {
	"kimi-for-coding": { efforts: LADDER, defaultLevel: Effort.Max, requiresEffort: true },
	"kimi-for-coding-highspeed": undefined,
	k3: { efforts: LADDER, defaultLevel: Effort.High, requiresEffort: true },
	"k3-256k": { efforts: LADDER, defaultLevel: Effort.High, requiresEffort: true },
	"k3.1-pro": { efforts: LADDER, defaultLevel: Effort.Max, requiresEffort: true },
	"k3.1-pro-highspeed": { efforts: LADDER, defaultLevel: Effort.Max, requiresEffort: true },
};

const KEY = "test-key";
const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const FORCED_TITLE_CONTEXT: Context = {
	messages: [{ role: "user", content: "Name this session", timestamp: 0 }],
	tools: [
		{
			name: "set_title",
			description: "Set title",
			parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
		},
	],
};

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function surfaceOf(thinking: ThinkingConfig | undefined): Surface | undefined {
	if (thinking === undefined) return undefined;
	return {
		efforts: thinking.efforts,
		defaultLevel: thinking.defaultLevel,
		requiresEffort: thinking.requiresEffort === true,
	};
}

/** A Kimi Code server answering `/models` with `entries` and nothing else. */
function listingServer(entries: readonly object[]): typeof fetch {
	const handler = async (input: string | URL | Request): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.endsWith("/models")) return Response.json({ data: entries });
		return Response.json({ error: { message: "not served" } }, { status: 404 });
	};
	return Object.assign(handler, { preconnect: fetch.preconnect }) as typeof fetch;
}

/** The Kimi Code catalog the model manager resolves: bundled rows, the overlay, then the listing. */
async function discover(
	entries: readonly object[],
	overlay: Record<string, unknown> = {},
): Promise<Model<"openai-completions">[]> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-kimi-efforts-"));
	dirs.push(dir);
	const fallback = defaultModelsDevFallback<"openai-completions">("kimi-code");
	if (fallback === undefined) throw new Error("kimi-code has no models.dev descriptor");
	const manager = createModelManager({
		...kimiCodeModelManagerOptions({ apiKey: KEY, fetch: listingServer(entries) }),
		cacheDbPath: path.join(dir, "models.db"),
		modelsDev: { fetch: async () => overlay, map: fallback.map },
	});
	const { models } = await manager.refresh("online");
	return models;
}

function find(models: readonly Model<"openai-completions">[], id: string): Model<"openai-completions"> {
	const model = models.find(candidate => candidate.id === id);
	if (model === undefined) throw new Error(`discovery dropped ${id}`);
	return model;
}

describe("discovery", () => {
	it("gives every listed model the ladder, default and off state its listing declares", async () => {
		const models = await discover(LISTING);
		expect(Object.keys(EXPECTED).sort()).toEqual(LISTING.map(entry => entry.id).sort());
		for (const entry of LISTING) {
			const model = find(models, entry.id);
			expect({ id: entry.id, name: model.name, surface: surfaceOf(model.thinking) }).toEqual({
				id: entry.id,
				name: entry.display_name,
				surface: EXPECTED[entry.id],
			});
			expect(model.reasoning).toBe(true);
		}
	});

	const k3 = (reasoning: unknown) => [{ ...LISTING[2], reasoning }];

	it("offers an off state for `both`", async () => {
		const model = find(await discover(k3({ type: "both", effort: { valid: ["low", "max"], default: "low" } })), "k3");
		expect(surfaceOf(model.thinking)).toEqual({
			efforts: [Effort.Low, Effort.Max],
			defaultLevel: Effort.Low,
			requiresEffort: false,
		});
	});

	it("drops a default the entry does not list", async () => {
		const model = find(
			await discover(k3({ type: "only", effort: { valid: ["low", "high"], default: "max" } })),
			"k3",
		);
		expect(surfaceOf(model.thinking)).toEqual({
			efforts: [Effort.Low, Effort.High],
			defaultLevel: undefined,
			requiresEffort: true,
		});
	});

	it("offers no effort control for `none`, even where the bundled row has a ladder", async () => {
		const model = find(await discover(k3({ type: "none" })), "k3");
		expect(model.thinking).toBeUndefined();
	});

	it("offers no effort control for `only` without an effort block", async () => {
		const model = find(await discover(k3({ type: "only" })), "k3");
		expect(model.thinking).toBeUndefined();
	});

	/** No declaration the parser can read: the bundled ladder stands, with no off state and no default. */
	const BUNDLED: Surface = { efforts: LADDER, defaultLevel: undefined, requiresEffort: true };
	for (const [label, reasoning] of [
		["levels Veyyon does not know", { type: "only", effort: { valid: ["turbo"], default: "turbo" } }],
		["an unknown type", { type: "sometimes", effort: { valid: ["low"] } }],
		["no reasoning object", undefined],
	] as const) {
		it(`keeps the bundled ladder for ${label}`, async () => {
			const model = find(await discover(k3(reasoning)), "k3");
			expect(surfaceOf(model.thinking)).toEqual(BUNDLED);
		});
	}
});

describe("the bundle and the models.dev overlay", () => {
	it("offers no off state on any bundled Kimi Code row with a ladder", () => {
		const laddered = getBundledModels("kimi-code").filter(model => (model.thinking?.efforts.length ?? 0) > 0);
		expect(laddered.map(model => model.id).sort()).toEqual([
			"k3",
			"k3-256k",
			"k3.1-pro",
			"k3.1-pro-highspeed",
			"kimi-for-coding",
		]);
		for (const model of laddered) {
			expect({ id: model.id, requiresEffort: model.thinking?.requiresEffort }).toEqual({
				id: model.id,
				requiresEffort: true,
			});
		}
	});

	it("reads the overlay from the key models.dev lists Kimi Code under and marks its ladders always on", () => {
		const fallback = defaultModelsDevFallback("kimi-code");
		const row = (values: unknown[]) => ({
			name: "row",
			tool_call: true,
			reasoning: true,
			reasoning_options: [{ type: "effort", values }],
		});
		const mapped = fallback?.map(
			{
				"kimi-code-plan-cn": {
					models: {
						"k9-pro": row(["low", "high", "max"]),
						"k9-flex": row(["none", "low", "max"]),
						"k9-fast": { name: "row", tool_call: true, reasoning: true, reasoning_options: [] },
					},
				},
			},
			"kimi-code",
		);
		expect(Object.fromEntries((mapped ?? []).map(model => [model.id, model.reasoningOptions]))).toEqual({
			"k9-pro": { efforts: LADDER, requiresEffort: true },
			"k9-flex": { efforts: [Effort.Low, Effort.Max], requiresEffort: true },
			"k9-fast": { noEffortControl: true },
		});
	});
});

/** The reasoning and tool-choice fields a chat-completions turn sends. */
interface ChatBody {
	thinking?: unknown;
	reasoning_effort?: unknown;
	tool_choice?: unknown;
}

/** One turn: the effort the caller picked, or thinking turned off, with or without a forced tool. */
interface Turn {
	reasoning?: Effort;
	disableReasoning?: boolean;
	forceTitle?: boolean;
}

/** The body one turn sends on a wire, captured before it leaves the process. */
async function send(model: Model<"openai-completions">, format: "anthropic" | "openai", turn: Turn): Promise<unknown> {
	let body: unknown;
	await streamSimple(model, turn.forceTitle ? FORCED_TITLE_CONTEXT : CONTEXT, {
		apiKey: KEY,
		kimiApiFormat: format,
		maxTokens: 1024,
		reasoning: turn.reasoning,
		disableReasoning: turn.disableReasoning,
		...(turn.forceTitle ? { toolChoice: { type: "tool" as const, name: "set_title" } } : {}),
		onPayload: payload => {
			body = payload;
			throw new Error("captured");
		},
	}).result();
	if (body === undefined) throw new Error(`${model.id} sent no ${format} request`);
	return body;
}

async function anthropicBody(model: Model<"openai-completions">, turn: Turn): Promise<MessageCreateParamsStreaming> {
	const body: MessageCreateParamsStreaming = (await send(model, "anthropic", turn)) as MessageCreateParamsStreaming;
	return body;
}

async function chatBody(model: Model<"openai-completions">, turn: Turn): Promise<ChatBody> {
	const body: ChatBody = (await send(model, "openai", turn)) as ChatBody;
	return body;
}

/** The thinking block the Kimi Code client sends on its Anthropic wire. */
const ADAPTIVE = { type: "adaptive", display: "summarized" };

describe("the wire", () => {
	/** Every listed model with a ladder, as discovery resolves it. */
	async function laddered(): Promise<[Model<"openai-completions">, Surface][]> {
		const models = await discover(LISTING);
		const out: [Model<"openai-completions">, Surface][] = [];
		for (const [id, surface] of Object.entries(EXPECTED)) {
			if (surface !== undefined) out.push([find(models, id), surface]);
		}
		return out;
	}

	it("sends each effort of each model as the effort on both wires", async () => {
		for (const [model, surface] of await laddered()) {
			for (const effort of surface.efforts) {
				const anthropic = await anthropicBody(model, { reasoning: effort });
				expect<Record<string, unknown>>({
					id: model.id,
					thinking: anthropic.thinking,
					effort: anthropic.output_config?.effort,
				}).toEqual({
					id: model.id,
					thinking: ADAPTIVE,
					effort,
				});
				const chat = await chatBody(model, { reasoning: effort });
				expect({ id: model.id, thinking: chat.thinking, effort: chat.reasoning_effort }).toEqual({
					id: model.id,
					thinking: { type: "enabled" },
					effort,
				});
			}
		}
	});

	it("keeps thinking on at the lowest effort and drops a forced tool choice when the caller turns thinking off", async () => {
		for (const [model] of await laddered()) {
			const anthropic = await anthropicBody(model, { disableReasoning: true, forceTitle: true });
			expect<Record<string, unknown>>({
				id: model.id,
				thinking: anthropic.thinking,
				effort: anthropic.output_config?.effort,
				toolChoice: anthropic.tool_choice,
			}).toEqual({ id: model.id, thinking: ADAPTIVE, effort: Effort.Low, toolChoice: { type: "auto" } });
			const chat = await chatBody(model, { disableReasoning: true, forceTitle: true });
			expect({
				id: model.id,
				thinking: chat.thinking,
				effort: chat.reasoning_effort,
				toolChoice: chat.tool_choice,
			}).toEqual({ id: model.id, thinking: { type: "enabled" }, effort: Effort.Low, toolChoice: "auto" });
		}
	});
});
