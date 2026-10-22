import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@veyyon/catalog/build";
import { fetchCodexAccountModels, fetchCodexModels } from "@veyyon/catalog/discovery/codex";
import { Effort } from "@veyyon/catalog/effort";
import { writeModelCache } from "@veyyon/catalog/model-cache";
import { resolveProviderModels } from "@veyyon/catalog/model-manager";
import { openaiCodexModelManagerOptions } from "@veyyon/catalog/provider-models/special";
import type { ModelSpec } from "@veyyon/catalog/types";

/** An access token whose payload names `accountId`, as a ChatGPT login's does. */
function codexToken(accountId: string): string {
	const payload = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
	return `aaa.${Buffer.from(JSON.stringify(payload)).toBase64()}.bbb`;
}

describe("Codex model discovery", () => {
	it("marks discovered models for provider-native V2 compaction", async () => {
		let capturedHeaders: Headers | undefined;
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = new Headers(init?.headers);
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high", "xhigh"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
						],
					}),
					{ headers: { etag: "models-v1" } },
				);
			},
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		expect(capturedHeaders?.get("version")).toBe("0.99.0");
		expect(result?.etag).toBe("models-v1");
		expect(result?.models).toHaveLength(1);
		expect(result?.models[0]).toMatchObject({
			id: "gpt-5.5",
			provider: "openai-codex",
			api: "openai-codex-responses",
		});
	});

	it("carries use_responses_lite and prefer_websockets onto the model spec", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-terra",
								display_name: "GPT-5.6-Terra",
								context_window: 372_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
								prefer_websockets: true,
								use_responses_lite: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.99.0",
			fetchFn,
		});

		const terra = result?.models.find(model => model.id === "gpt-5.6-terra");
		expect(terra).toMatchObject({ preferWebsockets: true, useResponsesLite: true });
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.useResponsesLite).toBeUndefined();
	});
	it("uses the discovered account catalog as authoritative", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-authoritative-"));
		const staticOnlyModel: ModelSpec<"openai-codex-responses"> = {
			id: "unsupported-static",
			name: "Unsupported static model",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		const discoveredModel: ModelSpec<"openai-codex-responses"> = {
			...staticOnlyModel,
			id: "account-supported",
			name: "Account-supported model",
		};
		try {
			const result = await resolveProviderModels(
				{
					...openaiCodexModelManagerOptions(),
					staticModels: [staticOnlyModel],
					cacheDbPath: path.join(tempDir, "models.db"),
					fetchDynamicModels: async () => [discoveredModel],
				},
				"online",
			);

			expect(result.models.map(model => model.id)).toEqual(["account-supported"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	// WHY: a model row records, per ChatGPT account, whether the account is listed the model and the
	// programs it is offered, and a request signed by that account selects from its entry with no listing
	// of its own. The endpoint answers for the `chatgpt-account-id` header when one is sent, so an entry
	// keyed by the token's account instead would serve one account's Daybreak program to another. Not
	// caught: a listing whose header and token disagree in production, which no caller is known to send.
	it("keys a listing's entries by the account it was made for: the account header when sent, else the token's", async () => {
		const headerAccounts: Array<string | null> = [];
		const fetchFn: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				headerAccounts.push(new Headers(init?.headers).get("chatgpt-account-id"));
				return new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-sol",
								supported_in_api: true,
								available_access_programs: { cyber: ["standard", "daybreak_blue"] },
							},
							{ slug: "gpt-6-astra", supported_in_api: true },
						],
					}),
				);
			},
			{ preconnect() {} },
		);
		const discover = (accountId?: string) =>
			fetchCodexModels({
				accessToken: codexToken("acc_token"),
				baseUrl: "https://codex.example/backend-api",
				fetchFn,
				...(accountId !== undefined ? { accountId } : {}),
			});

		const byHeader = await discover("acc_header");
		const byToken = await discover();

		expect(headerAccounts).toEqual(["acc_header", null]);
		expect(byHeader?.models.map(model => [model.id, model.accountAccess])).toEqual([
			["gpt-5.6-sol", { acc_header: { listed: true, cyber: ["standard", "daybreak_blue"] } }],
			["gpt-6-astra", { acc_header: { listed: true } }],
		]);
		expect(byToken?.models.map(model => [model.id, model.accountAccess])).toEqual([
			["gpt-5.6-sol", { acc_token: { listed: true, cyber: ["standard", "daybreak_blue"] } }],
			["gpt-6-astra", { acc_token: { listed: true } }],
		]);
	});

	// WHY: each ChatGPT account is listed the models its tier may use: a Daybreak Blue account is listed
	// models a standard or Red account is not, and each tier is offered its own programs for a shared
	// model. Listing one account hid every model only another tier is listed, and recorded no fact about
	// the other accounts. The class closed: discovery lists every account, the catalog is the union, and
	// every model states for every account whose listing answered whether it is listed and what it is
	// offered. Not caught: an account whose listing fails, which has no entry on any model and is left
	// to the request-time listing.
	describe("listing every signed-in account", () => {
		const LISTINGS: Record<string, unknown[]> = {
			acc_standard: [
				{ slug: "gpt-5.6-sol", priority: 1, available_access_programs: { cyber: ["standard"] } },
				{ slug: "gpt-6-astra", priority: 2 },
			],
			acc_blue: [
				{
					slug: "gpt-5.6-sol",
					priority: 1,
					available_access_programs: { cyber: ["standard", "daybreak_blue"] },
				},
				{ slug: "gpt-6-astra", priority: 2 },
				{
					slug: "gpt-5.6-blue-latest",
					display_name: "Blue Latest",
					priority: 3,
					available_access_programs: { cyber: ["daybreak_blue"] },
				},
			],
			acc_red: [
				{
					slug: "gpt-5.6-sol",
					priority: 1,
					available_access_programs: { cyber: ["standard", "daybreak_red"] },
				},
				{ slug: "gpt-6-astra", priority: 2 },
			],
		};

		function tiersFetch(requested: Array<string | null>): typeof fetch {
			return Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					const accountId = new Headers(init?.headers).get("chatgpt-account-id");
					requested.push(accountId);
					const models = accountId === null ? undefined : LISTINGS[accountId];
					if (models === undefined) return new Response("unavailable", { status: 503 });
					return new Response(
						JSON.stringify({ models: models.map(model => ({ supported_in_api: true, ...(model as object) })) }),
					);
				},
				{ preconnect() {} },
			);
		}

		const account = (accountId: string) => ({ accessToken: codexToken(accountId), accountId });

		it("merges every account's listing and records each account's entry on every model", async () => {
			const requested: Array<string | null> = [];
			const models = await fetchCodexAccountModels({
				accounts: [account("acc_standard"), account("acc_blue"), account("acc_red")],
				baseUrl: "https://codex.example/backend-api",
				fetchFn: tiersFetch(requested),
			});

			expect(requested.toSorted()).toEqual(["acc_blue", "acc_red", "acc_standard"]);
			expect(models?.map(model => [model.id, model.accountAccess])).toEqual([
				[
					"gpt-5.6-sol",
					{
						acc_standard: { listed: true, cyber: ["standard"] },
						acc_blue: { listed: true, cyber: ["standard", "daybreak_blue"] },
						acc_red: { listed: true, cyber: ["standard", "daybreak_red"] },
					},
				],
				["gpt-6-astra", { acc_standard: { listed: true }, acc_blue: { listed: true }, acc_red: { listed: true } }],
				[
					"gpt-5.6-blue-latest",
					{
						acc_standard: { listed: false },
						acc_blue: { listed: true, cyber: ["daybreak_blue"] },
						acc_red: { listed: false },
					},
				],
			]);
			expect(models?.find(model => model.id === "gpt-5.6-blue-latest")?.name).toBe("Blue Latest");
		});

		it("lists an account given twice once", async () => {
			const requested: Array<string | null> = [];
			const models = await fetchCodexAccountModels({
				accounts: [account("acc_blue"), account("acc_standard"), account("acc_blue")],
				baseUrl: "https://codex.example/backend-api",
				fetchFn: tiersFetch(requested),
			});

			expect(requested.toSorted()).toEqual(["acc_blue", "acc_standard"]);
			expect(Object.keys(models?.[0]?.accountAccess ?? {}).toSorted()).toEqual(["acc_blue", "acc_standard"]);
		});

		it("gives an account whose listing fails no entry, and answers null when no listing answers", async () => {
			const merged = await fetchCodexAccountModels({
				accounts: [account("acc_down"), account("acc_red")],
				baseUrl: "https://codex.example/backend-api",
				fetchFn: tiersFetch([]),
			});
			const none = await fetchCodexAccountModels({
				accounts: [account("acc_down")],
				baseUrl: "https://codex.example/backend-api",
				fetchFn: tiersFetch([]),
			});

			expect(merged?.map(model => [model.id, model.accountAccess])).toEqual([
				["gpt-5.6-sol", { acc_red: { listed: true, cyber: ["standard", "daybreak_red"] } }],
				["gpt-6-astra", { acc_red: { listed: true } }],
			]);
			expect(none).toBeNull();
		});
	});

	// WHY: GPT-6 Astra and GPT-Reserve reached the picker with no effort control
	// because discovery read `supported_reasoning_levels` only as a boolean and
	// left the ladder to a models.dev overlay that lags new Codex SKUs. The class
	// closed: every Codex row's ladder and apply_patch tool type come from what
	// the endpoint declares for that row, so a new SKU is controllable the moment
	// it is listed. Not caught: a level Veyyon has no Effort name for (`ultra`)
	// is dropped rather than offered, by design, until the tier is learned.
	it("carries the declared effort ladder and apply_patch tool type onto the model spec", async () => {
		const level = (effort: string) => ({ effort, description: `${effort} reasoning` });
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-6-astra",
								display_name: "GPT-6-Astra",
								context_window: 272_000,
								default_reasoning_level: "medium",
								// Declared out of order with a tier Veyyon does not know.
								supported_reasoning_levels: [
									level("ultra"),
									level("max"),
									level("xhigh"),
									level("high"),
									level("medium"),
									level("low"),
								],
								apply_patch_tool_type: "freeform",
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: [level("low"), level("medium"), level("high"), level("xhigh")],
								apply_patch_tool_type: "freeform",
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-future",
								display_name: "GPT-Future",
								context_window: 272_000,
								default_reasoning_level: "ultra",
								// Only unknown tiers: the row reasons, but declares no ladder Veyyon can offer.
								supported_reasoning_levels: [level("ultra")],
								apply_patch_tool_type: "hologram",
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.153.2",
			fetchFn,
		});

		const toMax = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
		const toXHigh = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
		const astra = result?.models.find(model => model.id === "gpt-6-astra");
		expect(astra?.reasoningOptions).toEqual({ efforts: toMax });
		expect(astra?.applyPatchToolType).toBe("freeform");
		// The declared ladder is what the resolved model offers the picker.
		expect(astra ? buildModel(astra).thinking?.efforts : undefined).toEqual(toMax);

		const gpt55 = result?.models.find(model => model.id === "gpt-5.5");
		expect(gpt55?.reasoningOptions).toEqual({ efforts: toXHigh });
		expect(gpt55 ? buildModel(gpt55).thinking?.efforts : undefined).toEqual(toXHigh);

		const future = result?.models.find(model => model.id === "gpt-future");
		expect(future?.reasoning).toBe(true);
		expect(future?.reasoningOptions).toBeUndefined();
		expect(future?.applyPatchToolType).toBeUndefined();
	});

	it("floors GPT-5.6 SKUs to 1M when upstream actively reports 272000 (#6259)", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.6-sol",
								display_name: "GPT-5.6-Sol",
								context_window: 272_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: ["low", "medium", "high"],
								input_modalities: ["text", "image"],
								supported_in_api: true,
							},
							{
								slug: "gpt-5.5",
								display_name: "GPT-5.5",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: ["low", "high"],
								input_modalities: ["text"],
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);
		const result = await fetchCodexModels({
			accessToken: "test-token",
			baseUrl: "https://codex.example/backend-api",
			clientVersion: "0.144.1",
			fetchFn,
		});

		const sol = result?.models.find(model => model.id === "gpt-5.6-sol");
		expect(sol?.contextWindow).toBe(1_000_000);
		// Non-5.6 SKUs still honor the reported value verbatim.
		const legacy = result?.models.find(model => model.id === "gpt-5.5");
		expect(legacy?.contextWindow).toBe(272_000);
	});

	it("ignores pre-V2 Codex discovery cache rows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v7-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const cachedModel: ModelSpec<"openai-codex-responses"> = {
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		// The refreshed copy differs in one field, which is what proves the refetched
		// model reached the caller rather than the stale cached one.
		const refreshedModel: ModelSpec<"openai-codex-responses"> = {
			...cachedModel,
			maxTokens: 96_000,
		};
		try {
			writeModelCache(
				"openai-codex",
				Date.now(),
				[buildModel(cachedModel)],
				true,
				"merge-v3:authoritative:merge-v3:empty",
				dbPath,
			);
			const db = new Database(dbPath);
			try {
				db.run("UPDATE model_cache SET version = 7 WHERE provider_id = ?", ["openai-codex"]);
			} finally {
				db.close();
			}

			let fetched = false;
			const result = await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [refreshedModel];
				},
			});

			expect(fetched).toBe(true);
			expect(result.models.find(model => model.id === "gpt-5.5")?.maxTokens).toBe(refreshedModel.maxTokens);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not silently promote legacy v2 Codex cache rows to the current schema", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-codex-v2-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			// Seed a v2 row directly, mirroring the shape written by very old
			// installs before schema versioning stabilized. The migration must NOT
			// resurrect it as the current version — that would keep the pre-V2
			// compaction metadata alive across cache-schema bumps.
			const seed = new Database(dbPath, { create: true });
			try {
				seed.run(`
					CREATE TABLE model_cache (
						provider_id TEXT PRIMARY KEY,
						version INTEGER NOT NULL,
						updated_at INTEGER NOT NULL,
						authoritative INTEGER NOT NULL DEFAULT 0,
						static_fingerprint TEXT NOT NULL DEFAULT '',
						models TEXT NOT NULL
					)
				`);
				seed.run(
					"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, 2, ?, 1, '', '[]')",
					["openai-codex", Date.now()],
				);
			} finally {
				seed.close();
			}

			let fetched = false;
			await resolveProviderModels<"openai-codex-responses">({
				providerId: "openai-codex",
				staticModels: [],
				dynamicModelsAuthoritative: true,
				cacheDbPath: dbPath,
				fetchDynamicModels: async () => {
					fetched = true;
					return [];
				},
			});
			expect(fetched).toBe(true);

			const inspect = new Database(dbPath, { readonly: true });
			try {
				const row = inspect
					.query<{ version: number }, [string]>("SELECT version FROM model_cache WHERE provider_id = ?")
					.get("openai-codex");
				expect(row?.version).not.toBe(2);
			} finally {
				inspect.close();
			}
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("keeps account-listed API-unsupported models while pruning hidden models", async () => {
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-5.3-codex-spark",
								display_name: "GPT-5.3 Codex Spark",
								visibility: "list",
								supported_in_api: false,
								context_window: 128_000,
								default_reasoning_level: "high",
								input_modalities: ["text"],
							},
							{
								slug: "hidden-model",
								display_name: "Hidden model",
								visibility: "hidden",
								supported_in_api: true,
							},
							{
								slug: "hide-model",
								display_name: "Hide model",
								visibility: "hide",
								supported_in_api: true,
							},
						],
					}),
				),
			{ preconnect() {} },
		);

		const result = await fetchCodexModels({
			accessToken: "test-token",
			fetchFn,
		});

		expect(result?.models.map(model => model.id)).toEqual(["gpt-5.3-codex-spark"]);
		expect(result?.models[0]).toMatchObject({
			contextWindow: 128_000,
			maxTokens: 128_000,
		});
	});
	it("normalizes Codex Daybreak aliases to the GPT-5.6 window and effort ladder", async () => {
		const level = (effort: string) => ({ effort, description: `${effort} reasoning` });
		const fetchFn: typeof fetch = Object.assign(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								slug: "gpt-daybreak-blue-latest",
								display_name: "GPT-Daybreak Blue Latest",
								context_window: 272_000,
								default_reasoning_level: "medium",
								supported_reasoning_levels: [level("low"), level("medium"), level("high"), level("xhigh")],
								input_modalities: ["text", "image"],
								visibility: "show",
							},
							{
								slug: "gpt-daybreak-red-latest",
								display_name: "GPT-Daybreak Red Latest",
								context_window: 272_000,
								default_reasoning_level: "high",
								supported_reasoning_levels: [level("low"), level("medium"), level("high"), level("xhigh")],
								input_modalities: ["text", "image"],
								visibility: "show",
							},
						],
					}),
				),
			{ preconnect() {} },
		);

		const result = await fetchCodexModels({
			accessToken: "test-token",
			fetchFn,
		});

		expect(result?.models).toHaveLength(2);
		expect(result?.models[0]?.contextWindow).toBe(372_000);
		expect(result?.models[1]?.contextWindow).toBe(372_000);
	});
});
