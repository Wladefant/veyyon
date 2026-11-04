import type { AuthStorage } from "@veyyon/ai";
import type { ResetCreditAccountStatus, ResetCreditRedeemOutcome } from "@veyyon/ai/auth-storage";

import type { UsageResetCommand } from "./usage-reset-options";
export { validateUsageResetOptions } from "./usage-reset-options";
export type { UsageResetCommand, UsageResetOptions } from "./usage-reset-options";

export async function executeUsageResetCommand(
	authStorage: Pick<AuthStorage, "listResetCredits" | "redeemResetCredit">,
	command: UsageResetCommand,
): Promise<{ accounts: ResetCreditAccountStatus[] } | ResetCreditRedeemOutcome> {
	if (command.mode === "list") {
		return { accounts: await authStorage.listResetCredits({ provider: "openai-codex" }) };
	}
	return authStorage.redeemResetCredit({
		target: { provider: "openai-codex", credentialId: command.credentialId },
	});
}
