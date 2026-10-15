import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore, type AssistantMessage } from "@veyyon/ai";
import { removeWithRetries } from "../../../utils/src/temp";
import { RetryRuntime, type RetryHost, type RetrySession } from "../../src/session/runtime/retry-runtime";

const PROVIDER = "google-antigravity";
const SESSION = "quota-attribution";

function refused(credentialId?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "google-gemini-cli",
		provider: PROVIDER,
		model: "gemini-3.8-flash",
		timestamp: 1,
		stopReason: "error",
		errorStatus: 429,
		errorMessage: "Individual quota reached. QUOTA_EXHAUSTED. retry-after-ms=80000000",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			credentialId,
		},
	};
}

describe("quota refusals belong to the failed request", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quota-refusal-attribution-"));
		dbPath = path.join(tempDir, "agent.db");
	});

	afterEach(async () => {
		dbPath = "";
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function recover(identity: string | undefined) {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		store.replaceAuthCredentialsForProvider(PROVIDER, [
			{ type: "api_key", key: "failed-api-key" },
			{ type: "api_key", key: "healthy-api-key" },
		]);
		const [failed, healthy] = store.listAuthCredentials(PROVIDER);
		if (!failed || !healthy) throw new Error("expected two stored credentials");
		const storage = new AuthStorage(store, { loadBalancing: true });
		await storage.reload();
		try {
			// Record the failed request's identity, then move sticky routing before retry recovery.
			expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("failed-api-key");
			expect(storage.sessionCredentialRouting(PROVIDER, SESSION)?.activeCredentialId).toBe(failed.id);
			expect(storage.selectProviderCredential(PROVIDER, healthy.id, { sessionId: SESSION })).toBe(true);
			expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("healthy-api-key");
			expect(storage.sessionCredentialRouting(PROVIDER, SESSION)?.activeCredentialId).toBe(healthy.id);

			const message = refused(
				identity === undefined ? undefined : identity === "__failed_id__" ? String(failed.id) : identity,
			);
			const session = {
				model: { id: "gemini-3.8-flash", provider: PROVIDER, api: "google-gemini-cli" },
				sessionId: SESSION,
				thinkingLevel: "high",
				settings: {
					getGroup: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10, modelFallback: false }),
					get: () => undefined,
				},
				modelRegistry: { authStorage: storage },
				agent: { state: { messages: [message] } },
				sessionManager: { getBranch: () => [] },
			} as unknown as RetrySession;
			const host = {
				emitSessionEvent: async () => {},
				promptGeneration: () => 1,
				abortIsDeliberate: () => false,
				maybeAutoRedeemCodexReset: async () => false,
				persistLifecycleErrorMessage: async () => {},
				removeAssistantMessageFromActiveContext: () => {
					session.agent.state.messages = [];
				},
				scheduleAgentContinue: () => {},
				resetSessionStopContinuationState: () => {},
			} as unknown as RetryHost;
			const runtime = new RetryRuntime(session, host);
			expect(await runtime.recoverFailedTurn(message)).toBe(identity === "__failed_id__");
			runtime.resolve();
			expect(runtime.isRetrying).toBe(false);
			return { storage, failedId: failed.id, healthyId: healthy.id };
		} catch (error) {
			storage.close();
			throw error;
		}
	}

	it("parks the failed credential, not the sticky selected after its refusal", async () => {
		const { storage, failedId, healthyId } = await recover("__failed_id__");
		try {
			const blocks = storage.listCredentialBlocks([failedId, healthyId]);
			expect(blocks).toHaveLength(1);
			expect(blocks[0]).toMatchObject({
				credentialId: failedId,
				providerKey: `${PROVIDER}:api_key`,
				blockScope: "",
			});
			expect(blocks[0]!.blockedUntilMs).toBeGreaterThan(Date.now());
		} finally {
			storage.close();
		}
	});

	for (const identity of [undefined, "gateway-account", "", " ", "0", "-1", "1.5", "9007199254740992"]) {
		it(`does not guess an account when request identity is ${String(identity)}`, async () => {
			const { storage, failedId, healthyId } = await recover(identity);
			try {
				expect(storage.listCredentialBlocks([failedId, healthyId])).toEqual([]);
			} finally {
				storage.close();
			}
		});
	}
});
