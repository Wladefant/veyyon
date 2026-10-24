/**
 * WHY: OpenCode Go signs in with an OpenCode Console account, and the Console token is not an API key.
 * The public gateway (`https://opencode.ai/zen/go`) rejects it; it is accepted only by the inference
 * endpoint the Console names for the organization holding the Go subscription, together with that
 * organization's id in `x-opencode-org-id`. A login that stored the token alone, or a request that sent
 * it to the gateway every bundled Go model names, fails every turn with a 401. The API key is the legacy
 * way in and still goes to the gateway, unchanged.
 *
 * Class closed: the Console device login, driven from `/login opencode-go` through the real
 * `AuthStorage`, picks the organization with a Go subscription and stores its endpoint; every way the
 * token leaves the process goes to that endpoint with the organization header: a turn on every wire API
 * the bundled Go models use (enumerated from the bundle, so a model on a new wire fails here until it
 * has an arm), server-side compaction, and a turn after the token is refreshed. Discovery reads the
 * public listing without the token, the usage ledger serves the login, and a refresh failure the Console
 * states as a dead grant is classified as one. The login rows that store an OpenCode Go credential are
 * pinned by exact equality, so the login stays the default and the key stays the legacy entry.
 *
 * NOT CAUGHT: whether the Console accepts these requests (there is no network here), the shape of the
 * endpoint a real Console names beyond the `.../openai/v1` route this suite models, and whether the
 * terminal dialog shows the URL (any `onAuth` a host supplies is what receives it).
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as envApiKeyModule from "@veyyon/ai/env-api-key";
import { isDefinitiveOAuthFailure } from "@veyyon/ai/error/flags";
import {
	loginOpenCodeGo,
	OPENCODE_CONSOLE_CLIENT_ID,
	OPENCODE_CONSOLE_URL,
	refreshOpenCodeGoToken,
} from "@veyyon/ai/oauth/opencode-console";
import { openAIResponsesServerCompaction } from "@veyyon/ai/providers/openai-compaction";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { getOAuthProviders } from "@veyyon/ai/registry/oauth";
import type { OAuthAuthInfo, OAuthCredentials } from "@veyyon/ai/registry/oauth/types";
import { opencodeGoApiKeyProvider } from "@veyyon/ai/registry/opencode-go-api-key";
import * as aiStream from "@veyyon/ai/stream";
import type { Api, Context, Model } from "@veyyon/ai/types";
import { opencodeGoUsageProvider } from "@veyyon/ai/usage/opencode-go";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModels } from "@veyyon/catalog/models";
import {
	opencodeGoModelManagerOptions,
	resolveOpencodeGoCacheProviderId,
} from "@veyyon/catalog/provider-models/openai-compat";
import { OPENCODE_GO_ORG_HEADER, opencodeGoApiKey } from "@veyyon/catalog/wire/opencode-go";
import { getOpenCodeUserAgent } from "@veyyon/catalog/wire/opencode-headers";

const GATEWAY = "https://opencode.ai/zen/go";
/** The account root the stub Console names, on a host of its own so a hardcoded route cannot pass. */
const ROOT = "https://inference.example.test/go";
const CONTEXT: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };

/** One request the stub server received. */
interface Sent {
	url: string;
	method: string;
	headers: Headers;
	body: string;
}

interface ConsoleScript {
	orgs: { id: string; name: string }[];
	/** The Go endpoint each organization's config names; an organization absent here has no Go subscription. */
	goEndpoints: Record<string, string>;
	/** The organization the consent page scoped the token to. */
	grantedOrgId?: string;
	/** The answer to a refresh; a rotated token by default. */
	refresh?: () => Response;
	/** The answer to the device-token poll; a token by default. */
	poll?: () => Response;
}

/**
 * The Console, the public gateway and an account endpoint in one stub. API requests are answered with a
 * 400, which ends a turn without a stream. It records every request it receives.
 */
function opencodeServer(sent: Sent[], script: ConsoleScript): typeof fetch {
	const handler = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const body = await request.text();
		const url = new URL(request.url);
		sent.push({ url: `${url.origin}${url.pathname}`, method: request.method, headers: request.headers, body });
		switch (url.pathname) {
			case "/console/auth/device/code":
				return Response.json({
					device_code: "device-1",
					user_code: "ABCD-1234",
					verification_uri_complete: "/console/device?user_code=ABCD-1234",
					expires_in: 600,
					interval: 1,
				});
			case "/console/auth/device/token": {
				if (JSON.parse(body).grant_type === "refresh_token") {
					return (
						script.refresh?.() ??
						Response.json({
							access_token: "access-refreshed",
							refresh_token: "refresh-refreshed",
							expires_in: 3600,
						})
					);
				}
				return (
					script.poll?.() ??
					Response.json({
						access_token: "access-issued",
						refresh_token: "refresh-issued",
						expires_in: 3600,
						...(script.grantedOrgId !== undefined && { org_id: script.grantedOrgId }),
					})
				);
			}
			case "/console/api/user":
				return Response.json({ id: "user-1", email: "dev@example.com" });
			case "/console/api/orgs":
				return Response.json(script.orgs);
			case "/console/api/config": {
				const api = script.goEndpoints[request.headers.get("x-org-id") ?? ""];
				return Response.json({ config: { provider: api === undefined ? {} : { "opencode-go": { api } } } });
			}
		}
		if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "glm-5" }] });
		return Response.json({ error: { type: "invalid_request_error", message: "stub" } }, { status: 400 });
	};
	return Object.assign(handler, { preconnect: fetch.preconnect }) as typeof fetch;
}

/** Three organizations, listed out of name order: Beta is the first by name with Go. */
const THREE_ORGS: ConsoleScript = {
	orgs: [
		{ id: "org-z", name: "Zeta" },
		{ id: "org-a", name: "Alpha" },
		{ id: "org-b", name: "Beta" },
	],
	goEndpoints: { "org-z": "https://other.example.test/go/openai/v1", "org-b": `${ROOT}/openai/v1/` },
};

/** The bearer or `x-api-key` a request carried. */
function credentialOf(request: Sent): string | null {
	return request.headers.get("authorization")?.replace(/^Bearer /, "") ?? request.headers.get("x-api-key");
}

/** The distinct API requests made since `mark`: where each went, with what credential and organization. */
function apiRequestsSince(
	sent: readonly Sent[],
	mark: number,
): { url: string; credential: string | null; org: string | null }[] {
	const seen = new Set<string>();
	const distinct: { url: string; credential: string | null; org: string | null }[] = [];
	for (const request of sent.slice(mark)) {
		if (request.url.startsWith(OPENCODE_CONSOLE_URL) || request.url.startsWith("https://models.dev")) continue;
		const entry = {
			url: request.url,
			credential: credentialOf(request),
			org: request.headers.get(OPENCODE_GO_ORG_HEADER),
		};
		const key = JSON.stringify(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		distinct.push(entry);
	}
	return distinct;
}

/** Fails when any header of any request carries the stored envelope instead of the token. */
function expectNoEnvelopeOnTheWire(sent: readonly Sent[]): void {
	for (const request of sent) {
		for (const [name, value] of request.headers.entries()) {
			if (value.includes("apiEndpoint")) throw new Error(`${request.url} sent the credential envelope in ${name}`);
		}
	}
}

/** The first bundled Go model on each wire API, keyed by API. */
function bundledModelPerApi(): Map<Api, Model<Api>> {
	const models = new Map<Api, Model<Api>>();
	for (const model of getBundledModels("opencode-go")) {
		if (!models.has(model.api)) models.set(model.api, model);
	}
	return models;
}

/** The path each wire API appends to the account route, relative to the account root. */
const ACCOUNT_PATH: Readonly<Record<string, string>> = {
	"openai-completions": "/openai/v1/chat/completions",
	"openai-responses": "/openai/v1/responses",
	"anthropic-messages": "/anthropic/v1/messages",
};

/** The path each wire API appends to the public gateway. */
const GATEWAY_PATH: Readonly<Record<string, string>> = {
	"openai-completions": "/v1/chat/completions",
	"openai-responses": "/v1/responses",
	"anthropic-messages": "/v1/messages",
};

async function compact(model: Model<Api>, apiKey: string, fetchImpl: typeof fetch): Promise<void> {
	try {
		await openAIResponsesServerCompaction.compact({ model, messages: CONTEXT.messages, apiKey, fetch: fetchImpl });
	} catch {
		// The compact response is a 400; the request is the subject.
	}
}

function withBaseUrl(model: Model<Api>, baseUrl: string): Model<Api> {
	return buildModel({ ...model, baseUrl, compat: model.compatConfig } as Parameters<typeof buildModel>[0]);
}

describe("an OpenCode Go login reaches its own account endpoint", () => {
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		// An ambient OPENCODE_API_KEY must not stand in for the credential the login stores.
		vi.spyOn(envApiKeyModule, "getEnvApiKey").mockReturnValue(undefined);
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === "opencode-go" ? opencodeGoUsageProvider : undefined),
		});
		await storage.reload();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store.close();
	});

	async function login(script: ConsoleScript): Promise<{ sent: Sent[]; server: typeof fetch; auth: OAuthAuthInfo[] }> {
		const sent: Sent[] = [];
		const server = opencodeServer(sent, script);
		const auth: OAuthAuthInfo[] = [];
		await storage.login("opencode-go", {
			onAuth: info => auth.push(info),
			onProgress: () => {},
			onPrompt: async () => {
				throw new Error("the Console login asks no question");
			},
			fetch: server,
		});
		return { sent, server, auth };
	}

	it("offers the Console login first and the API key as the legacy entry", () => {
		const rows = PROVIDER_REGISTRY.filter(
			row =>
				typeof row.login === "function" && (row.id === "opencode-go" || row.storeCredentialsAs === "opencode-go"),
		);
		expect(rows.map(row => [row.id, row.credential, row.storeCredentialsAs])).toEqual([
			["opencode-go", "oauth", undefined],
			["opencode-go-api-key", "api-key", "opencode-go"],
		]);
		expect(
			getOAuthProviders()
				.filter(entry => entry.id.startsWith("opencode-go"))
				.map(entry => entry.name),
		).toEqual(["OpenCode Go", "OpenCode Go (API key, legacy)"]);
	});

	it("signs in through the device flow and stores the first organization by name with Go", async () => {
		const { sent, auth } = await login(THREE_ORGS);

		expect(auth.map(info => info.url)).toEqual([`${OPENCODE_CONSOLE_URL}/device?user_code=ABCD-1234`]);
		expect(auth[0]?.instructions).toContain("ABCD-1234");
		const deviceCode = sent.find(request => request.url === `${OPENCODE_CONSOLE_URL}/auth/device/code`);
		expect(JSON.parse(deviceCode?.body ?? "{}")).toEqual({
			client_id: OPENCODE_CONSOLE_CLIENT_ID,
			supports_org_scope: true,
		});
		for (const request of sent) expect(request.headers.get("user-agent")).toBe(getOpenCodeUserAgent());
		// Every lookup after the token carries it, and each organization's config is read under its id.
		const lookups = sent.filter(request => request.url.startsWith(`${OPENCODE_CONSOLE_URL}/api/`));
		for (const request of lookups) expect(credentialOf(request)).toBe("access-issued");
		expect(
			lookups
				.filter(request => request.url.endsWith("/api/config"))
				.map(request => request.headers.get("x-org-id"))
				.sort(),
		).toEqual(["org-a", "org-b", "org-z"]);

		const stored = store.listAuthCredentials("opencode-go")[0]?.credential;
		if (stored?.type !== "oauth") throw new Error("the login stored no opencode-go OAuth row");
		expect(stored).toMatchObject({
			access: "access-issued",
			refresh: "refresh-issued",
			accountId: "user-1",
			email: "dev@example.com",
			orgId: "org-b",
			orgName: "Beta",
			apiEndpoint: `${ROOT}/openai/v1`,
		});
		expect(await storage.getApiKey("opencode-go", "s")).toBe(
			opencodeGoApiKey("access-issued", `${ROOT}/openai/v1`, "org-b"),
		);
	});

	it("sends every turn, compaction and refreshed turn to the account endpoint with the organization", async () => {
		const { sent, server } = await login(THREE_ORGS);
		const apiKey = await storage.getApiKey("opencode-go", "s");
		if (apiKey === undefined) throw new Error("the login stored no opencode-go credential");

		const models = bundledModelPerApi();
		const unarmed = [...models.keys()].filter(api => ACCOUNT_PATH[api] === undefined);
		expect(unarmed).toEqual([]);

		for (const [api, model] of models) {
			const mark = sent.length;
			await aiStream.stream(model, CONTEXT, { apiKey, fetch: server }).result();
			expect({ api, requests: apiRequestsSince(sent, mark) }).toEqual({
				api,
				requests: [{ url: `${ROOT}${ACCOUNT_PATH[api]}`, credential: "access-issued", org: "org-b" }],
			});
		}

		const responsesModel = models.get("openai-responses");
		if (!responsesModel) throw new Error("no bundled OpenCode Go model is served over responses");
		let mark = sent.length;
		await compact(responsesModel, apiKey, server);
		expect(apiRequestsSince(sent, mark)).toEqual([
			{ url: `${ROOT}/openai/v1/responses/compact`, credential: "access-issued", org: "org-b" },
		]);

		// The refresh reaches the token endpoint through the global fetch, as the registry row calls it.
		vi.spyOn(globalThis, "fetch").mockImplementation(server);
		mark = sent.length;
		const refreshedKey = await storage.getApiKey("opencode-go", "s", { forceRefresh: true });
		if (refreshedKey === undefined) throw new Error("the refresh left no opencode-go credential");
		expect(sent.slice(mark).map(request => request.url)).toEqual([`${OPENCODE_CONSOLE_URL}/auth/device/token`]);
		const completionsModel = models.get("openai-completions");
		if (!completionsModel) throw new Error("no bundled OpenCode Go model is served over chat completions");
		mark = sent.length;
		await aiStream.stream(completionsModel, CONTEXT, { apiKey: refreshedKey, fetch: server }).result();
		expect(apiRequestsSince(sent, mark)).toEqual([
			{ url: `${ROOT}/openai/v1/chat/completions`, credential: "access-refreshed", org: "org-b" },
		]);

		expectNoEnvelopeOnTheWire(sent);
	});

	it("keeps a custom base URL for a login and still sends the organization", async () => {
		const { sent, server } = await login(THREE_ORGS);
		const apiKey = await storage.getApiKey("opencode-go", "s");
		if (apiKey === undefined) throw new Error("the login stored no opencode-go credential");
		const proxy = "https://proxy.example.test/v1";
		for (const [api, model] of bundledModelPerApi()) {
			const mark = sent.length;
			await aiStream.stream(withBaseUrl(model, proxy), CONTEXT, { apiKey, fetch: server }).result();
			const [request] = apiRequestsSince(sent, mark);
			expect({ api, host: new URL(request?.url ?? "about:blank").host, org: request?.org }).toEqual({
				api,
				host: "proxy.example.test",
				org: "org-b",
			});
		}
	});

	it("sends an API key to the public gateway with no organization", async () => {
		const sent: Sent[] = [];
		const server = opencodeServer(sent, THREE_ORGS);
		for (const [api, model] of bundledModelPerApi()) {
			const mark = sent.length;
			await aiStream.stream(model, CONTEXT, { apiKey: "sk-go-key", fetch: server }).result();
			expect({ api, requests: apiRequestsSince(sent, mark) }).toEqual({
				api,
				requests: [{ url: `${GATEWAY}${GATEWAY_PATH[api]}`, credential: "sk-go-key", org: null }],
			});
		}
	});

	it("lists models without the login token, and with an API key", async () => {
		const envelope = opencodeGoApiKey("access-issued", `${ROOT}/openai/v1`, "org-b");
		for (const [apiKey, expected] of [
			[envelope, null],
			["sk-go-key", "Bearer sk-go-key"],
		] as const) {
			const sent: Sent[] = [];
			await opencodeGoModelManagerOptions({
				apiKey,
				fetch: opencodeServer(sent, THREE_ORGS),
			}).fetchDynamicModels?.();
			const listings = sent.filter(request => request.url === `${GATEWAY}/v1/models`);
			expect(listings.map(request => request.headers.get("authorization"))).toEqual([expected]);
		}
		// The listing a login reads does not depend on the token, so a refreshed token keeps its cache.
		expect(resolveOpencodeGoCacheProviderId({ apiKey: envelope })).toBe(
			resolveOpencodeGoCacheProviderId({
				apiKey: opencodeGoApiKey("access-refreshed", `${ROOT}/openai/v1`, "org-b"),
			}),
		);
		expect(resolveOpencodeGoCacheProviderId({ apiKey: "sk-one" })).not.toBe(
			resolveOpencodeGoCacheProviderId({ apiKey: "sk-two" }),
		);
	});

	it("records and reports usage for the login", async () => {
		await login(THREE_ORGS);
		await storage.getApiKey("opencode-go", "s");
		expect(storage.recordUsageCost("opencode-go", 3, { sessionId: "s" })).toBe(true);
		const reports = (await storage.fetchUsageReports()) ?? [];
		const go = reports.find(report => report.provider === "opencode-go");
		expect(go?.limits.find(limit => limit.window?.id === "rolling-5h")?.amount.used).toBe(3);
	});

	describe("organization choice and refusals", () => {
		async function loginError(script: ConsoleScript): Promise<string> {
			const sent: Sent[] = [];
			try {
				await loginOpenCodeGo({ onAuth: () => {}, fetch: opencodeServer(sent, script) });
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
			throw new Error("the login succeeded");
		}

		it("uses only the organization the consent page granted", async () => {
			const sent: Sent[] = [];
			const credentials = await loginOpenCodeGo({
				onAuth: () => {},
				fetch: opencodeServer(sent, { ...THREE_ORGS, grantedOrgId: "org-z" }),
			});
			expect([credentials.orgId, credentials.orgName, credentials.apiEndpoint]).toEqual([
				"org-z",
				"Zeta",
				"https://other.example.test/go/openai/v1",
			]);
			expect(
				sent.filter(request => request.url.endsWith("/api/config")).map(request => request.headers.get("x-org-id")),
			).toEqual(["org-z"]);
		});

		it("names a granted organization the account does not list", async () => {
			expect(await loginError({ ...THREE_ORGS, grantedOrgId: "org-gone" })).toBe(
				"OpenCode organization not found: org-gone",
			);
		});

		it("names the legacy key login when no organization has Go", async () => {
			const legacy = `"${opencodeGoApiKeyProvider.name}"`;
			const none = await loginError({ ...THREE_ORGS, goEndpoints: {} });
			expect(none).toStartWith("No organization of this OpenCode account has an OpenCode Go subscription.");
			expect(none).toContain(legacy);
			const granted = await loginError({ ...THREE_ORGS, grantedOrgId: "org-a" });
			expect(granted).toStartWith("The OpenCode organization Alpha has no OpenCode Go subscription.");
			expect(granted).toContain(legacy);
		});

		it("names an endpoint it cannot route", async () => {
			const message = await loginError({
				...THREE_ORGS,
				goEndpoints: { "org-b": "http://plain.example.test/openai/v1" },
			});
			expect(message).toContain("http://plain.example.test/openai/v1");
			expect(message).toContain(`"${opencodeGoApiKeyProvider.name}"`);
		});

		it("reports a declined login", async () => {
			const message = await loginError({
				...THREE_ORGS,
				poll: () => Response.json({ error: "access_denied" }, { status: 400 }),
			});
			expect(message).toBe("The OpenCode Console login was declined");
		});
	});

	describe("refresh", () => {
		const stored: OAuthCredentials = {
			access: "access-issued",
			refresh: "refresh-issued",
			expires: 0,
			orgId: "org-b",
			orgName: "Beta",
			apiEndpoint: `${ROOT}/openai/v1`,
		};

		it("rotates the tokens and keeps the organization the Console still grants", async () => {
			const sent: Sent[] = [];
			const refreshed = await refreshOpenCodeGoToken(
				stored,
				opencodeServer(sent, {
					...THREE_ORGS,
					refresh: () =>
						Response.json({
							access_token: "access-2",
							refresh_token: "refresh-2",
							expires_in: 60,
							org_id: "org-b",
						}),
				}),
			);
			expect([refreshed.access, refreshed.refresh, refreshed.orgId]).toEqual(["access-2", "refresh-2", undefined]);
			expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({
				grant_type: "refresh_token",
				refresh_token: "refresh-issued",
				client_id: OPENCODE_CONSOLE_CLIENT_ID,
			});
			expect(sent).toHaveLength(1);
		});

		it("looks the organization up again when the Console scopes the token to another", async () => {
			const refreshed = await refreshOpenCodeGoToken(
				stored,
				opencodeServer([], {
					...THREE_ORGS,
					refresh: () =>
						Response.json({
							access_token: "access-2",
							refresh_token: "refresh-2",
							expires_in: 60,
							org_id: "org-z",
						}),
				}),
			);
			expect([refreshed.orgId, refreshed.orgName, refreshed.apiEndpoint]).toEqual([
				"org-z",
				"Zeta",
				"https://other.example.test/go/openai/v1",
			]);
		});

		it("classifies a dead grant as definitive and a gateway failure as transient", async () => {
			async function refreshError(response: () => Response): Promise<string> {
				try {
					await refreshOpenCodeGoToken(stored, opencodeServer([], { ...THREE_ORGS, refresh: response }));
				} catch (error) {
					return error instanceof Error ? error.message : String(error);
				}
				throw new Error("the refresh succeeded");
			}
			expect(
				isDefinitiveOAuthFailure(
					await refreshError(() => Response.json({ error: "invalid_grant" }, { status: 400 })),
				),
			).toBe(true);
			expect(
				isDefinitiveOAuthFailure(
					await refreshError(
						() => new Response("<html>Bad gateway</html>", { status: 502, statusText: "Bad Gateway" }),
					),
				),
			).toBe(false);
		});
	});
});
