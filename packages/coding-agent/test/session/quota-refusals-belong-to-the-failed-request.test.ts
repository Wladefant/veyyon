import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { RetryRuntime, type RetryHost, type RetrySession } from "../../src/session/runtime/retry-runtime";

function refused(credentialId?: string): AssistantMessage {
	return {
		role: "assistant", content: [], api: "google-gemini-cli", provider: "google-antigravity",
		model: "gemini-3.8-flash", timestamp: 1, stopReason: "error", errorStatus: 429,
		errorMessage: "Individual quota reached. QUOTA_EXHAUSTED. retry-after-ms=80000000",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, credentialId },
	};
}

async function recover(message: AssistantMessage) {
	// The resolver already moved sticky to 13 after the wire refusal from 20.
	// Only an explicit target prevents the store from parking the healthy sticky.
	const blocked: number[] = [];
	const mark = mock(async (_provider: string, _session: string, options: { credentialId?: number }) => {
		blocked.push(options.credentialId ?? 13);
		return { switched: false };
	});
	const session = {
		model: { id: "gemini-3.8-flash", provider: "google-antigravity", api: "google-gemini-cli" },
		sessionId: "quota-attribution", thinkingLevel: "high",
		settings: {
			getGroup: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10, modelFallback: false }),
			get: () => undefined,
		},
		modelRegistry: { authStorage: { markUsageLimitReached: mark } },
		agent: { state: { messages: [message] } },
	} as unknown as RetrySession;
	const host = {
		emitSessionEvent: async () => {}, promptGeneration: () => 1, abortIsDeliberate: () => false,
		maybeAutoRedeemCodexReset: async () => false, persistLifecycleErrorMessage: async () => {},
		resetSessionStopContinuationState: () => {},
	} as unknown as RetryHost;
	const runtime = new RetryRuntime(session, host);
	expect(await runtime.recoverFailedTurn(message)).toBe(false);
	expect(runtime.isRetrying).toBe(false);
	return { blocked, mark };
}

describe("quota refusals belong to the failed request", () => {
	it("parks the failed credential, not the sticky selected after its refusal", async () => {
		const { blocked, mark } = await recover(refused("20"));
		expect(blocked).toEqual([20]);
		expect(mark.mock.calls[0][2]).toMatchObject({ credentialId: 20 });
	});

	for (const identity of [undefined, "gateway-account", "", "0", "-1", "1.5"]) {
		it(`does not guess an account when request identity is ${String(identity)}`, async () => {
			const { blocked, mark } = await recover(refused(identity));
			expect(blocked).toEqual([]);
			expect(mark).not.toHaveBeenCalled();
		});
	}
});
