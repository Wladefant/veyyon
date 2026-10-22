// WHY: public search spends a paid upstream key on behalf of anonymous callers, so the cap is the only
// thing between an open endpoint and an unbounded bill. This suite drives the real handler and
// the real in-memory budget, and fakes only the external Brave fetch. It defends three classes:
// (1) a request that is not admitted never reaches a credential, a charge or the network, (2) every
// admitted request is counted before the upstream call and that count is never refunded, and
// (3) an error response never carries a key or a query. It does not cover durability or sharing:
// a restart resets the in-memory budget, and two Worker instances each admit the full cap. A
// shared, durable budget needs an atomic store, and a test of that belongs with the store.
import { describe, expect, it } from "bun:test";
import {
	BRAVE_WEB_SEARCH_URL,
	type BraveKey,
	createPublicSearchHandler,
	InMemoryPublicSearchBudget,
	type PublicSearchFetch,
} from "../src/public-search";

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0, 0);
const FAR_FUTURE = Date.UTC(2100, 0, 1);
const KEY_MARKER = "BRAVE-KEY-MARKER-7f3a91";
const QUERY_MARKER = "QUERY-MARKER-9c1d2e";
const MINUTE_MS = 60_000;

interface Account {
	token: string;
	userId: string;
	key: BraveKey | null;
}

const ALICE: Account = { token: "token-alice", userId: "alice", key: { apiKey: "key-alice", costMicrousdPerRequest: 1 } };
const BOB: Account = { token: "token-bob", userId: "bob", key: { apiKey: "key-bob", costMicrousdPerRequest: 1 } };
const CAROL: Account = { token: "token-carol", userId: "carol", key: null };

interface UpstreamCall {
	url: URL;
	token: string | null;
	redirect: RequestRedirect | undefined;
}

interface Upstream {
	calls: UpstreamCall[];
	fetch: PublicSearchFetch;
}

function upstream(respond: (index: number) => Response = () => okResponse([])): Upstream {
	const calls: UpstreamCall[] = [];
	const fetch: PublicSearchFetch = async (input, init) => {
		calls.push({
			url: new URL(input),
			token: new Headers(init.headers).get("X-Subscription-Token"),
			redirect: init.redirect,
		});
		return respond(calls.length);
	};
	return { calls, fetch };
}

function okResponse(results: unknown[]): Response {
	return new Response(JSON.stringify({ web: { results } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

interface HarnessOptions {
	accounts?: Account[];
	upstream?: Upstream;
	start?: number;
	budgetExpiresAt?: number;
}

function harness(options: HarnessOptions = {}) {
	const accounts = options.accounts ?? [ALICE, BOB, CAROL];
	const byToken = new Map(accounts.map((account) => [account.token, account] as const));
	const lookups: string[] = [];
	const fake = options.upstream ?? upstream();
	const clock = { nowMs: options.start ?? T0 };
	const handle = createPublicSearchHandler({
		authorize: async (request) => {
			const token = request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
			const account = byToken.get(token);
			return account ? { userId: account.userId } : null;
		},
		resolveBraveKey: async (userId) => {
			lookups.push(userId);
			return accounts.find((account) => account.userId === userId)?.key ?? null;
		},
		budget: new InMemoryPublicSearchBudget({ expiresAt: options.budgetExpiresAt ?? FAR_FUTURE }),
		fetch: fake.fetch,
		now: () => clock.nowMs,
	});
	return { handle, lookups, upstream: fake, clock };
}

interface Harness {
	handle: (request: Request) => Promise<Response>;
	lookups: string[];
	upstream: Upstream;
	clock: { nowMs: number };
}

function searchRequest(body: unknown, token: string | null = ALICE.token): Request {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token !== null) headers.authorization = `Bearer ${token}`;
	return new Request("https://worker.test/v1/search", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function send(h: Harness, body: unknown, token: string = ALICE.token): Promise<Response> {
	return h.handle(searchRequest(body, token));
}

describe("public search admission", () => {
	it("refuses an unadmitted request before any key lookup, charge or upstream call", async () => {
		const h = harness();
		const unknown = await send(h, { query: "rust" }, "token-nobody");
		const missing = await send(h, { query: "rust" }, null);

		expect(unknown.status).toBe(401);
		expect(missing.status).toBe(401);
		expect(await unknown.json()).toEqual({ error: "unauthorized" });
		expect(h.lookups).toEqual([]);
		expect(h.upstream.calls).toHaveLength(0);
	});

	it("refuses a body that names a user, key or any extra field before a key lookup or upstream call", async () => {
		const h = harness();
		const smuggled = [
			{ query: "rust", userId: "bob" },
			{ query: "rust", apiKey: KEY_MARKER },
			{ query: "rust", count: 50 },
		];
		for (const body of smuggled) {
			expect((await send(h, body)).status).toBe(400);
		}
		expect(h.lookups).toEqual([]);
		expect(h.upstream.calls).toHaveLength(0);
	});

	it("refuses a body that is not exactly one non-blank query of at most 2048 characters, or a non-POST method", async () => {
		const h = harness();
		const invalid = [
			"not json",
			"[]",
			"{}",
			{ query: 5 },
			{ query: "   " },
			{ query: "x".repeat(2049) },
		];
		for (const body of invalid) {
			expect((await send(h, body)).status).toBe(400);
		}
		const get = await h.handle(new Request("https://worker.test/v1/search", {
			method: "GET",
			headers: { authorization: `Bearer ${ALICE.token}` },
		}));
		expect(get.status).toBe(405);
		expect(h.upstream.calls).toHaveLength(0);
	});

	it("accepts a query of exactly 2048 characters", async () => {
		const h = harness();
		expect((await send(h, { query: "x".repeat(2048) })).status).toBe(200);
		expect(h.upstream.calls).toHaveLength(1);
	});

	it("refuses a request body over 8 KiB before any key lookup or upstream call", async () => {
		const h = harness();
		const res = await send(h, { query: QUERY_MARKER + "y".repeat(9000) });
		expect(res.status).toBe(413);
		expect(h.lookups).toEqual([]);
		expect(h.upstream.calls).toHaveLength(0);
	});
});

describe("per-user credentials and limits", () => {
	it("sends each user's own key, refuses a user with no key, and keeps the minute limit separate per user", async () => {
		const h = harness();
		for (let i = 0; i < 5; i++) {
			expect((await send(h, { query: "rust" }, ALICE.token)).status).toBe(200);
		}
		expect((await send(h, { query: "rust" }, ALICE.token)).status).toBe(429);

		expect((await send(h, { query: "rust" }, BOB.token)).status).toBe(200);

		const carol = await send(h, { query: "rust" }, CAROL.token);
		expect(carol.status).toBe(403);
		expect(await carol.json()).toEqual({ error: "no_key" });

		expect(h.upstream.calls.map((call) => call.token)).toEqual([
			"key-alice",
			"key-alice",
			"key-alice",
			"key-alice",
			"key-alice",
			"key-bob",
		]);
		expect(h.lookups).toEqual(["alice", "alice", "alice", "alice", "alice", "alice", "bob", "carol"]);
	});

	it("admits the sixth search in a rolling minute only at exactly 60000 ms after the first", async () => {
		const h = harness({ start: T0 });
		for (let i = 0; i < 5; i++) {
			expect((await send(h, { query: "rust" })).status).toBe(200);
		}

		h.clock.nowMs = T0 + MINUTE_MS - 1;
		const at59999 = await send(h, { query: "rust" });
		expect(at59999.status).toBe(429);
		expect(await at59999.json()).toEqual({ error: "quota", reason: "minute_limit" });

		h.clock.nowMs = T0 + MINUTE_MS;
		expect((await send(h, { query: "rust" })).status).toBe(200);
		expect(h.upstream.calls).toHaveLength(6);
	});

	it("admits 500 searches per UTC month, refuses the 501st, and resets when the next UTC month begins", async () => {
		const h = harness({ start: T0 });
		for (let i = 0; i < 500; i++) {
			h.clock.nowMs = T0 + Math.floor(i / 5) * MINUTE_MS;
			expect((await send(h, { query: "rust" })).status).toBe(200);
		}
		expect(h.upstream.calls).toHaveLength(500);

		h.clock.nowMs = T0 + 100 * MINUTE_MS;
		const refused = await send(h, { query: "rust" });
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "quota", reason: "month_limit" });
		expect(h.upstream.calls).toHaveLength(500);

		h.clock.nowMs = Date.UTC(2026, 10, 1, 0, 0, 0, 0);
		expect((await send(h, { query: "rust" })).status).toBe(200);
		expect(h.upstream.calls).toHaveLength(501);
	});

	it("caps a month by microusd independently of the request count, at 2500000 microusd", async () => {
		const expensive: Account = {
			token: "token-dave",
			userId: "dave",
			key: { apiKey: "key-dave", costMicrousdPerRequest: 1_000_000 },
		};
		const h = harness({ accounts: [expensive] });
		expect((await send(h, { query: "rust" }, expensive.token)).status).toBe(200);
		expect((await send(h, { query: "rust" }, expensive.token)).status).toBe(200);

		const third = await send(h, { query: "rust" }, expensive.token);
		expect(third.status).toBe(429);
		expect(await third.json()).toEqual({ error: "quota", reason: "cost_limit" });
		expect(h.upstream.calls).toHaveLength(2);
	});

	it("refuses a key whose cost is not a positive safe integer with 503 and no upstream call", async () => {
		const bad: Account[] = [0, 1.5, -1, Number.MAX_SAFE_INTEGER + 2].map((cost, index) => ({
			token: `token-bad-${index}`,
			userId: `bad-${index}`,
			key: { apiKey: "key-bad", costMicrousdPerRequest: cost },
		}));
		const h = harness({ accounts: bad });
		for (const account of bad) {
			const res = await send(h, { query: "rust" }, account.token);
			expect(res.status).toBe(503);
			expect(await res.json()).toEqual({ error: "invalid_key_config" });
		}
		expect(h.upstream.calls).toHaveLength(0);
	});
});

describe("budget failure modes fail closed", () => {
	it("refuses every search once the budget has expired", async () => {
		const h = harness({ start: T0, budgetExpiresAt: T0 });
		const res = await send(h, { query: "rust" });
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({ error: "quota", reason: "expired" });
		expect(h.upstream.calls).toHaveLength(0);
	});

	it("returns 503 when the clock moves backwards or is not a number, with no upstream call for the bad clock", async () => {
		const h = harness({ start: T0 + 1000 });
		expect((await send(h, { query: "rust" })).status).toBe(200);

		h.clock.nowMs = T0;
		const backwards = await send(h, { query: "rust" });
		expect(backwards.status).toBe(503);
		expect(await backwards.json()).toEqual({ error: "budget_unavailable" });

		h.clock.nowMs = Number.NaN;
		expect((await send(h, { query: "rust" })).status).toBe(503);
		expect(h.upstream.calls).toHaveLength(1);
	});

	it("rejects a budget whose expiry is not finite", () => {
		expect(() => new InMemoryPublicSearchBudget({ expiresAt: Number.POSITIVE_INFINITY })).toThrow(RangeError);
		expect(() => new InMemoryPublicSearchBudget({ expiresAt: Number.NaN })).toThrow(RangeError);
	});
});

describe("concurrency and failed upstream attempts", () => {
	it("admits only five of twelve concurrent searches from one user", async () => {
		const h = harness({ start: T0 });
		const responses = await Promise.all(
			Array.from({ length: 12 }, () => send(h, { query: "rust" })),
		);
		const statuses = responses.map((res) => res.status).sort((a, b) => a - b);
		expect(statuses.filter((status) => status === 200)).toHaveLength(5);
		expect(statuses.filter((status) => status === 429)).toHaveLength(7);
		expect(h.upstream.calls).toHaveLength(5);
	});

	it("counts a failed upstream attempt against the cap and never retries it", async () => {
		const expensive: Account = {
			token: "token-erin",
			userId: "erin",
			key: { apiKey: "key-erin", costMicrousdPerRequest: 1_000_000 },
		};
		const h = harness({
			accounts: [expensive],
			upstream: upstream((index) => {
				if (index === 1) return new Response("upstream says key-erin rust", { status: 500 });
				if (index === 2) throw new Error(`network down for ${KEY_MARKER}`);
				return okResponse([]);
			}),
		});

		const first = await send(h, { query: "rust" }, expensive.token);
		expect(first.status).toBe(502);
		expect(await first.json()).toEqual({ error: "upstream_failed" });

		const second = await send(h, { query: "rust" }, expensive.token);
		expect(second.status).toBe(502);

		const third = await send(h, { query: "rust" }, expensive.token);
		expect(third.status).toBe(429);
		expect(await third.json()).toEqual({ error: "quota", reason: "cost_limit" });
		expect(h.upstream.calls).toHaveLength(2);
	});

	it("returns 502 for an oversize or malformed upstream body and still counts the attempt", async () => {
		const h = harness({
			upstream: upstream((index) => {
				if (index === 1) return new Response("x".repeat(256 * 1024 + 1), { status: 200 });
				return new Response("{not json", { status: 200 });
			}),
		});

		const oversize = await send(h, { query: "rust" });
		expect(oversize.status).toBe(502);
		expect(await oversize.json()).toEqual({ error: "upstream_oversize" });

		const malformed = await send(h, { query: "rust" });
		expect(malformed.status).toBe(502);
		expect(await malformed.json()).toEqual({ error: "upstream_malformed" });
		expect(h.upstream.calls).toHaveLength(2);
	});
});

describe("upstream request and response contract", () => {
	it("calls the fixed Brave endpoint once with the query, count, filter and no redirects", async () => {
		const h = harness();
		expect((await send(h, { query: "rust lang" })).status).toBe(200);

		const [call] = h.upstream.calls;
		expect(call.url.origin + call.url.pathname).toBe(BRAVE_WEB_SEARCH_URL);
		expect(call.url.searchParams.get("q")).toBe("rust lang");
		expect(call.url.searchParams.get("count")).toBe("10");
		expect(call.url.searchParams.get("result_filter")).toBe("web");
		expect(call.url.searchParams.get("text_decorations")).toBe("false");
		expect(call.redirect).toBe("error");
		expect(h.upstream.calls).toHaveLength(1);
	});

	it("returns at most ten results with exactly title, url and snippet, bounded and without summary fields", async () => {
		const longTitle = "T".repeat(300);
		const longSnippet = "S".repeat(1500);
		const longUrl = `https://example.com/${"p".repeat(2100)}`;
		const exactUrl = `https://example.com/${"q".repeat(2048 - "https://example.com/".length)}`;
		const results = [
			{ title: "script", url: "javascript:alert(1)", description: "x" },
			{ title: "creds", url: "https://user:pw@example.com/", description: "x" },
			{ title: "ftp", url: "ftp://example.com/file", description: "x" },
			{
				title: longTitle,
				url: "https://example.com/a",
				description: longSnippet,
				summary: "AI generated text",
				enrichments: { items: [] },
				age: "1d",
			},
			{ title: "exact", url: exactUrl, description: "" },
			{ title: "long", url: longUrl, description: "" },
			...Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, description: `d${i}` })),
			{ title: "dropped", url: "https://example.com/11", description: "dropped" },
		];
		const h = harness({ upstream: upstream(() => okResponse(results)) });

		const res = await send(h, { query: "rust" });
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as { results: Array<Record<string, unknown>> };

		expect(Object.keys(body)).toEqual(["results"]);
		for (const item of body.results) {
			expect(Object.keys(item).sort()).toEqual(["snippet", "title", "url"]);
		}
		expect(body.results[0]).toEqual({
			title: "T".repeat(256),
			url: "https://example.com/a",
			snippet: "S".repeat(1024),
		});
		expect(body.results[1]).toEqual({ title: "exact", url: exactUrl, snippet: "" });
		// The overlong URL is skipped, not cut, and frees its slot: the ten admitted results are exactly these.
		expect(body.results.map((item) => item.url)).toEqual([
			"https://example.com/a",
			exactUrl,
			...Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`),
		]);
		expect(JSON.stringify(body)).not.toContain("AI generated text");
		expect(JSON.stringify(body)).not.toContain("user:pw");
	});

	it("keeps the upstream key, the query and the upstream text out of every error response", async () => {
		const leaky: Account = {
			token: "token-frank",
			userId: "frank",
			key: { apiKey: KEY_MARKER, costMicrousdPerRequest: 1 },
		};
		const scenarios: Array<() => Promise<Response>> = [];
		const failing = harness({
			accounts: [leaky],
			upstream: upstream(() => new Response(`echo ${KEY_MARKER} ${QUERY_MARKER}`, { status: 500 })),
		});
		scenarios.push(() => send(failing, { query: QUERY_MARKER }, leaky.token));

		const throwing = harness({
			accounts: [leaky],
			upstream: upstream(() => {
				throw new Error(`refused ${KEY_MARKER} ${QUERY_MARKER}`);
			}),
		});
		scenarios.push(() => send(throwing, { query: QUERY_MARKER }, leaky.token));

		const malformed = harness({
			accounts: [leaky],
			upstream: upstream(() => new Response(`{"echo":"${KEY_MARKER} ${QUERY_MARKER}"`, { status: 200 })),
		});
		scenarios.push(() => send(malformed, { query: QUERY_MARKER }, leaky.token));

		const invalid = harness({ accounts: [leaky] });
		scenarios.push(() => send(invalid, `{"query":"${QUERY_MARKER}","x":1}`, leaky.token));

		const oversize = harness({ accounts: [leaky] });
		scenarios.push(() => send(oversize, { query: QUERY_MARKER + "z".repeat(9000) }, leaky.token));

		for (const scenario of scenarios) {
			const res = await scenario();
			expect(res.status).toBeGreaterThanOrEqual(400);
			const text = await res.text();
			expect(text).not.toContain(KEY_MARKER);
			expect(text).not.toContain(QUERY_MARKER);
		}
	});
});
