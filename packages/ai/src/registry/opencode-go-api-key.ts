import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

/**
 * OpenCode Go, reached with an API key instead of the OpenCode Console login.
 *
 * A provider entry describes one login mechanism, and OpenCode Go offers two: the Console device flow in
 * `opencode-go`, and a key pasted from the OpenCode site. `storeCredentialsAs` files the key under
 * `opencode-go`, the id the model manager, the account card and the model list read.
 */
export const loginOpenCodeGoApiKey = createApiKeyLogin({
	providerLabel: "OpenCode Go",
	authUrl: "https://opencode.ai/auth",
	instructions: "Log in and copy your API key",
	promptMessage: "Paste your OpenCode Go API key",
	placeholder: "sk-...",
	validation: null,
});

export const opencodeGoApiKeyProvider = {
	id: "opencode-go-api-key",
	name: "OpenCode Go (API key, legacy)",
	login: loginOpenCodeGoApiKey,
	credential: "api-key",
	storeCredentialsAs: "opencode-go",
	loginMethod: "API key (legacy)",
} as const satisfies ProviderDefinition;
