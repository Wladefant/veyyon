/**
 * WHY THIS SUITE EXISTS: an Azure OpenAI resource serves a model under the
 * deployment name its operator chose, and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`
 * (`model=deployment,...`) records that name. A request that sends the catalog
 * id instead reaches a deployment that does not exist and fails with an opaque
 * 404. Four request paths name a deployment: an Azure Responses turn (body
 * `model`), an Azure chat-completions turn (URL `/deployments/<name>`), Azure
 * server-side compaction (body `model`), and the remote summarizer when the
 * session model is an Azure one (body `model`). Two of them had their own copy
 * of the lookup, and no test read the variable at all.
 *
 * WHAT CLASS THIS CLOSES: a path that ignores the map, parses it differently,
 * maps a model that Azure does not serve, or lets the map override a deployment
 * the turn named explicitly. Every case runs against every path in `ROUTES`.
 *
 * WHAT IT DOES NOT CATCH: a fifth path that names a deployment without being
 * added to `ROUTES`; nothing at run time lists the request builders. The live
 * turn paths key the map by the local model id and the compaction paths by
 * `requestModelId ?? id`; no bundled Azure model sets `requestModelId`, and this
 * suite pins each path's key as it stands rather than reconciling them.
 */
import { describe, expect, test } from "bun:test";
import { requestRemoteCompaction } from "@veyyon/agent-core/compaction/remote-summarizer";
import type { Context, Message, Model } from "@veyyon/ai";
import { streamAzureOpenAIResponses } from "@veyyon/ai/providers/azure-openai-responses";
import { openAIResponsesServerCompaction } from "@veyyon/ai/providers/openai-compaction";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { buildModel } from "@veyyon/catalog/build";

const MAP_VAR = "AZURE_OPENAI_DEPLOYMENT_NAME_MAP";
const MODEL_ID = "gpt-5-mini";
const DATED_ID = "gpt-5-mini-2025-08-07";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const AZURE_RESPONSES_MODEL = buildModel({
	id: MODEL_ID,
	name: "GPT-5 Mini",
	api: "azure-openai-responses",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai/v1",
	reasoning: false,
	input: ["text"],
	cost: COST,
	contextWindow: 400_000,
	maxTokens: 128_000,
});

const AZURE_COMPLETIONS_MODEL = buildModel({
	id: MODEL_ID,
	name: "GPT-5 Mini",
	api: "openai-completions",
	provider: "azure",
	baseUrl: "https://example.openai.azure.com/openai",
	reasoning: false,
	input: ["text"],
	cost: COST,
	contextWindow: 400_000,
	maxTokens: 128_000,
});

const OPENAI_RESPONSES_MODEL = buildModel({
	id: MODEL_ID,
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: COST,
	contextWindow: 400_000,
	maxTokens: 128_000,
});

const TURN: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
const SPAN = [
	{ role: "user", content: "history msg" },
	{ role: "assistant", content: [{ type: "text", text: "history reply" }] },
] as Message[];

/** A compacted window the transport accepts: a retained item plus the opaque compaction item. */
const COMPACT_RESPONSE = {
	id: "resp_compact_deployment",
	object: "response.compaction",
	output: [
		{ id: "msg_000", type: "message", status: "completed", role: "user", content: [] },
		{ id: "cmp_001", type: "compaction", encrypted_content: "gAAAAABpM0Yj-fake" },
	],
	usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function chatCompletionSse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function bodyModel(init: RequestInit | undefined): string {
	return (JSON.parse(String(init?.body)) as { model: string }).model;
}

/** Run `fn` with the deployment map set to `map` (unset when undefined), restoring the previous value after. */
async function withDeploymentMap<T>(map: string | undefined, fn: () => Promise<T>): Promise<T> {
	const previous = Bun.env[MAP_VAR];
	if (map === undefined) delete Bun.env[MAP_VAR];
	else Bun.env[MAP_VAR] = map;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete Bun.env[MAP_VAR];
		else Bun.env[MAP_VAR] = previous;
	}
}

function azureResponsesTurn(model: Model<"azure-openai-responses">, azureDeploymentName?: string): Promise<string> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<string>();
	streamAzureOpenAIResponses(model, TURN, {
		apiKey: "azure-unit-test-key",
		azureBaseUrl: model.baseUrl,
		azureApiVersion: "v1",
		azureDeploymentName,
		signal: controller.signal,
		onPayload: payload => resolve((payload as { model: string }).model),
	});
	return promise;
}

async function azureCompletionsTurn(model: Model<"openai-completions">): Promise<string> {
	const urls: string[] = [];
	await streamOpenAICompletions(model, TURN, {
		apiKey: "azure-unit-test-key",
		fetch: async input => {
			urls.push(String(input));
			return chatCompletionSse();
		},
	}).result();
	expect(urls).toHaveLength(1);
	const segment = /\/deployments\/([^/]+)\/chat\/completions$/.exec(new URL(urls[0] ?? "").pathname);
	if (!segment?.[1]) throw new Error(`Expected a deployment-scoped chat-completions URL, got ${urls[0]}`);
	return segment[1];
}

async function serverCompaction(model: Model): Promise<string> {
	const models: string[] = [];
	await openAIResponsesServerCompaction.compact({
		model,
		messages: SPAN,
		apiKey: "unit-test-key",
		fetch: async (_input, init) => {
			models.push(bodyModel(init));
			return json(COMPACT_RESPONSE);
		},
	});
	expect(models).toHaveLength(1);
	return models[0] ?? "";
}

async function remoteSummarizer(model: Model): Promise<string> {
	const models: string[] = [];
	await requestRemoteCompaction(
		"https://summarizer.example/v1/chat/completions",
		{ systemPrompt: "sp", prompt: "p" },
		undefined,
		{
			model,
			fetch: async (_input, init) => {
				models.push(bodyModel(init));
				return json({ choices: [{ message: { content: "## Goal\nShip." } }] });
			},
		},
	);
	expect(models).toHaveLength(1);
	return models[0] ?? "";
}

/** Every request path that names an Azure deployment, each sending the model {@link MODEL_ID}. */
const ROUTES: Record<string, () => Promise<string>> = {
	"an Azure Responses turn": () => azureResponsesTurn(AZURE_RESPONSES_MODEL),
	"an Azure chat-completions turn": () => azureCompletionsTurn(AZURE_COMPLETIONS_MODEL),
	"Azure server-side compaction": () => serverCompaction(AZURE_RESPONSES_MODEL),
	"the remote summarizer for an Azure session": () => remoteSummarizer(AZURE_RESPONSES_MODEL),
};

const CASES: Array<{ name: string; map: string | undefined; deployment: string }> = [
	{ name: "a mapped model sends its deployment", map: `${MODEL_ID}=prod-mini`, deployment: "prod-mini" },
	{
		name: "padding and malformed entries around the mapping are skipped",
		map: ` , gpt-4o=prod-4o ,broken,=orphan, ${MODEL_ID} = prod-mini ,dangling=`,
		deployment: "prod-mini",
	},
	{ name: "an entry with no deployment leaves the id", map: `${MODEL_ID}=`, deployment: MODEL_ID },
	{ name: "an entry with no separator leaves the id", map: MODEL_ID, deployment: MODEL_ID },
	{ name: "a map that names other models leaves the id", map: "gpt-4o=prod-4o", deployment: MODEL_ID },
	{ name: "no map leaves the id", map: undefined, deployment: MODEL_ID },
];

describe("an Azure request names the deployment its model maps to", () => {
	for (const [route, send] of Object.entries(ROUTES)) {
		for (const { name, map, deployment } of CASES) {
			test(`${route}: ${name}`, async () => {
				expect(await withDeploymentMap(map, send)).toBe(deployment);
			});
		}
	}

	test("a deployment the turn names explicitly wins over the map", async () => {
		const sent = await withDeploymentMap(`${MODEL_ID}=prod-mini`, () =>
			azureResponsesTurn(AZURE_RESPONSES_MODEL, "explicit-deployment"),
		);
		expect(sent).toBe("explicit-deployment");
	});

	test("compaction and the summarizer map the wire id, not the local id", async () => {
		const dated: Model = { ...AZURE_RESPONSES_MODEL, requestModelId: DATED_ID };
		const both = `${MODEL_ID}=prod-local,${DATED_ID}=prod-dated`;
		expect(await withDeploymentMap(both, () => serverCompaction(dated))).toBe("prod-dated");
		expect(await withDeploymentMap(both, () => remoteSummarizer(dated))).toBe("prod-dated");
		const localOnly = `${MODEL_ID}=prod-local`;
		expect(await withDeploymentMap(localOnly, () => serverCompaction(dated))).toBe(DATED_ID);
		expect(await withDeploymentMap(localOnly, () => remoteSummarizer(dated))).toBe(DATED_ID);
	});

	test("a model Azure does not serve sends its id even when the map names it", async () => {
		const map = `${MODEL_ID}=prod-mini`;
		expect(await withDeploymentMap(map, () => serverCompaction(OPENAI_RESPONSES_MODEL))).toBe(MODEL_ID);
		expect(await withDeploymentMap(map, () => remoteSummarizer(OPENAI_RESPONSES_MODEL))).toBe(MODEL_ID);
	});
});
