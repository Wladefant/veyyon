import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginTypeSafe = createApiKeyLogin({
	providerLabel: "TypeSafe",
	authUrl: "https://typesafe.ai",
	instructions: "Copy your API key from your TypeSafe account",
	promptMessage: "Paste your TypeSafe API key",
	placeholder: "sk-...",
	validation: {
		kind: "models-endpoint",
		provider: "TypeSafe",
		modelsUrl: "https://api.typesafe.ai/v1/models",
	},
});

export const typesafeProvider = {
	id: "typesafe",
	name: "TypeSafe",
	login: (cb: OAuthLoginCallbacks) => loginTypeSafe(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
