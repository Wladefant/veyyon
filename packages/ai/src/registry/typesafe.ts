import { trimTrailingSlashes } from "@veyyon/utils/url";
import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const AUTH_URL = "https://console.typesafe.ai/";
const DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** The models-endpoint check honours `TYPESAFE_BASE_URL`, like discovery and System One requests. */
export function loginTypeSafe(callbacks: OAuthLoginCallbacks): Promise<string> {
	const baseUrl = trimTrailingSlashes((process.env.TYPESAFE_BASE_URL?.trim() || DEFAULT_BASE_URL));
	return createApiKeyLogin({
		providerLabel: "TypeSafe",
		authUrl: AUTH_URL,
		instructions: "Create or copy your API key from the TypeSafe console.",
		promptMessage: "Paste your TypeSafe API key",
		placeholder: "API key",
		validation: {
			kind: "models-endpoint",
			provider: "TypeSafe",
			modelsUrl: `${baseUrl}/v1/models`,
		},
	})(callbacks);
}

export const typesafeProvider = {
	id: "typesafe",
	name: "TypeSafe",
	login: (cb: OAuthLoginCallbacks) => loginTypeSafe(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
