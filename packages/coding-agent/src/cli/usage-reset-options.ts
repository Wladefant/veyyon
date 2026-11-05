export interface UsageResetOptions {
	resetCredits?: boolean;
	redeem?: string;
	provider?: string;
	history?: boolean;
	action?: string;
}

export type UsageResetCommand =
	| { mode: "list"; provider: "openai-codex" }
	| { mode: "redeem"; provider: "openai-codex"; credentialId: number };

export function validateUsageResetOptions(options: UsageResetOptions): UsageResetCommand | undefined {
	if (!options.resetCredits && options.redeem === undefined) return undefined;
	if (options.resetCredits && options.redeem !== undefined) {
		throw new Error("--reset-credits and --redeem cannot be used together");
	}
	if (options.action || options.history) throw new Error("Reset-credit options cannot be combined with another usage mode");
	if (options.provider !== undefined && options.provider.toLowerCase() !== "openai-codex") {
		throw new Error("Reset credits are supported only for --provider openai-codex");
	}
	if (options.resetCredits) return { mode: "list", provider: "openai-codex" };
	const value = options.redeem;
	if (!value || !/^[1-9]\d*$/.test(value)) throw new Error("--redeem requires one positive numeric credential ID");
	const credentialId = Number(value);
	if (!Number.isSafeInteger(credentialId)) throw new Error("--redeem credential ID must be a safe integer");
	return { mode: "redeem", provider: "openai-codex", credentialId };
}
