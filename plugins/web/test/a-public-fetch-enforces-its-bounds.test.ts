import { describe, expect, it } from "bun:test";
import {
	createPublicFetchService,
	type PublicFetchAdmission,
	type PublicFetchAdmissionDecision,
	type PublicFetchAdmissionRequest,
	type PublicFetchService,
} from "@veyyon/web/public-fetch";
import type { PublicFetchTransport } from "@veyyon/web/public-fetch-transport";

/**
 * Locks the bounds of the public fetch service: admission before any upstream
 * request, URL and DNS vetting before any dial, the redirect cap with
 * re-vetting on every hop, the media-type and charset allow-lists, the 2 MiB
 * read cap, the 256 KiB UTF-8 output cap, and the deadline.
 *
 * The subject is the real service. Only its two external boundaries are fakes:
 * the transport (DNS and the pinned dial) and the admission quota. A fake
 * transport records every resolve and dial, so a refused request is proven by
 * the absence of any upstream call. It cannot prove that the pinned socket
 * refuses a DNS change between vetting and dialing; that is the transport's
 * own test. The deadline tests use a 50 ms budget through the explicit
 * `timeoutMs` seam, because the default 15 s would make them slow.
 */

const PUBLIC_IPV4 = "93.184.216.34";
const PUBLIC_IPV6 = "2606:2800:220:1:248:1893:25c8:1946";
const DEFAULT_DNS: Record<string, readonly string[]> = { "example.com": [PUBLIC_IPV4] };
const MIB = 1024 * 1024;
const OUTPUT_LIMIT = 256 * 1024;
const CHUNK = 64 * 1024;

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

function grantedAdmission(): FakeAdmission {
	return new FakeAdmission(async () => ({ allowed: true, expiresAt: Date.now() + 60_000 }));
}

/** Records every DNS query and dial, and answers each dial from a route. */
class FakeTransport implements PublicFetchTransport {
	readonly resolved: string[] = [];
	readonly dials: Array<{ url: string; address: string }> = [];
	readonly #dns: Readonly<Record<string, readonly string[]>>;
	readonly #respond: (url: URL) => Response | Promise<Response>;

	constructor(
		dns: Readonly<Record<string, readonly string[]>>,
		respond: (url: URL) => Response | Promise<Response>,
	) {
		this.#dns = dns;
		this.#respond = respond;
	}

	async resolve(hostname: string): Promise<readonly string[]> {
		this.resolved.push(hostname);
		return this.#dns[hostname] ?? [];
	}

	async get(url: URL, address: string): Promise<Response> {
		this.dials.push({ url: url.href, address });
		return this.#respond(url);
	}
}

interface Harness {
	service: PublicFetchService;
	transport: FakeTransport;
	admission: FakeAdmission;
}

function harness(options: {
	dns?: Readonly<Record<string, readonly string[]>>;
	respond: (url: URL) => Response | Promise<Response>;
	admission?: FakeAdmission;
	timeoutMs?: number;
}): Harness {
	const transport = new FakeTransport(options.dns ?? DEFAULT_DNS, options.respond);
	const admission = options.admission ?? grantedAdmission();
	const service = createPublicFetchService({
		admission,
		transport,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});
	return { service, transport, admission };
}

function reply(body: BodyInit | null, init: { status?: number; headers?: Record<string, string> } = {}): Response {
	return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

function html(body: string): Response {
	return reply(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function plain(body: string): Response {
	return reply(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function redirect(status: number, location: string): Response {
	return reply(null, { status, headers: { location } });
}

describe("public fetch calls admission before any upstream request", () => {
	it("a denied admission sends no DNS query and no dial", async () => {
		const admission = new FakeAdmission(async () => ({ allowed: false, expiresAt: Date.now() + 60_000 }));
		const { service, transport } = harness({ respond: () => plain("x"), admission });
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/admission was denied/);
		expect(transport.resolved).toEqual([]);
		expect(transport.dials).toEqual([]);
	});

	it("an admission service that throws sends no upstream request", async () => {
		const admission = new FakeAdmission(async () => {
			throw new Error("quota store down");
		});
		const { service, transport } = harness({ respond: () => plain("x"), admission });
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/admission is unavailable/);
		expect(transport.resolved).toEqual([]);
		expect(transport.dials).toEqual([]);
	});

	it("an expired admission grant sends no upstream request", async () => {
		const admission = new FakeAdmission(async () => ({ allowed: true, expiresAt: Date.now() - 1 }));
		const { service, transport } = harness({ respond: () => plain("x"), admission });
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/has expired/);
		expect(transport.dials).toEqual([]);
	});

	it("a missing admission object fails closed without an upstream request", async () => {
		const transport = new FakeTransport(DEFAULT_DNS, () => plain("x"));
		const service = createPublicFetchService({ admission: undefined as unknown as PublicFetchAdmission, transport });
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/admission is unavailable/);
		expect(transport.resolved).toEqual([]);
		expect(transport.dials).toEqual([]);
	});

	it("a stalled admission service is cut off by the deadline without an upstream request", async () => {
		const admission = new FakeAdmission(() => Promise.withResolvers<PublicFetchAdmissionDecision>().promise);
		const { service, transport } = harness({ respond: () => plain("x"), admission, timeoutMs: 50 });
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/deadline/);
		expect(transport.dials).toEqual([]);
	});

	it("the admission request names the fetch scope and the per-user limits", async () => {
		const { service, admission } = harness({ respond: () => plain("x") });
		await service.fetchPublic("user-1", "https://example.com/");
		expect(admission.requests).toEqual([
			{ userId: "user-1", scope: "fetch:public", limits: { perMinute: 10, perMonth: 1000 } },
		]);
	});

	it("a URL refused before DNS never reserves quota", async () => {
		const { service, admission } = harness({ respond: () => plain("x") });
		await expect(service.fetchPublic("user-1", "http://example.com/")).rejects.toThrow(/only https/);
		expect(admission.requests).toEqual([]);
	});
});

describe("public fetch refuses URLs by their literal form before any DNS query", () => {
	it.each([
		["http://example.com/", /only https/],
		["https://user:secret@example.com/", /credentials/],
		["https://example.com:8443/", /port 443/],
		["https://127.0.0.1/", /non-public address literal/],
		["https://169.254.169.254/latest/meta-data", /non-public address literal/],
		["https://93.184.216.34/", /DNS name/],
		["https://[::1]/", /non-public address literal/],
		["https://localhost/", /refuses host/],
		["https://intranet/", /refuses host/],
		["https://printer.local/", /refuses host/],
		["https://wiki.internal/", /refuses host/],
		["not a url", /absolute URL/],
	])("refuses %s", async (url, pattern) => {
		const { service, transport, admission } = harness({ respond: () => plain("x") });
		await expect(service.fetchPublic("user-1", url)).rejects.toThrow(pattern);
		expect(transport.resolved).toEqual([]);
		expect(transport.dials).toEqual([]);
		expect(admission.requests).toEqual([]);
	});

	it("accepts the explicit default port 443 and a Unicode host by its punycode name", async () => {
		const host = new URL("https://bücher.example/").hostname;
		const { service, transport } = harness({
			dns: { [host]: [PUBLIC_IPV4] },
			respond: () => plain("ok"),
		});
		const result = await service.fetchPublic("user-1", "https://bücher.example:443/page");
		expect(transport.resolved).toEqual([host]);
		expect(result.url).toBe(`https://${host}/page`);
	});

	it("uses the concrete transport by default and still refuses a literal before dialing", async () => {
		const service = createPublicFetchService({ admission: grantedAdmission() });
		await expect(service.fetchPublic("user-1", "https://127.0.0.1/")).rejects.toThrow(/non-public address literal/);
	});
});

describe("public fetch vets every DNS answer before choosing an address", () => {
	it.each([
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.169.254",
		"172.16.0.1",
		"192.0.0.1",
		"192.0.2.1",
		"192.88.99.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"0.0.0.0",
	])("refuses a name whose only answer is the non-global IPv4 %s", async (address) => {
		const { service, transport } = harness({
			dns: { "internal.example.com": [address] },
			respond: () => plain("x"),
		});
		await expect(service.fetchPublic("user-1", "https://internal.example.com/")).rejects.toThrow(
			/non-public address/,
		);
		expect(transport.dials).toEqual([]);
	});

	it.each([
		"::1",
		"::",
		"fe80::1",
		"fc00::1",
		"fd12:3456::1",
		"ff02::1",
		"::ffff:93.184.216.34",
		"64:ff9b::1",
		"100::1",
		"2001::1",
		"2001:db8::1",
		"2002:5db8:d822::1",
		"3fff::1",
	])("refuses a name whose only answer is the non-global IPv6 %s", async (address) => {
		const { service, transport } = harness({
			dns: { "v6.example.com": [address] },
			respond: () => plain("x"),
		});
		await expect(service.fetchPublic("user-1", "https://v6.example.com/")).rejects.toThrow(/non-public address/);
		expect(transport.dials).toEqual([]);
	});

	it("refuses the whole answer when a private address is mixed with a public one", async () => {
		const { service, transport } = harness({
			dns: { "mixed.example.com": [PUBLIC_IPV4, "10.0.0.9"] },
			respond: () => plain("x"),
		});
		await expect(service.fetchPublic("user-1", "https://mixed.example.com/")).rejects.toThrow(/non-public address/);
		expect(transport.dials).toEqual([]);
	});

	it("refuses a mixed answer even when the private address comes first", async () => {
		const { service, transport } = harness({
			dns: { "mixed.example.com": ["10.0.0.9", PUBLIC_IPV4] },
			respond: () => plain("x"),
		});
		await expect(service.fetchPublic("user-1", "https://mixed.example.com/")).rejects.toThrow(/non-public address/);
		expect(transport.dials).toEqual([]);
	});

	it("dials the first validated address and names the original host", async () => {
		const { service, transport } = harness({
			dns: { "example.com": [PUBLIC_IPV4, PUBLIC_IPV6] },
			respond: () => plain("ok"),
		});
		await service.fetchPublic("user-1", "https://example.com/docs/page?id=7");
		expect(transport.dials).toEqual([{ url: "https://example.com/docs/page?id=7", address: PUBLIC_IPV4 }]);
	});

	it("accepts a public IPv6 answer", async () => {
		const { service, transport } = harness({
			dns: { "v6.example.com": [PUBLIC_IPV6] },
			respond: () => plain("ok"),
		});
		const result = await service.fetchPublic("user-1", "https://v6.example.com/");
		expect(result.text).toBe("ok");
		expect(transport.dials[0]?.address).toBe(PUBLIC_IPV6);
	});

	it("refuses a name that has no address at all", async () => {
		const { service, transport } = harness({ dns: {}, respond: () => plain("x") });
		await expect(service.fetchPublic("user-1", "https://nowhere.example.com/")).rejects.toThrow(/no address/);
		expect(transport.dials).toEqual([]);
	});
});

describe("public fetch follows at most three redirects and vets each hop", () => {
	it.each([301, 302, 303, 307, 308])("follows a %s redirect with a relative Location", async (status) => {
		const { service, transport } = harness({
			respond: (url) => (url.pathname === "/" ? redirect(status, "/final") : plain("done")),
		});
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.url).toBe("https://example.com/final");
		expect(result.text).toBe("done");
		expect(transport.dials.map((dial) => dial.url)).toEqual(["https://example.com/", "https://example.com/final"]);
	});

	it("follows three redirects and returns the fourth hop", async () => {
		const { service, transport } = harness({
			respond: (url) => {
				if (url.pathname === "/1") return redirect(302, "https://example.com/2");
				if (url.pathname === "/2") return redirect(302, "https://example.com/3");
				if (url.pathname === "/3") return redirect(302, "https://example.com/final");
				return plain("end");
			},
		});
		const result = await service.fetchPublic("user-1", "https://example.com/1");
		expect(result.url).toBe("https://example.com/final");
		expect(transport.dials).toHaveLength(4);
	});

	it("refuses a fourth redirect and sends no fifth request", async () => {
		const { service, transport } = harness({
			respond: (url) => redirect(302, `https://example.com/${Number(url.pathname.slice(1)) + 1}`),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/1")).rejects.toThrow(/after 3 redirects/);
		expect(transport.dials.map((dial) => dial.url)).toEqual([
			"https://example.com/1",
			"https://example.com/2",
			"https://example.com/3",
			"https://example.com/4",
		]);
	});

	it("refuses a redirect into a name that resolves to a loopback address", async () => {
		const { service, transport } = harness({
			dns: { "example.com": [PUBLIC_IPV4], "evil.example": ["127.0.0.1"] },
			respond: () => redirect(302, "https://evil.example/admin"),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/non-public address/);
		expect(transport.resolved).toEqual(["example.com", "evil.example"]);
		expect(transport.dials.map((dial) => dial.url)).toEqual(["https://example.com/"]);
	});

	it("refuses a redirect into a literal private address before any DNS query", async () => {
		const { service, transport } = harness({
			respond: () => redirect(301, "https://10.1.2.3/"),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/non-public address literal/);
		expect(transport.resolved).toEqual(["example.com"]);
		expect(transport.dials).toHaveLength(1);
	});

	it("refuses a redirect to an http URL", async () => {
		const { service, transport } = harness({
			respond: () => redirect(302, "http://example.com/plain"),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/only https/);
		expect(transport.dials).toHaveLength(1);
	});

	it("refuses a redirect that has no Location header", async () => {
		const { service } = harness({ respond: () => reply(null, { status: 302 }) });
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/Location/);
	});

	it("does not follow a 300 response", async () => {
		const { service, transport } = harness({
			respond: () => redirect(300, "https://example.com/elsewhere"),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/HTTP status 300/);
		expect(transport.dials).toHaveLength(1);
	});

	it("cancels the body of an intermediate redirect", async () => {
		const cancelled = Promise.withResolvers<void>();
		const redirectBody = new ReadableStream<Uint8Array>({
			pull: () => Promise.withResolvers<void>().promise,
			cancel: () => cancelled.resolve(),
		});
		const { service } = harness({
			respond: (url) =>
				url.pathname === "/" ? reply(redirectBody, { status: 302, headers: { location: "/final" } }) : plain("ok"),
		});
		await service.fetchPublic("user-1", "https://example.com/");
		await cancelled.promise;
	});
});

describe("public fetch accepts only the allowed media types and charsets", () => {
	it("extracts readable HTML text and removes script, style and template", async () => {
		const body =
			"<html><head><title>T</title></head><body><script>alert(1)</script><style>p{}</style>" +
			"<template><p>hidden</p></template><p>Visible &amp; <b>bold</b></p></body></html>";
		const { service } = harness({ respond: () => html(body) });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toBe("Visible & bold");
		expect(result.contentType).toBe("text/html");
		expect(result.truncated).toBe(false);
	});

	it("keeps line breaks between block elements", async () => {
		const { service } = harness({ respond: () => html("<p>First</p><p>Second</p>") });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toBe("First\nSecond");
	});

	it("returns plain text unchanged with its source URL and media type", async () => {
		const { service } = harness({ respond: () => plain("line one\nline two") });
		const result = await service.fetchPublic("user-1", "https://example.com/docs/page?id=7");
		expect(result).toEqual({
			url: "https://example.com/docs/page?id=7",
			contentType: "text/plain",
			text: "line one\nline two",
			truncated: false,
		});
	});

	it("returns JSON text unchanged", async () => {
		const { service } = harness({
			respond: () => reply('{"ok":true}', { headers: { "content-type": "application/json" } }),
		});
		const result = await service.fetchPublic("user-1", "https://example.com/api");
		expect(result.contentType).toBe("application/json");
		expect(result.text).toBe('{"ok":true}');
	});

	it.each(["application/rss+xml", "application/atom+xml"])("accepts %s feeds as text", async (type) => {
		const { service } = harness({
			respond: () => reply("<feed></feed>", { headers: { "content-type": type } }),
		});
		const result = await service.fetchPublic("user-1", "https://example.com/feed");
		expect(result.contentType).toBe(type);
		expect(result.text).toBe("<feed></feed>");
	});

	it('accepts a quoted UTF-8 charset in any letter case', async () => {
		const { service } = harness({
			respond: () => reply("hi", { headers: { "content-type": 'text/plain; charset="UTF-8"' } }),
		});
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toBe("hi");
	});

	it.each([
		["image/png", /content type image\/png/],
		["application/octet-stream", /content type application\/octet-stream/],
		["application/pdf", /content type application\/pdf/],
		["application/xhtml+xml", /content type application\/xhtml\+xml/],
		["text/csv", /content type text\/csv/],
	])("refuses a binary or unlisted media type %s before reading the body", async (type, pattern) => {
		const { service } = harness({
			respond: () => reply(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": type } }),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/file")).rejects.toThrow(pattern);
	});

	it("refuses a response with no Content-Type", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("bare"));
				controller.close();
			},
		});
		const { service } = harness({ respond: () => reply(stream) });
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/Content-Type/);
	});

	it("refuses a charset it cannot decode", async () => {
		const { service } = harness({
			respond: () => reply("caf\xe9", { headers: { "content-type": "text/plain; charset=iso-8859-1" } }),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/charset iso-8859-1/);
	});

	it("refuses a compressed body", async () => {
		const { service } = harness({
			respond: () =>
				reply("zipped", {
					headers: { "content-type": "text/plain", "content-encoding": "gzip" },
				}),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/content-encoding gzip/);
	});

	it("refuses a non-2xx response", async () => {
		const { service } = harness({
			respond: () => reply("missing", { status: 404, headers: { "content-type": "text/plain" } }),
		});
		await expect(service.fetchPublic("user-1", "https://example.com/gone")).rejects.toThrow(/HTTP status 404/);
	});

	it("keeps Unicode text intact without replacement characters", async () => {
		const { service } = harness({ respond: () => html("<p>Grüße, 日本語 😀</p>") });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toBe("Grüße, 日本語 😀");
		expect(result.text).not.toContain("\uFFFD");
	});
});

describe("public fetch caps the body it reads and the text it returns", () => {
	it("stops reading an endless body at the 2 MiB cap and reports truncation", async () => {
		let pulled = 0;
		const endless = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulled += CHUNK;
					controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
				},
			},
			{ highWaterMark: 0 },
		);
		const { service } = harness({
			respond: () => reply(endless, { headers: { "content-type": "text/plain" } }),
		});
		const result = await service.fetchPublic("user-1", "https://example.com/endless");
		expect(result.truncated).toBe(true);
		expect(result.text).toHaveLength(OUTPUT_LIMIT);
		expect(pulled).toBeLessThanOrEqual(2 * MIB + 4 * CHUNK);
	});

	it("does not return text that sits beyond the 2 MiB read cap", async () => {
		const padded = `<p>start</p><!--${" ".repeat(2 * MIB)}--><p>MARKER</p>`;
		const { service } = harness({ respond: () => html(padded) });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toContain("start");
		expect(result.text).not.toContain("MARKER");
		expect(result.truncated).toBe(true);
	});

	it("cuts ASCII text at exactly 256 KiB and reports truncation", async () => {
		const { service } = harness({ respond: () => plain("a".repeat(300 * 1024)) });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toBe("a".repeat(OUTPUT_LIMIT));
		expect(result.truncated).toBe(true);
	});

	it("returns text of exactly the limit without a truncation flag", async () => {
		const { service } = harness({ respond: () => plain("a".repeat(OUTPUT_LIMIT)) });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toHaveLength(OUTPUT_LIMIT);
		expect(result.truncated).toBe(false);
	});

	it("does not split a three-byte character at the output cap", async () => {
		const { service } = harness({ respond: () => plain("€".repeat(100_000)) });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		// 87381 characters take 262143 bytes; the next one would need 262146 bytes.
		expect(result.text).toBe("€".repeat(87_381));
		expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(OUTPUT_LIMIT);
		expect(result.truncated).toBe(true);
	});

	it("keeps a four-byte character that ends exactly at the output cap", async () => {
		const { service } = harness({ respond: () => plain("😀".repeat(70_000)) });
		const result = await service.fetchPublic("user-1", "https://example.com/");
		expect(result.text).toBe("😀".repeat(65_536));
		expect(result.text).not.toContain("\uFFFD");
		expect(result.truncated).toBe(true);
	});
});

describe("public fetch settles within its deadline whatever its dependencies do", () => {
	it("rejects a dial that never settles, even though it ignores the abort signal", async () => {
		const { service } = harness({
			respond: () => Promise.withResolvers<Response>().promise,
			timeoutMs: 50,
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/50 ms deadline/);
	});

	it("rejects a body that stops producing bytes", async () => {
		const stalled = new ReadableStream<Uint8Array>({ pull: () => Promise.withResolvers<void>().promise });
		const { service } = harness({
			respond: () => reply(stalled, { headers: { "content-type": "text/plain" } }),
			timeoutMs: 50,
		});
		await expect(service.fetchPublic("user-1", "https://example.com/")).rejects.toThrow(/deadline/);
	});

	it.each([0, -1, 15_001, Number.NaN])("refuses a configured timeout of %s at creation", (timeoutMs) => {
		expect(() =>
			createPublicFetchService({ admission: grantedAdmission(), timeoutMs, transport: new FakeTransport({}, () => plain("x")) }),
		).toThrow(/timeout must be above 0 and at most 15000/);
	});
});
