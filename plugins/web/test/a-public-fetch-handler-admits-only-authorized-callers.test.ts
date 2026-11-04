import { describe, expect, it } from "bun:test";
import type { PublicFetchAdmission, PublicFetchAdmissionDecision, PublicFetchAdmissionRequest } from "@veyyon/web/public-fetch";
import {
	createPublicFetchHandler,
	type PublicFetchAuthorize,
	type PublicFetchHandler,
	type PublicFetchHandlerDeps,
} from "@veyyon/web/public-fetch-handler";
import type { PublicFetchTransport } from "@veyyon/web/public-fetch-transport";

/**
 * Locks the HTTP boundary of the public fetch service: identity comes only from
 * the injected authorize function, every refusal is a fixed status that does
 * not echo the URL or the credential, and an authorized GET reaches the real
 * service through one deadline.
 *
 * The subject is the real handler and the real service. The external boundaries
 * are fakes: authorize (the caller's identity), admission (the quota) and
 * transport (DNS and the pinned dial). A refused request is proven by the
 * absence of any admission reservation or upstream call. This suite cannot
 * prove the pinned TLS socket; that needs a runtime test, and none was run.
 */

const PUBLIC_IPV4 = "93.184.216.34";
const TOKEN = "token-7f3a-do-not-echo";
const SECRET_PATH = "/private-path-9c1e";
const BASE = "https://fetch.test";
const PUBLIC_URL = "https://example.com/page";

class FakeAdmission implements PublicFetchAdmission {
	readonly requests: PublicFetchAdmissionRequest[] = [];
	readonly #decide: () => Promise<PublicFetchAdmissionDecision>;

	constructor(decide: () => Promise<PublicFetchAdmissionDecision>) {
		this.#decide = decide;
	}

	reserve(request: PublicFetchAdmissionRequest): Promise<PublicFetchAdmissionDecision> {
		this.requests.push(request);
		return this.#decide();
	}
}

/** Records every DNS query and dial, and answers each dial from `respond`. */
class FakeTransport implements PublicFetchTransport {
	readonly resolved: string[] = [];
	readonly dials: string[] = [];
	readonly #respond: (url: URL) => Response | Promise<Response>;

	constructor(respond: (url: URL) => Response | Promise<Response>) {
		this.#respond = respond;
	}

	async resolve(hostname: string): Promise<readonly string[]> {
		this.resolved.push(hostname);
		return hostname === "example.com" ? [PUBLIC_IPV4] : [];
	}

	async get(url: URL): Promise<Response> {
		this.dials.push(url.href);
		return this.#respond(url);
	}
}

interface Harness {
	handler: PublicFetchHandler;
	admission: FakeAdmission;
	transport: FakeTransport;
}

function granting(): FakeAdmission {
	return new FakeAdmission(async () => ({ allowed: true, expiresAt: Date.now() + 60_000 }));
}

function authorizing(userId: string): PublicFetchAuthorize {
	return async (_request, scope) => (scope === "fetch:public" ? { userId } : null);
}

function harness(options: {
	authorize: PublicFetchAuthorize;
	admission?: FakeAdmission;
	transport?: FakeTransport;
	timeoutMs?: number;
}): Harness {
	const admission = options.admission ?? granting();
	const transport =
		options.transport ??
		new FakeTransport(
			() =>
				new Response("<html><body><p>Hello public world</p></body></html>", {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		);
	const deps: PublicFetchHandlerDeps = {
		authorize: options.authorize,
		admission,
		transport,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	};
	return { handler: createPublicFetchHandler(deps), admission, transport };
}

const DENIALS: Array<[string, PublicFetchAuthorize]> = [
	["a null identity", async () => null],
	["an undefined identity", async () => undefined as unknown as null],
	["an empty user id", async () => ({ userId: "" })],
	["an identity without a user id", async () => ({}) as unknown as { userId: string }],
];

describe("public fetch handler denies a caller the authorize function does not admit", () => {
	it.each(DENIALS)("answers 403 for %s without a quota reservation or an upstream call", async (_label, authorize) => {
		const { handler, admission, transport } = harness({ authorize });
		const response = await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`));
		expect(response.status).toBe(403);
		expect(admission.requests).toHaveLength(0);
		expect(transport.resolved).toHaveLength(0);
		expect(transport.dials).toHaveLength(0);
	});

	it("answers 403 when authorize throws, and the body names neither the token nor the URL", async () => {
		const { handler, admission, transport } = harness({
			authorize: async () => {
				throw new Error(`lookup failed for ${TOKEN}`);
			},
		});
		const response = await handler(
			new Request(`${BASE}${SECRET_PATH}?url=${PUBLIC_URL}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
		);
		const body = await response.text();
		expect(response.status).toBe(403);
		expect(body).not.toContain(TOKEN);
		expect(body).not.toContain(SECRET_PATH);
		expect(body).not.toContain("example.com");
		expect(admission.requests).toHaveLength(0);
		expect(transport.dials).toHaveLength(0);
	});
});

describe("public fetch handler takes the identity only from authorize", () => {
	it("passes the authorized user id to admission and ignores identity headers and parameters", async () => {
		const { handler, admission } = harness({ authorize: authorizing("alice") });
		const response = await handler(
			new Request(`${BASE}/?url=${PUBLIC_URL}&userId=victim`, {
				headers: { "x-user-id": "victim", "x-user": "victim", "x-forwarded-user": "victim" },
			}),
		);
		expect(response.status).toBe(200);
		expect(admission.requests.map((request) => request.userId)).toEqual(["alice"]);
		expect(admission.requests[0]?.scope).toBe("fetch:public");
	});

	it("hands authorize the request and the fetch:public scope", async () => {
		const seen: Array<{ url: string; scope: string }> = [];
		const { handler } = harness({
			authorize: async (request, scope) => {
				seen.push({ url: request.url, scope });
				return { userId: "alice" };
			},
		});
		await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`));
		expect(seen).toEqual([{ url: `${BASE}/?url=${PUBLIC_URL}`, scope: "fetch:public" }]);
	});
});

describe("public fetch handler serves an authorized GET as no-store JSON", () => {
	it("returns the readable page as JSON with JSON and no-store headers", async () => {
		const { handler, transport } = harness({ authorize: authorizing("alice") });
		const response = await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = (await response.json()) as { url: string; contentType: string; text: string; truncated: boolean };
		expect(body.url).toBe(PUBLIC_URL);
		expect(body.contentType).toBe("text/html");
		expect(body.text).toContain("Hello public world");
		expect(body.truncated).toBe(false);
		expect(transport.dials).toEqual([PUBLIC_URL]);
	});
});

describe("public fetch handler refuses a malformed request before the service", () => {
	it.each(["POST", "PUT", "DELETE", "HEAD", "PATCH"])("answers 405 with Allow: GET for %s", async (method) => {
		const { handler, admission, transport } = harness({ authorize: authorizing("alice") });
		const response = await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`, { method }));
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
		expect(admission.requests).toHaveLength(0);
		expect(transport.dials).toHaveLength(0);
	});

	it.each([
		["no url parameter", `${BASE}/`],
		["a repeated url parameter", `${BASE}/?url=${PUBLIC_URL}&url=${PUBLIC_URL}`],
		["an empty url parameter", `${BASE}/?url=`],
		["an http URL", `${BASE}/?url=http://example.com/`],
		["a non-URL value", `${BASE}/?url=not-a-url`],
	])("answers 400 for %s without a quota reservation", async (_label, target) => {
		const { handler, admission, transport } = harness({ authorize: authorizing("alice") });
		const response = await handler(new Request(target));
		expect(response.status).toBe(400);
		expect(admission.requests).toHaveLength(0);
		expect(transport.dials).toHaveLength(0);
	});
});

describe("public fetch handler maps each failure to a fixed status without echoing input", () => {
	it("answers 502 for a literal private address and does not repeat it", async () => {
		const { handler, transport } = harness({ authorize: authorizing("alice") });
		const response = await handler(new Request(`${BASE}/?url=https://127.0.0.1/`));
		const body = await response.text();
		expect(response.status).toBe(502);
		expect(body).not.toContain("127.0.0.1");
		expect(transport.dials).toHaveLength(0);
	});

	it("answers 429 when admission denies the reservation, with no upstream call", async () => {
		const { handler, transport } = harness({
			authorize: authorizing("alice"),
			admission: new FakeAdmission(async () => ({ allowed: false, expiresAt: Date.now() + 60_000 })),
		});
		const response = await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`));
		expect(response.status).toBe(429);
		expect(transport.dials).toHaveLength(0);
	});

	it("answers 502 when the admission grant has already expired", async () => {
		const { handler, transport } = harness({
			authorize: authorizing("alice"),
			admission: new FakeAdmission(async () => ({ allowed: true, expiresAt: Date.now() - 1 })),
		});
		const response = await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`));
		expect(response.status).toBe(502);
		expect(transport.dials).toHaveLength(0);
	});

	it("answers 504 with an explicit timeout when the upstream dial never settles", async () => {
		const { handler } = harness({
			authorize: authorizing("alice"),
			timeoutMs: 50,
			transport: new FakeTransport(() => Promise.withResolvers<Response>().promise),
		});
		const response = await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`));
		expect(response.status).toBe(504);
		expect(await response.json()).toEqual({ error: "public fetch timed out" });
	});

	it("answers 504 when authorize never settles, so the deadline covers authorization", async () => {
		const { handler, admission } = harness({
			authorize: () => Promise.withResolvers<{ userId: string } | null>().promise,
			timeoutMs: 50,
		});
		const response = await handler(new Request(`${BASE}/?url=${PUBLIC_URL}`));
		expect(response.status).toBe(504);
		expect(admission.requests).toHaveLength(0);
	});
});

describe("public fetch handler refuses to start without its required dependencies", () => {
	it.each([0, -1, 15_001, Number.NaN])("refuses a configured timeout of %s at creation", (timeoutMs) => {
		expect(() => createPublicFetchHandler({ authorize: authorizing("alice"), admission: granting(), timeoutMs })).toThrow(
			/timeout must be above 0 and at most 15000/,
		);
	});

	it("refuses to create without an admission object", () => {
		expect(() =>
			createPublicFetchHandler({ authorize: authorizing("alice") } as unknown as PublicFetchHandlerDeps),
		).toThrow(/needs an admission object/);
	});

	it("refuses to create without an authorize function", () => {
		expect(() => createPublicFetchHandler({ admission: granting() } as unknown as PublicFetchHandlerDeps)).toThrow(
			/needs an authorize function/,
		);
	});
});
