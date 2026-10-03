import { describe, expect, test } from "bun:test";
import { attachMuseCodeApiKey, parseMuseCodeCredential } from "../src/registry/oauth/muse-code";
import { getProviderDefinition } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

function museLoginFetch(): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/oidc/device/authorization/")) {
				return Response.json({
					device_code: "device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.meta.com/device",
					expires_in: 600,
					interval: 0.001,
				});
			}
			if (url.endsWith("/oidc/device/token/")) {
				return Response.json({
					access_token: "meta-account-access",
					refresh_token: "meta-refresh",
					expires_in: 3600,
				});
			}
			if (url.endsWith("/muse-code/key")) {
				return Response.json({
					api_key: "LLM|subscription-key",
					user_email: "Muse@Example.com",
					user_id: "meta-account-1",
					is_subs_active: true,
				});
			}
			throw new Error(`unexpected URL: ${url}`);
		},
		{ preconnect: fetch.preconnect },
	);
}

describe("Muse Code OAuth", () => {
	test("signs in through Meta device authorization and stores an isolated subscription credential", async () => {
		const provider = getProviderDefinition("muse-code");
		if (!provider?.login) throw new Error("Muse Code login is not registered");
		let authUrl = "";
		let instructions = "";
		const credentials = await provider.login({
			fetch: museLoginFetch(),
			onAuth: info => {
				authUrl = info.url;
				instructions = info.instructions ?? "";
			},
			onPrompt: async () => "",
		});
		if (typeof credentials === "string") throw new Error("expected OAuth credentials");

		expect(authUrl).toBe("https://auth.meta.com/device");
		expect(instructions).toContain("ABCD-EFGH");
		expect(credentials).toMatchObject({
			refresh: "meta-refresh",
			accountId: "meta-account-1",
			email: "muse@example.com",
		});
		expect(parseMuseCodeCredential(credentials.access)).toEqual({
			oauthAccessToken: "meta-account-access",
			apiKey: "LLM|subscription-key",
		});
	});

	test("retains the minted key when refresh succeeds but the key endpoint is transiently unavailable", async () => {
		const storedAccess = JSON.stringify({ oauthAccessToken: "old-account-access", apiKey: "LLM|existing-key" });
		const refreshed = await attachMuseCodeApiKey(
			{ access: "new-account-access", refresh: "rotated-refresh", expires: Date.now() + 3_600_000 },
			{
				phase: "refresh",
				fetch: Object.assign(() => Promise.resolve(Response.json({ error: "temporary" }, { status: 503 })), {
					preconnect: fetch.preconnect,
				}),
				stored: {
					access: storedAccess,
					refresh: "old-refresh",
					expires: 0,
					accountId: "meta-account-1",
					email: "muse@example.com",
				},
			},
		);

		expect(parseMuseCodeCredential(refreshed.access)).toEqual({
			oauthAccessToken: "new-account-access",
			apiKey: "LLM|existing-key",
		});
		expect(refreshed).toMatchObject({ accountId: "meta-account-1", email: "muse@example.com" });
	});

	test("rejects an inactive subscription instead of exposing a Model API credential", async () => {
		await expect(
			attachMuseCodeApiKey(
				{ access: "meta-account-access", refresh: "meta-refresh", expires: Date.now() + 3_600_000 },
				{
					phase: "login",
					fetch: Object.assign(() => Promise.resolve(Response.json({ is_subs_active: false }, { status: 200 })), {
						preconnect: fetch.preconnect,
					}),
				},
			),
		).rejects.toMatchObject({ provider: "muse-code", status: 403 });
	});
});
