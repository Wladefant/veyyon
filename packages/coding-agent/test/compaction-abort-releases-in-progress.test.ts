import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { CompactionCancelledError } from "@veyyon/agent-core/compaction";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../agent/test/helpers";

const BOUNDED_WAIT_MS = 2_000;

const USAGE = { ...emptyUsage(), input: 1_000, output: 100, totalTokens: 1_100 };

// Bounded-wait failure deadline (cleared immediately when the awaited promise settles).
async function within<T>(operation: Promise<T>, label: string, ms = BOUNDED_WAIT_MS): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error(`Fixture phase "${label}" did not finish within ${ms}ms`)),
		ms,
	);
	try {
		return await Promise.race([operation, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

describe("manual compact cancellation releases in-progress state", () => {
	const activeSessions: AgentSession[] = [];
	const authStores: AuthStorage[] = [];
	const tempDirs: TempDir[] = [];
	const pendingReleases: Array<PromiseWithResolvers<void>> = [];

	afterEach(async () => {
		for (const release of pendingReleases.splice(0)) {
			release.resolve();
		}
		vi.restoreAllMocks();
		await Promise.all(activeSessions.splice(0).map(session => session.dispose()));
		for (const store of authStores.splice(0)) {
			store.close();
		}
		for (const dir of tempDirs.splice(0)) {
			await dir.remove();
		}
	});

	async function createCompactionFixture(extensionRunner?: ExtensionRunner) {
		const tempDir = TempDir.createSync("@pi-compaction-abort-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStores.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		for (let i = 0; i < 4; i++) {
			sessionManager.appendMessage({ role: "user", content: `question ${i}`, timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `answer ${i}` }],
				api: model.api,
				provider: "anthropic",
				model: model.id,
				stopReason: "stop",
				usage: USAGE,
				timestamp: Date.now(),
			});
		}

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"compaction.remote": false,
				"retry.enabled": false,
			}),
			modelRegistry,
			extensionRunner,
		});
		activeSessions.push(session);
		return { session, sessionManager };
	}

	it("rejects promptly, clears isCompacting, ignores late completion, and allows retry when provider compact ignores AbortSignal", async () => {
		const { session, sessionManager } = await createCompactionFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pendingReleases.push(release);

		let attempt = 0;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => {
			attempt += 1;
			if (attempt === 1) {
				entered.resolve();
				await release.promise;
				return {
					summary: "LATE_PROVIDER_SUMMARY",
					shortSummary: undefined,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			}
			return {
				summary: "HEALTHY_RETRY_SUMMARY",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			};
		});

		const compactPromise = session.compact();
		await within(entered.promise, "provider compact entered");
		expect(session.isCompacting).toBe(true);

		session.abortCompaction();

		const rejection = await within(
			compactPromise.then(
				() => undefined,
				error => error,
			),
			"manual compact rejection after abortCompaction",
		);
		expect(rejection).toBeInstanceOf(CompactionCancelledError);
		expect(session.isCompacting).toBe(false);

		release.resolve();
		const flushed = Promise.withResolvers<void>();
		queueMicrotask(() => flushed.resolve());
		await flushed.promise;
		expect(sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(0);

		const retryResult = await within(session.compact(), "healthy manual compact retry");
		expect(retryResult.summary).toBe("HEALTHY_RETRY_SUMMARY");
		expect(session.isCompacting).toBe(false);
		expect(compactSpy).toHaveBeenCalledTimes(2);
		const compactions = sessionManager.getBranch().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]?.summary).toBe("HEALTHY_RETRY_SUMMARY");
	});

	it("rejects promptly, clears isCompacting, ignores late completion, and allows retry when session_before_compact ignores AbortSignal", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		pendingReleases.push(release);

		let attempt = 0;
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session_before_compact",
			emit: async (event: {
				type: string;
				preparation?: { firstKeptEntryId: string; tokensBefore: number };
			}) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				attempt += 1;
				if (attempt === 1) {
					entered.resolve();
					await release.promise;
					return {
						compaction: {
							summary: "LATE_HOOK_SUMMARY",
							shortSummary: undefined,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				}
				return {
					compaction: {
						summary: "HEALTHY_HOOK_RETRY",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
		} as unknown as ExtensionRunner;

		const { session, sessionManager } = await createCompactionFixture(extensionRunner);

		const compactPromise = session.compact();
		await within(entered.promise, "session_before_compact entered");
		expect(session.isCompacting).toBe(true);

		session.abortCompaction();

		const rejection = await within(
			compactPromise.then(
				() => undefined,
				error => error,
			),
			"manual compact rejection after hook abortCompaction",
		);
		expect(rejection).toBeInstanceOf(CompactionCancelledError);
		expect(session.isCompacting).toBe(false);

		release.resolve();
		const flushed = Promise.withResolvers<void>();
		queueMicrotask(() => flushed.resolve());
		await flushed.promise;
		expect(sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(0);

		const retryResult = await within(session.compact(), "healthy manual compact retry after hook abort");
		expect(retryResult.summary).toBe("HEALTHY_HOOK_RETRY");
		expect(session.isCompacting).toBe(false);
		expect(attempt).toBe(2);
		const compactions = sessionManager.getBranch().filter(entry => entry.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect(compactions[0]?.summary).toBe("HEALTHY_HOOK_RETRY");
	});
});
