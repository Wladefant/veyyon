import { afterEach, describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "@veyyon/ai/registry/oauth/callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "@veyyon/ai/registry/oauth/types";
import { parseHTML } from "linkedom";

class CallbackProbeFlow extends OAuthCallbackFlow {
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url = new URL("https://auth.example.test/authorize");
		url.searchParams.set("state", state);
		url.searchParams.set("redirect_uri", redirectUri);
		return { url: url.toString() };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return {
			access: code,
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
	}
}

const activeAborts: AbortController[] = [];

async function startFlow(): Promise<{
	info: OAuthAuthInfo;
	abort: AbortController;
	login: Promise<OAuthCredentials>;
}> {
	const abort = new AbortController();
	activeAborts.push(abort);
	const auth = Promise.withResolvers<OAuthAuthInfo>();
	const flow = new CallbackProbeFlow(
		{
			signal: abort.signal,
			onAuth: info => auth.resolve(info),
		},
		{
			preferredPort: 0,
			callbackPath: "/callback",
			callbackHostname: "127.0.0.1",
			allowPortFallback: true,
		},
	);
	const login = flow.login();
	const info = await auth.promise;
	return { info, abort, login };
}

afterEach(() => {
	while (activeAborts.length > 0) {
		activeAborts.pop()?.abort("test cleanup");
	}
});

describe("OAuthCallbackFlow callback security", () => {
	it.each([
		["markup", "</ScRiPt><script id=injected>globalThis.callbackInjected=1</script><b>denied & retry</b>"],
		["replacement patterns", "$& $' $" + "` $$"],
	])("preserves %s in provider errors as inert page data without a valid state", async (_label, errorText) => {
		const { info, abort, login } = await startFlow();
		const loginSettled = login.catch(() => undefined);
		const redirectUri = new URL(info.url).searchParams.get("redirect_uri");
		if (!redirectUri) {
			abort.abort("test cleanup");
			await loginSettled;
			throw new Error("OAuth test flow did not advertise its callback URI");
		}

		try {
			const callback = new URL(redirectUri);
			callback.searchParams.set("error", "access_denied");
			callback.searchParams.set("error_description", errorText);
			const response = await fetch(callback);
			expect(response.status).toBe(500);
			const { document } = parseHTML(await response.text());
			expect(document.getElementById("injected")).toBeNull();
			const stateElement = document.getElementById("server-state");
			if (!stateElement) throw new Error("OAuth callback page is missing its state");
			expect(JSON.parse(stateElement.textContent ?? "")).toEqual({
				ok: false,
				error: `Authorization failed: ${errorText}`,
			});
		} finally {
			abort.abort("test cleanup");
			await loginSettled;
		}
	});

	it("preserves callback codes containing markup and replacement patterns", async () => {
		const { info, abort, login } = await startFlow();
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");
		const code = "</ScRiPt><script id=injected>globalThis.callbackInjected=1</script> $& $'";

		try {
			const callback = new URL(redirectUri);
			callback.searchParams.set("code", code);
			callback.searchParams.set("state", state);
			const response = await fetch(callback);
			expect(response.status).toBe(200);
			expect((await login).access).toBe(code);
			const { document } = parseHTML(await response.text());
			expect(document.getElementById("injected")).toBeNull();
			const stateElement = document.getElementById("server-state");
			if (!stateElement) throw new Error("OAuth callback page is missing its state");
			expect(JSON.parse(stateElement.textContent ?? "")).toEqual({ ok: true, code, state });
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});
});
