import { describe, expect, it } from "bun:test";
import {
	mirrorRequestAbort,
	normalizeClientSessionKey,
	resolveGatewayAccount,
	resolveGatewayApiKey,
} from "../src/auth-gateway/dispatch";
import type { AuthStorage } from "../src/auth-storage";
import type { Api, Model } from "../src/types";

describe("auth-gateway dispatch core", () => {
	it("normalizes client session keys", () => {
		expect(normalizeClientSessionKey(undefined)).toBeUndefined();
		expect(normalizeClientSessionKey("")).toBeUndefined();
		expect(normalizeClientSessionKey("   ")).toBeUndefined();
		expect(normalizeClientSessionKey("session-1")).toBe("session-1");
		expect(normalizeClientSessionKey("  session-2  ")).toBe("  session-2  ");
	});

	it("resolves gateway account from oauth identity or api key hash", () => {
		const storageWithOAuth = {
			getOAuthAccountIdentity: () => ({
				accountId: "acc-1",
				email: "dev@example.com",
				projectId: "proj-1",
				orgId: "org-1",
			}),
		} as unknown as AuthStorage;

		const oauthAccount = resolveGatewayAccount(storageWithOAuth, "openai", "sess", "raw-key");
		expect(oauthAccount).toContain("oauth:");
		expect(oauthAccount).toContain("dev@example.com");

		const storageWithoutOAuth = {
			getOAuthAccountIdentity: () => undefined,
		} as unknown as AuthStorage;

		const keyAccount = resolveGatewayAccount(storageWithoutOAuth, "openai", "sess", "raw-key");
		expect(keyAccount.startsWith("key:")).toBe(true);
	});

	it("returns 401 classification when no api key is available", async () => {
		const storage = {
			getApiKey: async () => undefined,
		} as unknown as AuthStorage;
		const model = { provider: "openai", id: "gpt-5" } as Model<Api>;

		const result = await resolveGatewayApiKey(storage, model, "sess", new AbortController().signal, "127.0.0.1");
		expect(typeof result).toBe("object");
		if (typeof result === "object") {
			expect(result.status).toBe(401);
			expect(result.type).toBe("authentication_error");
		}
	});

	it("returns resolved api key when available", async () => {
		const storage = {
			getApiKey: async () => "sk-test-key",
		} as unknown as AuthStorage;
		const model = { provider: "openai", id: "gpt-5" } as Model<Api>;

		const result = await resolveGatewayApiKey(storage, model, "sess", new AbortController().signal, "127.0.0.1");
		expect(result).toBe("sk-test-key");
	});

	it("mirrors request abort onto internal controller", () => {
		const reqController = new AbortController();
		const req = new Request("http://localhost", { signal: reqController.signal });

		const mirrored = mirrorRequestAbort(req);
		expect(mirrored.signal.aborted).toBe(false);

		reqController.abort("cancelled");
		expect(mirrored.signal.aborted).toBe(true);
		expect(mirrored.signal.reason).toBe("cancelled");
	});
});
