/**
 * OpenCode Go login flow. Users paste an API key from the OpenCode auth page.
 */
import { createApiKeyLogin } from "../api-key-login";

export const loginOpenCodeGo = createApiKeyLogin({
	providerLabel: "OpenCode Go",
	authUrl: "https://opencode.ai/auth",
	instructions: "Log in and copy your API key",
	promptMessage: "Paste your OpenCode Go API key",
	placeholder: "sk-...",
	validation: null,
});
