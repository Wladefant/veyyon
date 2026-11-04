import type { ProviderDefinition } from "./types";

/** Synthetic role provider for web search; it has no credential and no login. */
export const webProvider = {
	id: "web",
	name: "Web Search",
} as const satisfies ProviderDefinition;
