import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginTogether = createApiKeyLogin({
	providerLabel: "Together",
	authUrl: "https://api.together.xyz/settings/api-keys",
	instructions: "Copy your API key from the Together dashboard",
	promptMessage: "Paste your Together API key",
	placeholder: "sk-...",
	validation: {
		// Validate against the authenticated models listing, not a chat completion: Together answers a
		// model served only from a dedicated endpoint (e.g. `moonshotai/Kimi-K2.5`) with HTTP 400
		// `model_not_available`, which failed validation for every valid key. `/v1/models` names no model.
		kind: "models-endpoint",
		provider: "together",
		modelsUrl: "https://api.together.xyz/v1/models",
	},
});

export const togetherProvider = {
	id: "together",
	name: "Together",
	login: (cb: Parameters<typeof loginTogether>[0]) => loginTogether(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
