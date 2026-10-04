import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	configureGitHubCopilotOAuthClientId,
	GITHUB_COPILOT_CLIENT_ID_ENV,
	GITHUB_COPILOT_CLIENT_ID_MISSING_MESSAGE,
	resolveGitHubCopilotOAuthClientId,
} from "@veyyon/ai/github-copilot-client-id";
import { loginGitHubCopilot, refreshGitHubCopilotToken } from "@veyyon/ai/registry/oauth/github-copilot";
import { COPILOT_USER_AGENT } from "@veyyon/catalog/wire/github-copilot";

describe("GitHub Copilot OAuth client ID", () => {
	let savedEnv: string | undefined;
	beforeEach(() => {
		savedEnv = process.env[GITHUB_COPILOT_CLIENT_ID_ENV];
		delete process.env[GITHUB_COPILOT_CLIENT_ID_ENV];
		configureGitHubCopilotOAuthClientId(undefined);
	});
	afterEach(() => {
		if (savedEnv === undefined) delete process.env[GITHUB_COPILOT_CLIENT_ID_ENV];
		else process.env[GITHUB_COPILOT_CLIENT_ID_ENV] = savedEnv;
		configureGitHubCopilotOAuthClientId(undefined);
	});

	it("ships no default client ID", () => {
		expect(resolveGitHubCopilotOAuthClientId()).toBeUndefined();
	});

	it("environment wins over the setting; blank values clear it", () => {
		configureGitHubCopilotOAuthClientId("  from-setting ");
		expect(resolveGitHubCopilotOAuthClientId()).toBe("from-setting");
		process.env[GITHUB_COPILOT_CLIENT_ID_ENV] = "from-env";
		expect(resolveGitHubCopilotOAuthClientId()).toBe("from-env");
		delete process.env[GITHUB_COPILOT_CLIENT_ID_ENV];
		configureGitHubCopilotOAuthClientId("   ");
		expect(resolveGitHubCopilotOAuthClientId()).toBeUndefined();
	});

	it("login fails with registration instructions and never prompts or touches the network", async () => {
		let prompted = false;
		let fetched = false;
		const failure = await loginGitHubCopilot({
			onAuth: () => {},
			onPrompt: async () => {
				prompted = true;
				return "";
			},
			fetch: (async () => {
				fetched = true;
				return new Response("{}");
			}) as unknown as typeof fetch,
		}).then(
			() => undefined,
			(error: unknown) => error as Error,
		);
		expect(failure?.message).toBe(GITHUB_COPILOT_CLIENT_ID_MISSING_MESSAGE);
		expect(failure?.message).toContain("https://github.com/settings/developers");
		expect(failure?.message).toContain(GITHUB_COPILOT_CLIENT_ID_ENV);
		expect(prompted).toBe(false);
		expect(fetched).toBe(false);
	});

	it("device flow uses the configured ID and the honest User-Agent", async () => {
		configureGitHubCopilotOAuthClientId("my-app-id");
		const seen: { url: string; body: string; ua: string | null }[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({
				url: String(input),
				body: String(init?.body ?? ""),
				ua: new Headers(init?.headers).get("User-Agent"),
			});
			throw new Error("stop after first request");
		}) as unknown as typeof fetch;
		await loginGitHubCopilot({ onAuth: () => {}, onPrompt: async () => "", fetch: fetchImpl }).catch(() => {});
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0].body).toContain("my-app-id");
		expect(seen[0].ua).toBe(COPILOT_USER_AGENT);
	});

	it("refresh of a stored login works with no client ID configured", async () => {
		const credentials = await refreshGitHubCopilotToken("stored-github-token");
		expect(credentials.access).toBe("stored-github-token");
		expect(credentials.refresh).toBe("stored-github-token");
	});
});
