import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * OpenCode Go uses the OpenCode API-key login under its provider ID.
 */
export const opencodeGoProvider = {
	id: "opencode-go",
	name: "OpenCode Go",
	login: async (cb: OAuthLoginCallbacks) => {
		// This is the registry's lazy boundary for provider login flows.
		const { loginOpenCodeGo } = await import("./oauth/opencode-go");
		return loginOpenCodeGo(cb);
	},
	credential: "api-key",
} as const satisfies ProviderDefinition;
