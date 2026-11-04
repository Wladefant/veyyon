import { getMuseCodeApiKey, loginMuseCode, refreshMuseCodeToken } from "./oauth/muse-code";
import type { ProviderDefinition } from "./types";

export const museCodeProvider = {
	id: "muse-code",
	name: "Muse Code (Subscription)",
	login: loginMuseCode,
	credential: "oauth",
	refreshToken: refreshMuseCodeToken,
	getApiKey: getMuseCodeApiKey,
} as const satisfies ProviderDefinition;
