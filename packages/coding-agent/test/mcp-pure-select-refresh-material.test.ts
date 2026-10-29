/**
 * selectMcpOAuthRefreshMaterial prefers credential with tokenUrl; resolveMcpOAuthRefreshTarget derives the
 * endpoint, client and resource indicator a refresh is sent with and stored with from that material. The
 * refresh request and the merge of its result both read the target, so a server URL standing in for an
 * unstated resource is sent and never persisted as if it had been stated.
 */
import { describe, expect, it } from "bun:test";
import { resolveMcpOAuthRefreshTarget, selectMcpOAuthRefreshMaterial } from "../src/mcp/oauth-credentials";
import type { MCPStoredOAuthCredential } from "../src/mcp/oauth-flow";
import type { MCPServerConfig } from "../src/mcp/types";

describe("selectMcpOAuthRefreshMaterial", () => {
	it("prefers credential when tokenUrl present", () => {
		const cred = { type: "oauth" as const, access: "a", refresh: "r", expires: 0, tokenUrl: "https://t" };
		const auth = { type: "oauth" as const, tokenUrl: "https://other" };
		expect(selectMcpOAuthRefreshMaterial(cred as never, auth)).toBe(cred);
	});

	it("falls back to auth when credential has no tokenUrl", () => {
		const cred = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
		const auth = { type: "oauth" as const, tokenUrl: "https://other" };
		expect(selectMcpOAuthRefreshMaterial(cred as never, auth)).toBe(auth);
	});

	it("undefined auth when no tokenUrl on credential", () => {
		const cred = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
		expect(selectMcpOAuthRefreshMaterial(cred as never, undefined)).toBeUndefined();
	});
});

describe("resolveMcpOAuthRefreshTarget", () => {
	const SERVER_URL = "https://mcp.example.com/mcp";
	const bare: MCPStoredOAuthCredential = { type: "oauth", access: "a", refresh: "r", expires: 0 };

	it("sends the URL of an http or sse server as the resource when none is stated, and marks it a fallback", () => {
		for (const type of ["http", "sse"] as const) {
			const config: MCPServerConfig = {
				type,
				url: SERVER_URL,
				auth: { type: "oauth", tokenUrl: "https://auth.example.com/token", clientId: "cid" },
			};
			expect(resolveMcpOAuthRefreshTarget(bare, config)).toEqual({
				tokenUrl: "https://auth.example.com/token",
				clientId: "cid",
				clientSecret: undefined,
				authorizationUrl: undefined,
				resource: SERVER_URL,
				resourceIsFallback: true,
			});
		}
	});

	it("sends a stated resource as it is and does not mark it a fallback", () => {
		const credential: MCPStoredOAuthCredential = {
			...bare,
			tokenUrl: "https://auth.example.com/token",
			clientSecret: "secret",
			resource: "https://api.example.com",
			authorizationUrl: "https://auth.example.com",
		};
		const config: MCPServerConfig = { type: "http", url: SERVER_URL };
		expect(resolveMcpOAuthRefreshTarget(credential, config)).toEqual({
			tokenUrl: "https://auth.example.com/token",
			clientId: undefined,
			clientSecret: "secret",
			authorizationUrl: "https://auth.example.com",
			resource: "https://api.example.com",
			resourceIsFallback: false,
		});
	});

	it("sends no resource for a stdio server that states none", () => {
		const config: MCPServerConfig = {
			type: "stdio",
			command: "server",
			auth: { type: "oauth", tokenUrl: "https://auth.example.com/token" },
		};
		const target = resolveMcpOAuthRefreshTarget(bare, config);
		expect(target.resource).toBeUndefined();
		expect(target.resourceIsFallback).toBe(false);
	});
});
