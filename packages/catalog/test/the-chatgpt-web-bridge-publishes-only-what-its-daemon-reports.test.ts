/**
 * WHY THIS SUITE EXISTS.
 *
 * The `chatgpt-web` provider is a catalog whose every row comes from a program
 * running on this machine, so the defect it is exposed to is a local bridge that
 * is DESCRIBED rather than read: rows declared in Veyyon for slugs the account
 * cannot use, an effort ladder assembled from the model id instead of the one
 * the daemon publishes, a tool capability advertised because the code that
 * could deliver it exists somewhere, and native Codex rows republished under a
 * second provider so `openai-codex` quietly moves onto a loopback port. Every
 * one of those passes a smoke test and fails at request time, on someone else's
 * account.
 *
 * THE CLASS THIS CLOSES: any capability the bridge provider states that its
 * daemon did not. The rows, the ladders, the windows, the tool flag and the
 * transport preference are each asserted against the daemon's own answer, and
 * the model set is ENUMERATED from that answer rather than listed here, so a
 * seventh routed slug appearing upstream cannot go unpublished and a native row
 * cannot leak in.
 *
 * THE FIXTURE IS THE DAEMON'S OWN OUTPUT, not a hand-written sketch of it.
 * `fixtures/codex-chatgpt-web-models.json` was produced by running
 * `augmentNativeModelCatalog` from `codex-chatgpt-web@4.0.5` over a native
 * `gpt-5.6-sol` template, which is exactly what `GET /v1/models` returns. That
 * is what makes the two most load-bearing assertions here meaningful: the
 * routed rows are CLONES of the native template, so they inherit
 * `prefer_websockets: true` and `use_responses_lite: true` from a model served
 * by a completely different transport, and the Pro row's published effort is
 * the wire name `ultra`, which is not a Veyyon effort at all.
 *
 * AND THE GUARD SURVIVES A REDIRECT. A base-URL check answers a question about
 * the URL the reader dials, and a followed 302 replaces it with one nothing
 * checked; both requests therefore refuse redirects, which is asserted against
 * two real loopback servers rather than a spy, because the runtime's fetch is
 * what enforces it.
 *
 * WHAT IT DOES NOT CATCH. Nothing here proves a browser turn works: that needs
 * an authenticated ChatGPT profile on this machine (the daemon's `setup`
 * command), which is a separate, missing prerequisite. This suite covers the
 * catalog protocol boundary and the credential-egress refusal, and the request
 * boundary is covered on the transport side in
 * `packages/ai/test/a-codex-base-url-that-names-the-responses-route-is-final.test.ts`.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { DiscoveryFailure } from "@veyyon/catalog/discovery/failure";
import {
	CHATGPT_WEB_MODEL_ID_PREFIX,
	CHATGPT_WEB_PROVIDER_ID,
	fetchChatGptWebModels,
	isChatGptWebLoopbackUrl,
	normalizeChatGptWebBaseUrl,
} from "@veyyon/catalog/discovery/chatgpt-web";
import { Effort } from "@veyyon/catalog/effort";
import { CHATGPT_WEB_LOCAL_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { chatGptWebModelManagerOptions } from "@veyyon/catalog/provider-models/chatgpt-web";
import type { FetchImpl } from "@veyyon/catalog/types";

const BASE = CHATGPT_WEB_LOCAL_ENDPOINT;
const MODELS_URL = `${BASE}/models`;
const HEALTH_URL = "http://127.0.0.1:17841/healthz";
const TOKEN = "codex-oauth-token";

interface DaemonPayload {
	models: { slug: string; [key: string]: unknown }[];
}

const DAEMON_PAYLOAD: DaemonPayload = JSON.parse(
	fs.readFileSync(path.join(import.meta.dirname, "fixtures", "codex-chatgpt-web-models.json"), "utf8"),
) as DaemonPayload;

/** Slugs the fixture actually carries, read at run time so a new one cannot be missed. */
const ROUTED_SLUGS = DAEMON_PAYLOAD.models
	.map(model => model.slug)
	.filter(slug => slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX));
const NATIVE_SLUGS = DAEMON_PAYLOAD.models
	.map(model => model.slug)
	.filter(slug => !slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX));

interface DaemonOptions {
	/** `/healthz` behaviour: a mode string, `"unreachable"`, or `"not-ok"`. */
	health?: "browser-only" | "full" | "unreachable" | "not-ok";
	/** `/models` payload override. */
	payload?: unknown;
	/** `/models` status override. */
	status?: number;
	/** `/models` body override that is not JSON. */
	rawBody?: string;
	/** Throw on `/models` instead of answering. */
	refuse?: boolean;
}

interface Daemon {
	fetchFn: FetchImpl;
	requestedUrls: string[];
	authorizations: (string | null)[];
}

/**
 * A stand-in for the daemon's HTTP boundary and nothing else: the reader under
 * test is the real one, and the fixture is the daemon's real answer. The
 * process itself cannot run here because it needs a signed-in Chrome profile.
 */
function daemon(options: DaemonOptions = {}): Daemon {
	const requestedUrls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requestedUrls.push(url);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		authorizations.push(headers.get("authorization"));
		if (url === HEALTH_URL) {
			const health = options.health ?? "browser-only";
			if (health === "unreachable") throw new Error("connect ECONNREFUSED 127.0.0.1:17841");
			if (health === "not-ok") return new Response("nope", { status: 503 });
			return Response.json({
				status: "ok",
				service: "codex-chatgpt-web",
				version: "4.0.5",
				mode: health,
				accepting_turns: true,
			});
		}
		if (options.refuse) throw new Error("connect ECONNREFUSED 127.0.0.1:17841");
		if (options.rawBody !== undefined) {
			return new Response(options.rawBody, { status: 200, headers: { "content-type": "application/json" } });
		}
		if (options.status !== undefined && options.status !== 200) {
			return new Response("denied", { status: options.status, statusText: "Unauthorized" });
		}
		return Response.json(options.payload ?? DAEMON_PAYLOAD);
	});
	return { fetchFn: fetchFn as FetchImpl, requestedUrls, authorizations };
}

function collect(): { failures: DiscoveryFailure[]; onFailure: (failure: DiscoveryFailure) => void } {
	const failures: DiscoveryFailure[] = [];
	return { failures, onFailure: failure => failures.push(failure) };
}

describe("the bridge catalog is the daemon's answer, filtered to its own rows", () => {
	it("publishes exactly the routed slugs the daemon listed and no native Codex row", async () => {
		// The set is derived from the payload, not spelled here: a seventh routed
		// slug shipping upstream must appear, and a native row must never appear.
		expect(ROUTED_SLUGS.length).toBeGreaterThan(1);
		expect(NATIVE_SLUGS).toEqual(["gpt-5.6-sol"]);

		const { fetchFn } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		expect(result).not.toBeNull();
		expect(result?.models.map(model => model.id).sort()).toEqual([...ROUTED_SLUGS].sort());
		for (const model of result?.models ?? []) {
			expect(model.provider).toBe(CHATGPT_WEB_PROVIDER_ID);
			expect(model.api).toBe("openai-codex-responses");
			expect(model.id.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX)).toBe(true);
		}
	});

	it("points every row at the daemon's own responses route", async () => {
		const { fetchFn } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		// The literal, because the whole transport hangs off it: the bridge serves
		// `POST /v1/responses`, not OpenAI's `/backend-api/codex/responses`.
		for (const model of result?.models ?? []) {
			expect(model.baseUrl).toBe("http://127.0.0.1:17841/v1/responses");
		}
	});

	it("carries each row's effort ladder verbatim, one published level per row", async () => {
		const { fetchFn } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });
		const byId = new Map((result?.models ?? []).map(model => [model.id, model]));

		// Enumerated from the payload: every row's ladder must equal the levels the
		// daemon published for THAT row, and nothing else. An identity-derived
		// ladder would hand `chatgpt-web/light` a menu of five efforts the daemon
		// discards, since it overwrites the requested effort with the slug's own.
		for (const entry of DAEMON_PAYLOAD.models) {
			if (!entry.slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX)) continue;
			const published = entry.supported_reasoning_levels as { effort: string }[];
			expect(published).toHaveLength(1);
			const model = byId.get(entry.slug);
			expect(model).toBeDefined();
			expect(model?.reasoning).toBe(true);
			expect(model?.thinking?.mode).toBe("effort");
			expect(model?.thinking?.efforts).toHaveLength(1);
			expect(model?.thinking?.defaultLevel).toBe(model?.thinking?.efforts[0]);
		}

		expect(byId.get("chatgpt-web/light")?.thinking?.efforts).toEqual([Effort.Low]);
		expect(byId.get("chatgpt-web/medium")?.thinking?.efforts).toEqual([Effort.Medium]);
		expect(byId.get("chatgpt-web/high")?.thinking?.efforts).toEqual([Effort.High]);
		expect(byId.get("chatgpt-web/extra-high")?.thinking?.efforts).toEqual([Effort.XHigh]);
		// The one rename in the whole mapping. The daemon publishes the Pro row's
		// wire effort as `ultra`, which is not a Veyyon effort; its own adapter
		// binds that route to ChatGPT Pro under the name `max`. Dropping the
		// translation would leave the Pro row with no ladder and `reasoning: false`.
		expect(DAEMON_PAYLOAD.models.find(m => m.slug === "chatgpt-web/pro")?.default_reasoning_level).toBe("ultra");
		expect(byId.get("chatgpt-web/pro")?.thinking?.efforts).toEqual([Effort.Max]);
	});

	it("copies the daemon's context window and refuses to invent an output cap", async () => {
		const { fetchFn } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });
		const byId = new Map((result?.models ?? []).map(model => [model.id, model]));

		for (const entry of DAEMON_PAYLOAD.models) {
			if (!entry.slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX)) continue;
			expect(byId.get(entry.slug)?.contextWindow).toBe(entry.context_window as number);
			// The daemon publishes no output cap and the Codex transport strips
			// `max_output_tokens` anyway, so a number here would be fabricated.
			expect(byId.get(entry.slug)?.maxTokens).toBeNull();
		}
		// The Pro row's window genuinely differs from the others', so a single
		// hardcoded constant could not have satisfied the sweep above.
		expect(byId.get("chatgpt-web/pro")?.contextWindow).not.toBe(byId.get("chatgpt-web/high")?.contextWindow);
	});

	it("records zero pricing as unknown rather than free", async () => {
		const { fetchFn } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		for (const model of result?.models ?? []) {
			expect(model.pricing).toBe("unknown");
			expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("pins websockets off even though every routed row inherits prefer_websockets", async () => {
		// The inheritance is the defect's mechanism, so assert the fixture really
		// carries it: the routed rows are clones of the native template, and the
		// bridge answers `GET /v1/responses` with HTTP 426. An absent preference
		// means "try the upgrade" in the Codex transport, so `false` must be set.
		for (const entry of DAEMON_PAYLOAD.models) {
			if (!entry.slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX)) continue;
			expect(entry.prefer_websockets).toBe(true);
		}

		const { fetchFn } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		for (const model of result?.models ?? []) {
			expect(model.preferWebsockets).toBe(false);
		}
	});

	it("never enables the Responses Lite transport the routed rows inherit", async () => {
		for (const entry of DAEMON_PAYLOAD.models) {
			if (!entry.slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX)) continue;
			expect(entry.use_responses_lite).toBe(true);
		}

		const { fetchFn } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		// Lite moves instructions and tools into input items, which is exactly the
		// message ordering the bridge parses to find its trusted environment and
		// current-turn user revision. Inheriting the flag from a native template
		// would change that layout with no evidence the bridge accepts it.
		for (const model of result?.models ?? []) {
			expect(model.useResponsesLite).toBeUndefined();
		}
	});
});

describe("tool support is proven from /healthz, never assumed", () => {
	it("marks rows tool-less while the daemon reports browser-only mode", async () => {
		const { fetchFn } = daemon({ health: "browser-only" });
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		expect(result?.mode).toBe("browser-only");
		for (const model of result?.models ?? []) {
			expect(model.supportsTools).toBe(false);
		}
	});

	it("permits tools only when the daemon reports full mode", async () => {
		const { fetchFn } = daemon({ health: "full" });
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		expect(result?.mode).toBe("full");
		// `false` is the only unsupported signal in a model spec; absent means
		// callers may use native tools, which in Full mode reach the client as
		// ordinary `function_call` items and run under Veyyon's own approvals.
		for (const model of result?.models ?? []) {
			expect(model.supportsTools).toBeUndefined();
		}
	});

	it("treats an unanswerable health probe as tool-less and still returns the catalog", async () => {
		for (const health of ["unreachable", "not-ok"] as const) {
			const { fetchFn } = daemon({ health });
			const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

			// Full mode has to be proven. An unknown mode must not silently
			// advertise a capability, and must not lose the catalog either.
			expect(result?.mode).toBeUndefined();
			expect(result?.models.length).toBe(ROUTED_SLUGS.length);
			for (const model of result?.models ?? []) {
				expect(model.supportsTools).toBe(false);
			}
		}
	});

	it("ignores a health response from something that is not this daemon", async () => {
		const { fetchFn } = daemon();
		const impostor = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === HEALTH_URL) return Response.json({ status: "ok", service: "some-other-proxy", mode: "full" });
			return fetchFn(input, init);
		});
		const result = await fetchChatGptWebModels({
			accessToken: TOKEN,
			baseUrl: BASE,
			fetchFn: impostor as FetchImpl,
		});

		// Another program on 17841 claiming Full mode must not grant tool support.
		expect(result?.mode).toBeUndefined();
		for (const model of result?.models ?? []) {
			expect(model.supportsTools).toBe(false);
		}
	});
});

describe("the ChatGPT credential never leaves this machine", () => {
	it("refuses a non-loopback base URL before making any request", async () => {
		// Discovery forwards the caller's ChatGPT bearer, because the daemon proxies
		// `/models` upstream with the incoming Authorization header. So the refusal
		// has to happen BEFORE the request, not by rejecting the response.
		for (const baseUrl of [
			"http://192.168.1.20:17841/v1",
			"http://10.0.0.7:17841/v1",
			"http://172.16.4.4:17841/v1",
			"http://box.local:17841/v1",
			"https://bridge.example.com/v1",
			"http://0.0.0.0:17841/v1",
			"http://127.0.0.1.evil.com/v1",
		]) {
			const { fetchFn, requestedUrls } = daemon();
			const { failures, onFailure } = collect();
			const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl, fetchFn, onFailure });

			expect(result).toBeNull();
			expect(requestedUrls).toEqual([]);
			expect(failures.map(failure => failure.stage)).toEqual(["base-url"]);
			expect(failures[0]?.detail).toContain("loopback");
		}
	});

	it("accepts the loopback block and nothing that merely looks like it", () => {
		expect(isChatGptWebLoopbackUrl(CHATGPT_WEB_LOCAL_ENDPOINT)).toBe(true);
		expect(isChatGptWebLoopbackUrl("http://localhost:17841/v1")).toBe(true);
		expect(isChatGptWebLoopbackUrl("http://127.9.9.9:17841/v1")).toBe(true);
		expect(isChatGptWebLoopbackUrl("http://[::1]:17841/v1")).toBe(true);
		// Digit-shaped but not an address, and the near-misses a prefix test would
		// wave through.
		expect(isChatGptWebLoopbackUrl("http://127.999.0.1:17841/v1")).toBe(false);
		expect(isChatGptWebLoopbackUrl("http://127.0.0.1.evil.com/v1")).toBe(false);
		expect(isChatGptWebLoopbackUrl("http://1270.0.0.1/v1")).toBe(false);
		expect(isChatGptWebLoopbackUrl("http://0.0.0.0:17841/v1")).toBe(false);
		expect(isChatGptWebLoopbackUrl("file:///etc/passwd")).toBe(false);
		expect(isChatGptWebLoopbackUrl("localhost:17841")).toBe(false);
		expect(isChatGptWebLoopbackUrl(undefined)).toBe(false);
	});

	it("normalizes base URLs that omit /v1 or already include /responses", async () => {
		expect(normalizeChatGptWebBaseUrl("http://127.0.0.1:17841")).toBe("http://127.0.0.1:17841/v1");
		expect(normalizeChatGptWebBaseUrl("http://127.0.0.1:17841/")).toBe("http://127.0.0.1:17841/v1");
		expect(normalizeChatGptWebBaseUrl("http://127.0.0.1:17841/v1")).toBe("http://127.0.0.1:17841/v1");
		expect(normalizeChatGptWebBaseUrl("http://127.0.0.1:17841/v1/responses")).toBe("http://127.0.0.1:17841/v1");
		expect(normalizeChatGptWebBaseUrl("http://localhost:17841")).toBe("http://localhost:17841/v1");
		expect(normalizeChatGptWebBaseUrl(undefined)).toBe(CHATGPT_WEB_LOCAL_ENDPOINT);

		// Verified on fetch: port-only baseUrl reaches daemon /v1/models and points model to /v1/responses
		const { fetchFn, requestedUrls } = daemon();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: "http://127.0.0.1:17841", fetchFn });
		expect(result).not.toBeNull();
		expect(requestedUrls).toEqual([HEALTH_URL, MODELS_URL]);
		for (const model of result?.models ?? []) {
			expect(model.baseUrl).toBe("http://127.0.0.1:17841/v1/responses");
		}
	});

	it("sends the bearer on the catalog request once the host is loopback", async () => {
		const { fetchFn, requestedUrls, authorizations } = daemon();
		await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn });

		expect(requestedUrls).toEqual([HEALTH_URL, MODELS_URL]);
		// The health probe is unauthenticated; only the proxied catalog request
		// carries the credential.
		expect(authorizations).toEqual([null, `Bearer ${TOKEN}`]);
	});

	it("reports the missing sign-in instead of asking the daemon to proxy without one", async () => {
		for (const accessToken of ["", "   "]) {
			const { fetchFn, requestedUrls } = daemon();
			const { failures, onFailure } = collect();
			const result = await fetchChatGptWebModels({ accessToken, baseUrl: BASE, fetchFn, onFailure });

			expect(result).toBeNull();
			expect(requestedUrls).toEqual([]);
			expect(failures.map(failure => failure.stage)).toEqual(["status"]);
			expect(failures[0]?.detail).toContain("bearer");
		}
	});
});

describe("a discovery failure says which of the four things went wrong", () => {
	it("separates a refused connection, a rejected credential, an unreadable body and a foreign payload", async () => {
		const cases: { options: DaemonOptions; stage: DiscoveryFailure["stage"]; detail: string }[] = [
			{ options: { refuse: true }, stage: "request", detail: "ECONNREFUSED" },
			{ options: { status: 401 }, stage: "status", detail: "HTTP 401" },
			{ options: { rawBody: "<html>proxy error</html>" }, stage: "body", detail: "not JSON" },
			{ options: { payload: { data: [] } }, stage: "payload", detail: "recognize" },
		];
		for (const { options, stage, detail } of cases) {
			const { fetchFn } = daemon(options);
			const { failures, onFailure } = collect();
			const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn, onFailure });

			expect(result).toBeNull();
			expect(failures.map(failure => failure.stage)).toEqual([stage]);
			expect(failures[0]?.detail).toContain(detail);
			expect(failures[0]?.url).toBe(MODELS_URL);
		}
	});

	it("answers an empty list, not a failure, when the endpoint serves no bridge rows", async () => {
		// A Codex-compatible proxy that is not this bridge: it answered, and it has
		// nothing of ours. "Asked and told nothing" is a different fact from "could
		// not ask", and only the second is a reason to keep a cached catalog.
		const { fetchFn } = daemon({ payload: { models: DAEMON_PAYLOAD.models.filter(m => !m.slug.startsWith(CHATGPT_WEB_MODEL_ID_PREFIX)) } });
		const { failures, onFailure } = collect();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn, onFailure });

		expect(result).not.toBeNull();
		expect(result?.models).toEqual([]);
		expect(failures).toEqual([]);
	});

	it("stays quiet when discovery succeeds", async () => {
		const { fetchFn } = daemon();
		const { failures, onFailure } = collect();
		const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: BASE, fetchFn, onFailure });

		expect(result?.models.length).toBe(ROUTED_SLUGS.length);
		expect(failures).toEqual([]);
	});
});

describe("the model manager cannot fall back to a locally declared catalog", () => {
	it("resolves no rows at all when the daemon cannot be reached", async () => {
		const { fetchFn } = daemon({ refuse: true });
		const options = chatGptWebModelManagerOptions({ apiKey: TOKEN, baseUrl: BASE, fetch: fetchFn });
		const { failures, onFailure } = collect();

		// An empty static catalog plus an authoritative dynamic fetch: there is no
		// bundled row to serve, so a dead daemon produces no models rather than a
		// list of slugs that would fail at request time.
		expect(options.providerId).toBe(CHATGPT_WEB_PROVIDER_ID);
		expect(options.staticModels).toEqual([]);
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(await options.fetchDynamicModels?.({ onFailure })).toBeNull();
		expect(failures.map(failure => failure.stage)).toEqual(["request"]);
	});

	it("passes the live rows through when it can", async () => {
		const { fetchFn } = daemon();
		const options = chatGptWebModelManagerOptions({ apiKey: TOKEN, baseUrl: BASE, fetch: fetchFn });
		const models = await options.fetchDynamicModels?.();

		expect(models?.map(model => model.id).sort()).toEqual([...ROUTED_SLUGS].sort());
	});
});

/**
 * Two real loopback servers: the one discovery is pointed at, which answers a
 * 302 for the requested path, and the one that 302 names, which would serve a
 * perfectly good daemon answer if anything ever reached it.
 *
 * The second server is the negative control and the reason this is not a spy
 * assertion. `redirect: "error"` is enforced by the runtime's fetch, not by the
 * reader, so the only way to prove it holds is to make following the hop
 * observable: if the option were dropped, the target would record a request and
 * discovery would answer with its rows.
 */
async function startRedirectPair(
	redirected: "models" | "health",
): Promise<{ base: string; followedPaths: string[]; close: () => Promise<void> }> {
	const followedPaths: string[] = [];
	const target = http.createServer((req, res) => {
		followedPaths.push(req.url ?? "");
		if ((req.url ?? "").startsWith("/healthz")) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok", service: "codex-chatgpt-web", version: "4.0.5", mode: "full" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(DAEMON_PAYLOAD));
	});
	await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
	const targetAddress = target.address();
	if (targetAddress === null || typeof targetAddress === "string") throw new Error("target did not bind a port");
	const targetOrigin = `http://127.0.0.1:${targetAddress.port}`;

	const entry = http.createServer((req, res) => {
		const url = req.url ?? "";
		const isHealth = url.startsWith("/healthz");
		if ((redirected === "health") === isHealth) {
			res.writeHead(302, { location: `${targetOrigin}${url}` });
			res.end();
			return;
		}
		if (isHealth) {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok", service: "codex-chatgpt-web", version: "4.0.5", mode: "full" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(DAEMON_PAYLOAD));
	});
	await new Promise<void>(resolve => entry.listen(0, "127.0.0.1", resolve));
	const entryAddress = entry.address();
	if (entryAddress === null || typeof entryAddress === "string") throw new Error("entry did not bind a port");

	const shut = (server: http.Server): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			server.closeAllConnections();
			if (!server.listening) {
				resolve();
				return;
			}
			server.close(error => (error ? reject(error) : resolve()));
		});
	return {
		base: `http://127.0.0.1:${entryAddress.port}/v1`,
		followedPaths,
		close: async () => {
			await shut(entry);
			await shut(target);
		},
	};
}

describe("the loopback guard is not undone by a redirect", () => {
	it("refuses the catalog request rather than following a 302 off the checked URL", async () => {
		const pair = await startRedirectPair("models");
		try {
			const { failures, onFailure } = collect();
			const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: pair.base, onFailure });

			// The redirect target never heard from us — it holds a valid answer, so
			// a followed hop would have produced rows instead of this failure.
			expect(pair.followedPaths).toEqual([]);
			expect(result).toBeNull();
			expect(failures.map(failure => failure.stage)).toEqual(["request"]);
			expect(failures[0]?.url).toBe(`${pair.base}/models`);
		} finally {
			await pair.close();
		}
	});

	it("treats a redirecting health probe as Full mode unproven, not as Full mode", async () => {
		const pair = await startRedirectPair("health");
		try {
			const { failures, onFailure } = collect();
			const result = await fetchChatGptWebModels({ accessToken: TOKEN, baseUrl: pair.base, onFailure });

			expect(pair.followedPaths).toEqual([]);
			// The catalog itself still comes through: a silent probe is not a
			// discovery failure, which is the existing contract.
			expect(result?.models.length).toBe(ROUTED_SLUGS.length);
			expect(failures).toEqual([]);
			// But the capability the probe would have authorized is withheld. The
			// target reports `mode: "full"`, so following the hop would publish
			// tool support on the word of something that is not the daemon.
			expect(result?.mode).toBeUndefined();
			for (const model of result?.models ?? []) expect(model.supportsTools).toBe(false);
		} finally {
			await pair.close();
		}
	});
});
