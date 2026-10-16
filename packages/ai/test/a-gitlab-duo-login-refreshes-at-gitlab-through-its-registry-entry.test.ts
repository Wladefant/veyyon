/**
 * WHY THIS EXISTS. The GitLab Duo registry entry is what the auth broker calls to renew a stored login;
 * it reaches the OAuth module through a lazy import so the eager registry graph stays small. A wrong
 * import path, a renamed export, or an entry that dropped the signal fails only when a token expires,
 * which is long after the change that broke it.
 *
 * This drives `gitlabDuoProvider.refreshToken` itself and observes the request it makes and the
 * credential it returns: the refresh grant goes to the SaaS instance's `/oauth/token`, carries the
 * stored refresh token, and the response becomes the new credential.
 *
 * WHAT IT DOES NOT CATCH. The interactive `login` path, which needs a browser callback, and a
 * self-managed GitLab instance, which this entry does not address.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { gitlabDuoProvider } from "@veyyon/ai/registry/gitlab-duo";
import { GITLAB_SAAS_URL } from "@veyyon/catalog/provider-endpoints";

let savedClientId: string | undefined;

beforeEach(() => {
	savedClientId = process.env.GITLAB_CLIENT_ID;
	process.env.GITLAB_CLIENT_ID = "registry-client";
});

afterEach(() => {
	if (savedClientId === undefined) delete process.env.GITLAB_CLIENT_ID;
	else process.env.GITLAB_CLIENT_ID = savedClientId;
});

describe("the GitLab Duo registry entry", () => {
	it("trades the stored refresh token at the SaaS token endpoint and returns the new credential", async () => {
		const requests: Array<{ url: string; body: URLSearchParams; signal: AbortSignal | null | undefined }> = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			requests.push({ url: String(input), body: new URLSearchParams(String(init?.body)), signal: init?.signal });
			return new Response(
				JSON.stringify({
					access_token: "fresh-access",
					refresh_token: "fresh-refresh",
					expires_in: 7200,
					created_at: 1_700_000_000,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof globalThis.fetch);
		const controller = new AbortController();

		try {
			const renewed = await gitlabDuoProvider.refreshToken(
				{ access: "stale-access", refresh: "stored-refresh", expires: 0 },
				controller.signal,
			);

			expect(requests).toHaveLength(1);
			expect(requests[0].url).toBe(`${GITLAB_SAAS_URL}/oauth/token`);
			expect(requests[0].url).toBe("https://gitlab.com/oauth/token");
			expect(requests[0].body.get("grant_type")).toBe("refresh_token");
			expect(requests[0].body.get("refresh_token")).toBe("stored-refresh");
			expect(requests[0].body.get("client_id")).toBe("registry-client");
			expect(requests[0].signal).toBe(controller.signal);
			expect(renewed.access).toBe("fresh-access");
			expect(renewed.refresh).toBe("fresh-refresh");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("rejects with the provider's status when GitLab refuses the refresh", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				})) as typeof globalThis.fetch,
		);

		try {
			await expect(
				gitlabDuoProvider.refreshToken({ access: "stale-access", refresh: "revoked-refresh", expires: 0 }),
			).rejects.toThrow(/GitLab OAuth refresh failed: 400/);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
