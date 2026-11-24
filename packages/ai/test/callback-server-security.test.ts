import { afterEach, describe, expect, it, spyOn } from "bun:test";
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

describe("OAuthCallbackFlow listener exposure", () => {
	it("binds the default callback listener to the IPv4 loopback address only", async () => {
		const abort = new AbortController();
		activeAborts.push(abort);
		const serve = spyOn(Bun, "serve");
		const auth = Promise.withResolvers<OAuthAuthInfo>();
		const flow = new CallbackProbeFlow(
			{ signal: abort.signal, onAuth: info => auth.resolve(info) },
			{ preferredPort: 0 },
		);
		const login = flow.login().catch(() => undefined);
		try {
			await auth.promise;
			expect(serve.mock.calls.map(([options]) => options.hostname)).toEqual(["127.0.0.1"]);
		} finally {
			serve.mockRestore();
			abort.abort("test cleanup");
			await login;
		}
	});

	it.each([
		["an error without state", { error: "access_denied" }],
		["a code with a forged state", { code: "forged-code", state: "forged-state" }],
		["a request without code or state", {}],
	])("does not settle the pending login on %s", async (_label, query) => {
		const { info, abort, login } = await startFlow();
		let settled = false;
		const outcome = login.then(
			() => (settled = true),
			() => (settled = true),
		);
		const authUrl = new URL(info.url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("OAuth test flow did not advertise its callback parameters");

		try {
			const forged = new URL(redirectUri);
			for (const [key, value] of Object.entries(query)) forged.searchParams.set(key, value);
			await fetch(forged);
			expect(settled).toBe(false);

			const valid = new URL(redirectUri);
			valid.searchParams.set("code", "valid-code");
			valid.searchParams.set("state", state);
			const response = await fetch(valid);
			expect(response.status).toBe(200);
			expect((await login).access).toBe("valid-code");
		} finally {
			abort.abort("test cleanup");
			await outcome;
		}
	});
});

describe("OAuthCallbackFlow launch route security", () => {
	it("rejects /launch without a token with a generic 404 and no Location or auth secrets", async () => {
		const { info, abort, login } = await startFlow();
		const loginSettled = login.catch(() => undefined);
		try {
			expect(info.launchUrl).toBeDefined();
			const launchOrigin = new URL(info.launchUrl!).origin;
			const state = new URL(info.url).searchParams.get("state");
			if (!state) throw new Error("OAuth test flow did not advertise a state parameter");

			for (const target of [`${launchOrigin}/launch`, `${launchOrigin}/launch?token=`]) {
				const response = await fetch(target, { redirect: "manual" });
				expect(response.status).toBe(404);
				expect(response.headers.get("location")).toBeNull();
				const body = await response.text();
				expect(body).not.toContain(info.url);
				expect(body).not.toContain("auth.example.test");
				expect(body).not.toContain(state);
			}
		} finally {
			abort.abort("test cleanup");
			await loginSettled;
		}
	});

	it("rejects an incorrect same-length launch token and callback state used as launch token", async () => {
		const { info, abort, login } = await startFlow();
		const loginSettled = login.catch(() => undefined);
		try {
			expect(info.launchUrl).toBeDefined();
			const launchUrl = new URL(info.launchUrl!);
			const token = launchUrl.searchParams.get("token");
			expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);

			const state = new URL(info.url).searchParams.get("state");
			if (!state) throw new Error("OAuth test flow did not advertise a state parameter");
			expect(token).not.toBe(state);

			const wrongToken = (token![0] === "A" ? "B" : "A") + token!.slice(1);
			expect(wrongToken).toHaveLength(token!.length);
			expect(wrongToken).not.toBe(token);

			for (const badToken of [wrongToken, state]) {
				const attempt = new URL(launchUrl.origin);
				attempt.pathname = "/launch";
				attempt.searchParams.set("token", badToken);
				const response = await fetch(attempt, { redirect: "manual" });
				expect(response.status).toBe(404);
				expect(response.headers.get("location")).toBeNull();
				const body = await response.text();
				expect(body).not.toContain(info.url);
				expect(body).not.toContain("auth.example.test");
				expect(body).not.toContain(state);
				expect(body).not.toContain(token!);
			}
		} finally {
			abort.abort("test cleanup");
			await loginSettled;
		}
	});

	it("redirects valid /launch requests with no-store/no-referrer and resolves login via the callback", async () => {
		const { info, abort, login } = await startFlow();
		const loginSettled = login.catch(() => undefined);
		try {
			expect(info.launchUrl).toBeDefined();
			const launchUrl = new URL(info.launchUrl!);
			expect(launchUrl.pathname).toBe("/launch");
			const token = launchUrl.searchParams.get("token");
			expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);

			const state = new URL(info.url).searchParams.get("state");
			if (!state) throw new Error("OAuth test flow did not advertise a state parameter");
			expect(token).not.toBe(state);

			const launchResponse = await fetch(launchUrl, { redirect: "manual" });
			expect(launchResponse.status).toBe(302);
			expect(launchResponse.headers.get("location")).toBe(info.url);
			expect(launchResponse.headers.get("cache-control")).toBe("no-store");
			expect(launchResponse.headers.get("referrer-policy")).toBe("no-referrer");

			const redirectedAuthUrl = new URL(launchResponse.headers.get("location")!);
			const redirectUri = redirectedAuthUrl.searchParams.get("redirect_uri");
			const callbackState = redirectedAuthUrl.searchParams.get("state");
			expect(redirectUri).toBeTruthy();
			expect(callbackState).toBe(state);

			const callbackUrl = new URL(redirectUri!);
			callbackUrl.searchParams.set("code", "launch-flow-code");
			callbackUrl.searchParams.set("state", callbackState!);
			const callbackResponse = await fetch(callbackUrl, { redirect: "manual" });
			expect(callbackResponse.status).toBe(200);

			const credentials = await login;
			expect(credentials.access).toBe("launch-flow-code");
			expect(credentials.refresh).toBe("refresh-token");
		} finally {
			abort.abort("test cleanup");
			await loginSettled;
		}
	});
});
