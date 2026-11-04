export interface SessionHandoffIdentity {
	version: 1;
	targetNode: string;
	transferId: string;
	transferEpoch: number;
}

/** Shared boundary grammar for stable device labels and process runtime owners. */
export function isCheckpointNodeLabel(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}
