import type { ProviderDefinition } from "./types";

/** Synthetic role provider backed by on-device inference; it has no credential and no login. */
export const localProvider = {
	id: "local",
	name: "Local Inference",
} as const satisfies ProviderDefinition;
