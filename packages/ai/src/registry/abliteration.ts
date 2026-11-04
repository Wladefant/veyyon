import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginAbliteration = createApiKeyLogin({
	providerLabel: "Abliteration",
	authUrl: "https://abliteration.ai/console",
	instructions: "Copy your API key from the Abliteration console",
	promptMessage: "Paste your Abliteration API key",
	placeholder: "ak_...",
	validation: {
		kind: "models-endpoint",
		provider: "Abliteration",
		modelsUrl: "https://api.abliteration.ai/v1/models",
	},
});

export const abliterationProvider = {
	id: "abliteration",
	name: "Abliteration",
	login: (cb: OAuthLoginCallbacks) => loginAbliteration(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
