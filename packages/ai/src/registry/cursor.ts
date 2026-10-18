import { loginCursorHook, refreshCursorHook } from "./oauth/cursor";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const cursorProvider = {
	id: "cursor",
	name: "Cursor (Claude, GPT, etc.)",
	login: (cb: OAuthLoginCallbacks) => loginCursorHook(cb),
	credential: "oauth",
	refreshToken: (credentials: OAuthCredentials, signal?: AbortSignal) => refreshCursorHook(credentials, signal),
} as const satisfies ProviderDefinition;
