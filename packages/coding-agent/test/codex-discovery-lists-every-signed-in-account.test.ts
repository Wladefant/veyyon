/**
 * WHY: ChatGPT accounts of different tiers are listed different Codex models: a Daybreak Blue account
 * is listed models a standard account is not. Discovery listed one account, so a model only another
 * signed-in tier is listed never reached the catalog, and the cached list served every account set.
 *
 * Class closed: the registry lists every signed-in Codex account, caches the merged list under the
 * account set, and selection sends a model from an account its listing includes. A launch reads only
 * the row of the account set signed in now.
 *
 * Not caught: an account whose token cannot be refreshed, which is left out of the listing.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import { buildModel } from "@veyyon/catalog/build";
import { readModelCache, writeModelCache } from "@veyyon/catalog/model-cache";
import { openaiCodexCacheProviderId } from "@veyyon/catalog/provider-models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

const HOUR_MS = 60 * 60_000;
const ACCOUNT_IDS = ["account-standard", "account-blue"];
/** What `/codex/models` lists each account. */
const LISTINGS: Record<string, unknown[]> = {
	"account-standard": [
		{ slug: "gpt-shared", supported_in_api: true, available_access_programs: { cyber: ["standard"] } },
	],
	"account-blue": [
		{
			slug: "gpt-shared",
			supported_in_api: true,
			available_access_programs: { cyber: ["standard", "daybreak_blue"] },
		},
		{ slug: "gpt-blue-only", supported_in_api: true, available_access_programs: { cyber: ["daybreak_blue"] } },
	],
};

function cachedModel(id: string) {
	return buildModel({
		id,
		name: id,
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	});
}

describe("Codex discovery lists every signed-in account", () => {
	let dir: string;
	let modelsPath: string;
	let auth: AuthStorage;

	beforeEach(async () => {
		resetSettingsForTest();
		dir = path.join(os.tmpdir(), `codex-every-account-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		modelsPath = path.join(dir, "models.json");
		fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
		auth = await AuthStorage.create(":memory:", { loadBalancing: false });
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await auth.set(
			"openai-codex",
			ACCOUNT_IDS.map(accountId => ({
				type: "oauth" as const,
				access: `token-${accountId}`,
				refresh: `refresh-${accountId}`,
				expires: Date.now() + HOUR_MS,
				accountId,
			})),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		auth.close();
		removeSyncWithRetries(dir);
		resetSettingsForTest();
	});

	test("a launch reads the cached list of the signed-in account set and no other row", () => {
		const cacheDbPath = path.join(dir, "models.db");
		writeModelCache(
			openaiCodexCacheProviderId(ACCOUNT_IDS),
			Date.now(),
			[cachedModel("gpt-set-row")],
			true,
			"",
			cacheDbPath,
		);
		writeModelCache("openai-codex", Date.now(), [cachedModel("gpt-bare-row")], true, "", cacheDbPath);

		const registry = new ModelRegistry(auth, modelsPath);

		expect(registry.find("openai-codex", "gpt-set-row")).toBeDefined();
		expect(registry.find("openai-codex", "gpt-bare-row")).toBeUndefined();
	});

	test("discovery lists each account, and a model one tier is listed is sent from that tier's account", async () => {
		const listed: Array<string | null> = [];
		vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (!url.pathname.endsWith("/codex/models")) return new Response("not found", { status: 404 });
			const accountId = new Headers(init?.headers).get("chatgpt-account-id");
			listed.push(accountId);
			const models = accountId === null ? undefined : LISTINGS[accountId];
			return models ? new Response(JSON.stringify({ models })) : new Response("unavailable", { status: 503 });
		}) as typeof fetch);

		const registry = new ModelRegistry(auth, modelsPath);
		await registry.refresh("online");

		expect(listed.toSorted()).toEqual(["account-blue", "account-standard"]);
		expect(registry.find("openai-codex", "gpt-blue-only")?.accountAccess).toEqual({
			"account-standard": { listed: false },
			"account-blue": { listed: true, cyber: ["daybreak_blue"] },
		});
		const cached = readModelCache(
			openaiCodexCacheProviderId(ACCOUNT_IDS),
			HOUR_MS,
			Date.now,
			path.join(dir, "models.db"),
		);
		// The bundled catalog's Codex rows are merged into the same row.
		expect(cached?.models.map(model => model.id)).toEqual(expect.arrayContaining(["gpt-blue-only", "gpt-shared"]));
		// Load balancing is off, so the first stored account serves every model it is listed.
		expect(await auth.getApiKey("openai-codex", "session-blue", { modelId: "gpt-blue-only" })).toBe(
			"token-account-blue",
		);
		expect(await auth.getApiKey("openai-codex", "session-shared", { modelId: "gpt-shared" })).toBe(
			"token-account-standard",
		);
	});
});
