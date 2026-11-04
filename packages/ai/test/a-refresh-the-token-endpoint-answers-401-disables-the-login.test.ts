/**
 * WHY: a dead Cursor key answers its refresh with `401 {"code":"error","message":"Invalid User API
 * Key"}`. The body carries no OAuth error code and the thrown message carried no status, so
 * `isDefinitiveOAuthFailure` read it as transient: the account was blocked, retried, blocked again,
 * and shown on the account screen as failing to refresh forever instead of as signed out.
 *
 * Class closed: every registered provider that refreshes, refused with a bare 401 whose body names no
 * OAuth code, throws a failure the definitive classifier reads as a dead login; and refused with a
 * 503, throws one it reads as transient. The sweep reads `PROVIDER_REGISTRY` at run time, so a new
 * provider with a refresher is covered by default and turns this suite red until it reports the
 * status.
 *
 * Not caught: a provider whose refresh endpoint answers a dead login with a 2xx or a 400 and no OAuth
 * code. Neither status is a dead-login signal on its own.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { isDefinitiveOAuthFailure } from "@veyyon/ai/error/flags";
import { type OAuthProvider, refreshOAuthToken } from "@veyyon/ai/registry/oauth";
import { PROVIDER_REGISTRY } from "../src/registry/registry";

const CREDENTIALS = {
	access: "access-token",
	refresh: "refresh-token",
	expires: 0,
	projectId: "project",
	accountId: "account",
	email: "someone@example.com",
};

/** Registry ids are plain strings; every entry with a refresher is an OAuth provider by construction. */
const refreshers = PROVIDER_REGISTRY.filter(provider => provider.login && provider.refreshToken).map(
	provider => provider.id as OAuthProvider,
);

/**
 * The refresh failure `provider` throws when every request it makes is answered with `status`, or
 * `undefined` when the refresher completed without making a request at all.
 */
async function refreshFailure(provider: OAuthProvider, status: number, body: string): Promise<string | undefined> {
	let requests = 0;
	const answer = Object.assign(
		async (): Promise<Response> => {
			requests++;
			return new Response(body, { status, headers: { "content-type": "application/json" } });
		},
		{ preconnect: (): void => {} },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(answer);
	try {
		await refreshOAuthToken(provider, CREDENTIALS);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (requests === 0) return undefined;
	throw new Error(`${provider} refresh succeeded against a ${status}`);
}

/**
 * Refreshers that make no request: GitHub Copilot's token is long-lived and its refresh re-stamps
 * the stored token locally. A provider added here needs the same reason.
 */
const LOCAL_REFRESHERS = ["github-copilot"];

describe("a refresh refused by the token endpoint", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("covers every provider that refreshes, Cursor among them", () => {
		expect(refreshers).toContain("cursor");
		expect(refreshers.length).toBeGreaterThan(1);
	});

	it("makes a request for every provider but the ones that refresh locally", async () => {
		const local: string[] = [];
		for (const provider of refreshers) {
			if ((await refreshFailure(provider, 401, "{}")) === undefined) local.push(provider);
		}
		expect(local).toEqual(LOCAL_REFRESHERS);
	});

	it("is definitive on a bare 401 for every provider", async () => {
		const notDefinitive: string[] = [];
		for (const provider of refreshers) {
			const message = await refreshFailure(provider, 401, '{"code":"error","message":"Invalid User API Key"}');
			if (message !== undefined && !isDefinitiveOAuthFailure(message)) notDefinitive.push(`${provider}: ${message}`);
		}
		expect(notDefinitive).toEqual([]);
	});

	it("is transient on a 503 for every provider", async () => {
		const definitive: string[] = [];
		for (const provider of refreshers) {
			const message = await refreshFailure(provider, 503, '{"message":"service unavailable"}');
			if (message !== undefined && isDefinitiveOAuthFailure(message)) definitive.push(`${provider}: ${message}`);
		}
		expect(definitive).toEqual([]);
	});
});
