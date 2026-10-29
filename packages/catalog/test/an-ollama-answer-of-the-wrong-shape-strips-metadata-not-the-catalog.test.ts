/**
 * WHY: the local and the cloud Ollama provider each parsed `/api/tags` and `/api/show` themselves, and
 * each trusted a different part of the body. A local `/api/show` answering `null` threw out of discovery,
 * so one model's metadata took every local model with it. A cloud `/api/show` whose `capabilities` was a
 * number threw the same way, a `capabilities` string was searched as text and granted thinking and
 * images, and a `context_length` of `0` or `-5` became the model's context window. Either provider's
 * `/api/tags` answering `null`, or `models` that is not a list, threw.
 *
 * THE CLASS: an Ollama reader that throws on, or believes, a body of the wrong shape. Both providers now
 * read through `provider-models/ollama-native.ts`, and this suite drives each one end to end over a table
 * of wrong shapes. The readers are not listed by hand: every runtime provider descriptor is run against a
 * recording fetch, and each one that requests `/api/show` joins the sweep, so a new provider speaking
 * Ollama's API turns the pinned reader list red until it is recorded here.
 *
 * WHAT IT DOES NOT CATCH: a reader that asks `/api/show` only for a listing this sweep's generic body does
 * not produce, and a wrong shape outside the table (a `parameters` string that names `num_ctx` twice).
 * The coding-agent's configured `discovery.type: ollama` reader has its own suite in that package.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { DiscoveryFailure } from "@veyyon/catalog/discovery/failure";
import type { FetchImpl, ModelSpec } from "@veyyon/catalog/types";
import type { ProviderDescriptor } from "../src/provider-models/descriptor-types";
import { PROVIDER_DESCRIPTORS } from "../src/provider-models/descriptors";

const MODEL = "probe-model";

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function urlOf(input: Parameters<FetchImpl>[0]): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

interface Scenario {
	/** What `/v1/models` lists; empty sends the local provider to its native `/api/tags` fallback. */
	listing: unknown;
	tags: unknown;
	show: unknown;
}

function scenarioFetch(scenario: Scenario, seen: string[] = []): FetchImpl {
	return async input => {
		const url = urlOf(input);
		seen.push(url);
		if (url.endsWith("/api/show")) return json(scenario.show);
		if (url.endsWith("/api/tags")) return json(scenario.tags);
		return json(scenario.listing);
	};
}

async function discover(
	entry: ProviderDescriptor,
	fetchImpl: FetchImpl,
): Promise<{ models: readonly ModelSpec[] | null | undefined; failures: DiscoveryFailure[] }> {
	const failures: DiscoveryFailure[] = [];
	const options = entry.createModelManagerOptions({ apiKey: "probe-key", fetch: fetchImpl });
	const models = await options.fetchDynamicModels?.({ onFailure: failure => failures.push(failure) });
	return { models, failures };
}

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Every runtime provider descriptor whose discovery requests `/api/show` when each URL answers one generic listing.
 * A provider that ignores the injected fetch reaches the same recorder through the global one, so the
 * sweep never touches the network.
 */
async function ollamaReaders(): Promise<ProviderDescriptor[]> {
	const generic: Scenario = {
		listing: { data: [{ id: MODEL }] },
		tags: { models: [{ name: MODEL }] },
		show: { capabilities: ["completion"] },
	};
	const readers: ProviderDescriptor[] = [];
	for (const entry of PROVIDER_DESCRIPTORS) {
		const seen: string[] = [];
		const recorder = scenarioFetch(generic, seen);
		vi.spyOn(globalThis, "fetch").mockImplementation(recorder as typeof fetch);
		await discover(entry, recorder).catch(() => undefined);
		vi.restoreAllMocks();
		if (seen.some(url => url.endsWith("/api/show"))) readers.push(entry);
	}
	return readers;
}

let sweep: Promise<ProviderDescriptor[]> | undefined;
/** The sweep runs once per file; every test reads its result. */
function readersOnce(): Promise<ProviderDescriptor[]> {
	sweep ??= ollamaReaders();
	return sweep;
}

/** A wrong `/api/show` body, and whether it is reported as one. */
const WRONG_SHOWS: ReadonlyArray<{ name: string; show: unknown; reported: boolean }> = [
	{ name: "a null body", show: null, reported: true },
	{ name: "an array body", show: [], reported: true },
	{ name: "a string body", show: "ok", reported: true },
	{ name: "numeric capabilities", show: { capabilities: 5 }, reported: true },
	{ name: "string capabilities", show: { capabilities: "vision thinking" }, reported: true },
	{ name: "capability names that are not strings", show: { capabilities: [5, null, {}] }, reported: false },
	{ name: "a zero context length", show: { model_info: { "probe.context_length": 0 } }, reported: false },
	{ name: "a negative context length", show: { model_info: { "probe.context_length": -5 } }, reported: false },
	{ name: "a non-numeric context length", show: { model_info: { "probe.context_length": "abc" } }, reported: false },
	{ name: "model_info that is not a map", show: { model_info: "probe" }, reported: false },
	{ name: "parameters that are not a string", show: { parameters: 5 }, reported: false },
];

/** A wrong `/api/tags` body; every one is reported and yields no models. */
const WRONG_TAGS: ReadonlyArray<{ name: string; tags: unknown }> = [
	{ name: "a null body", tags: null },
	{ name: "an array body", tags: [] },
	{ name: "a numeric body", tags: 5 },
	{ name: "models that is a map", tags: { models: {} } },
	{ name: "models that is a string", tags: { models: MODEL } },
];

describe("Ollama readers", () => {
	test("the sweep finds exactly the catalog providers that read Ollama's native API", async () => {
		const readers = await readersOnce();
		expect(readers.map(entry => entry.providerId)).toEqual(["ollama", "ollama-cloud"]);
	});

	test("a wrong /api/show body strips one model's metadata, keeps the model, and never throws", async () => {
		const readers = await readersOnce();
		for (const reader of readers) {
			for (const wrong of WRONG_SHOWS) {
				const label = `${reader.providerId}: ${wrong.name}`;
				const scenario: Scenario = {
					listing: { data: [{ id: MODEL }] },
					tags: { models: [{ name: MODEL }] },
					show: wrong.show,
				};
				const { models, failures } = await discover(reader, scenarioFetch(scenario));
				expect(
					models?.map(model => model.id),
					label,
				).toEqual([MODEL]);
				const model = models?.[0];
				expect(model?.reasoning, label).toBe(false);
				expect(model?.input, label).toEqual(["text"]);
				expect(Number.isFinite(model?.contextWindow) && (model?.contextWindow ?? 0) > 0, label).toBe(true);
				expect(Number.isFinite(model?.maxTokens) && (model?.maxTokens ?? 0) > 0, label).toBe(true);
				expect(model?.maxTokens ?? 0, label).toBeLessThanOrEqual(model?.contextWindow ?? 0);
				const reports = failures.filter(failure => failure.url.endsWith("/api/show"));
				expect(
					reports.map(failure => [failure.stage, failure.detail.startsWith(`${MODEL}: `)]),
					label,
				).toEqual(wrong.reported ? [["payload", true]] : []);
			}
		}
	});

	test("a wrong /api/tags body is reported and yields no models instead of throwing", async () => {
		const readers = await readersOnce();
		for (const reader of readers) {
			for (const wrong of WRONG_TAGS) {
				const label = `${reader.providerId}: ${wrong.name}`;
				const scenario: Scenario = {
					listing: { data: [] },
					tags: wrong.tags,
					show: { capabilities: ["completion"] },
				};
				const { models, failures } = await discover(reader, scenarioFetch(scenario));
				expect(models ?? [], label).toEqual([]);
				const reports = failures.filter(failure => failure.url.endsWith("/api/tags"));
				expect(
					reports.map(failure => failure.stage),
					label,
				).toEqual(["payload"]);
			}
		}
	});

	test("an /api/tags entry that names no model is skipped and the rest are kept", async () => {
		const readers = await readersOnce();
		for (const reader of readers) {
			const scenario: Scenario = {
				listing: { data: [] },
				tags: {
					models: [null, 5, MODEL, { name: "" }, { model: "a" }, { name: "b" }, { model: "", name: "c" }],
				},
				show: { capabilities: ["completion"] },
			};
			const { models, failures } = await discover(reader, scenarioFetch(scenario));
			expect(
				models?.map(model => model.id),
				reader.providerId,
			).toEqual(["a", "b", "c"]);
			expect(failures, reader.providerId).toEqual([]);
		}
	});

	/**
	 * The healthy body, read the same by every reader and by both local routes (the `/v1` listing and the
	 * native `/api/tags` fallback): `num_ctx` from the parameters is the window the server runs, ahead of
	 * the trained length; the output cap never exceeds that window; capability names are case-insensitive,
	 * and a capability map reads like a capability list.
	 */
	test("a well-formed /api/show is read the same by every reader", async () => {
		const readers = await readersOnce();
		const shows = [
			{ capabilities: ["completion", "Thinking", "vision"], parameters: "temperature 0.6\nnum_ctx 4096\n" },
			{ capabilities: { completion: true, thinking: true, image: true, tools: false }, parameters: "num_ctx 4096" },
		];
		for (const reader of readers) {
			for (const listing of [{ data: [{ id: MODEL }] }, { data: [] }]) {
				for (const capabilitiesAndParameters of shows) {
					const label = `${reader.providerId}: ${JSON.stringify(listing)} ${JSON.stringify(capabilitiesAndParameters)}`;
					const scenario: Scenario = {
						listing,
						tags: { models: [{ name: MODEL }] },
						show: { ...capabilitiesAndParameters, model_info: { "probe.context_length": 262_144 } },
					};
					const { models, failures } = await discover(reader, scenarioFetch(scenario));
					expect(
						models?.map(model => model.id),
						label,
					).toEqual([MODEL]);
					const model = models?.[0];
					expect(model?.reasoning, label).toBe(true);
					expect(model?.input, label).toEqual(["text", "image"]);
					expect(model?.contextWindow, label).toBe(4096);
					expect(model?.maxTokens, label).toBe(4096);
					expect(failures, label).toEqual([]);
				}
			}
		}
	});
});
