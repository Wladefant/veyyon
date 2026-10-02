import { describe, expect, it } from "bun:test";
import { exchangeCodeForToken, loginOpenAICodexDevice } from "@veyyon/ai/registry/oauth/openai-codex";

function makeJwt(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.sig`;
}

describe("OpenAI Codex OAuth identity extraction", () => {
	it("accepts tokens with email even when accountId is absent", async () => {
		const token = makeJwt({
			"https://api.openai.com/profile": { email: "user@example.com" },
		});

		const fetchMock = async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes("/oauth/token")) {
				return new Response(
					JSON.stringify({
						access_token: token,
						refresh_token: "refresh-token-123",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected request to ${u}`);
		};

		const creds = await exchangeCodeForToken(
			"code-123",
			"verifier-123",
			"https://redirect.example",
			fetchMock as unknown as typeof fetch,
		);
		expect(creds.email).toBe("user@example.com");
		expect(creds.accountId).toBeUndefined();
		expect(creds.orgId).toBeUndefined();
		expect(creds.access).toBe(token);
		expect(creds.refresh).toBe("refresh-token-123");
	});

	it("preserves accountId and orgId when present in token", async () => {
		const token = makeJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-999" },
			"https://api.openai.com/profile": { email: "user@example.com" },
		});

		const fetchMock = async () =>
			new Response(
				JSON.stringify({
					access_token: token,
					refresh_token: "refresh-token-123",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const creds = await exchangeCodeForToken(
			"code-123",
			"verifier-123",
			"https://redirect.example",
			fetchMock as unknown as typeof fetch,
		);
		expect(creds.email).toBe("user@example.com");
		expect(creds.accountId).toBe("acct-999");
		expect(creds.orgId).toBe("acct-999");
	});

	it("rejects tokens that lack both accountId and email", async () => {
		const token = makeJwt({});

		const fetchMock = async () =>
			new Response(
				JSON.stringify({
					access_token: token,
					refresh_token: "refresh-token-123",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		expect(
			exchangeCodeForToken(
				"code-123",
				"verifier-123",
				"https://redirect.example",
				fetchMock as unknown as typeof fetch,
			),
		).rejects.toThrow("Failed to extract account identity from token");
	});

	it("completes device login when token has email but no accountId", async () => {
		const token = makeJwt({
			"https://api.openai.com/profile": { email: "device-user@example.com" },
		});

		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input: string | URL | Request) => {
			const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (u.includes("/deviceauth/usercode")) {
				return new Response(
					JSON.stringify({
						device_auth_id: "dev-123",
						user_code: "ABCD-1234",
						interval: 1,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (u.includes("/deviceauth/token")) {
				return new Response(
					JSON.stringify({
						authorization_code: "auth-code-789",
						code_verifier: "verifier-789",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (u.includes("/oauth/token")) {
				return new Response(
					JSON.stringify({
						access_token: token,
						refresh_token: "dev-refresh-456",
						expires_in: 3600,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected device fetch to ${u}`);
		}) as typeof fetch;

		try {
			let receivedPrompt = false;
			const creds = await loginOpenAICodexDevice({
				onAuth: info => {
					receivedPrompt = true;
					expect(info.url).toContain("https://auth.openai.com/codex/device");
				},
			});

			expect(receivedPrompt).toBe(true);
			expect(creds.email).toBe("device-user@example.com");
			expect(creds.accountId).toBeUndefined();
			expect(creds.access).toBe(token);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
