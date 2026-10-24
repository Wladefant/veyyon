import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

// Every `await import` here is the registry's lazy boundary: the OAuth flow module stays out of the
// eager startup graph until a login or refresh runs.

/**
 * OpenCode Go, signed in with an OpenCode Console account. An OpenCode Go API key is the legacy way in,
 * offered by `opencode-go-api-key`.
 */
export const opencodeGoProvider = {
	id: "opencode-go",
	name: "OpenCode Go",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginOpenCodeGo } = await import("./oauth/opencode-console");
		return loginOpenCodeGo(cb);
	},
	credential: "oauth",
	refreshToken: async (credentials: OAuthCredentials, signal?: AbortSignal) => {
		const { refreshOpenCodeGoToken } = await import("./oauth/opencode-console");
		return refreshOpenCodeGoToken(credentials, undefined, signal);
	},
} as const satisfies ProviderDefinition;
