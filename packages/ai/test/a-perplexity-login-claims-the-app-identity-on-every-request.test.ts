/**
 * The email-OTP login sends the macOS app identity on every request it makes.
 *
 * The session JWT this flow mints is later spent by the search provider, which claims the same app
 * User-Agent and API version. A login request that omits the pair, or claims a different version,
 * mints a session the ask endpoint treats as a different client: it answers 200 with the anonymous
 * free model, so the drift shows up as worse answers rather than as an error. This drives the real
 * flow through a recording `fetch` and checks each request's URL and headers against the catalog
 * owner of the identity.
 *
 * Not caught: a request added to the flow that this fake answers with a 404, since the flow then
 * fails before reaching the assertion; the test fails in that case, but for the status, not for the
 * missing headers.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { loginPerplexity } from "@veyyon/ai/registry/oauth/perplexity";
import type { OAuthController } from "@veyyon/ai/registry/oauth/types";
import {
	PERPLEXITY_HEADERS,
	PERPLEXITY_NATIVE_APP_API_VERSION,
	PERPLEXITY_NATIVE_APP_USER_AGENT,
	PERPLEXITY_WEB_ORIGIN,
} from "@veyyon/catalog/wire/perplexity";

interface RecordedRequest {
	url: string;
	headers: Headers;
}

const SAVED_NO_BORROW = process.env.VEYYON_AUTH_NO_BORROW;

afterEach(() => {
	vi.restoreAllMocks();
	if (SAVED_NO_BORROW === undefined) delete process.env.VEYYON_AUTH_NO_BORROW;
	else process.env.VEYYON_AUTH_NO_BORROW = SAVED_NO_BORROW;
});

/** Answers the three OTP endpoints the way Perplexity does and records each request. */
function recordLoginRequests(): RecordedRequest[] {
	const requests: RecordedRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		requests.push({ url, headers: new Headers(init?.headers) });
		const path = new URL(url).pathname;
		if (path === "/api/auth/csrf") return Response.json({ csrfToken: "csrf-fixture" });
		if (path === "/api/auth/signin-email") return Response.json({ status: "sent" });
		if (path === "/api/auth/signin-otp") return Response.json({ token: "session-jwt-fixture" });
		return new Response("not found", { status: 404 });
	}) as typeof fetch);
	return requests;
}

describe("the Perplexity email login", () => {
	it("sends the app User-Agent and API version on the csrf, email and code requests", async () => {
		// The native-app shortcut reads a token from macOS defaults; turning it off makes the OTP flow run on every host.
		process.env.VEYYON_AUTH_NO_BORROW = "1";
		const requests = recordLoginRequests();
		const answers = ["someone@example.com", "123456"];
		const ctrl: OAuthController = { onPrompt: async () => answers.shift() ?? "" };

		const credentials = await loginPerplexity(ctrl);

		expect(credentials.access).toBe("session-jwt-fixture");
		expect(requests.map(request => request.url)).toEqual([
			`${PERPLEXITY_WEB_ORIGIN}/api/auth/csrf`,
			`${PERPLEXITY_WEB_ORIGIN}/api/auth/signin-email`,
			`${PERPLEXITY_WEB_ORIGIN}/api/auth/signin-otp`,
		]);
		for (const request of requests) {
			expect(request.headers.get("user-agent"), request.url).toBe(PERPLEXITY_NATIVE_APP_USER_AGENT);
			expect(request.headers.get(PERPLEXITY_HEADERS.API_VERSION), request.url).toBe(
				PERPLEXITY_NATIVE_APP_API_VERSION,
			);
		}
	});
});
