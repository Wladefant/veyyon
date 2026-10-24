import { loginOpenCodeGo, refreshOpenCodeGoToken } from "./oauth/opencode-console";
import type { ProviderDefinition } from "./types";

/**
 * OpenCode Go, signed in with an OpenCode Console account. An OpenCode Go API key is the legacy way in,
 * offered by `opencode-go-api-key`.
 */
export const opencodeGoProvider = {
	id: "opencode-go",
	name: "OpenCode Go",
	login: loginOpenCodeGo,
	credential: "oauth",
	refreshToken: (credentials, signal) => refreshOpenCodeGoToken(credentials, undefined, signal),
} as const satisfies ProviderDefinition;
