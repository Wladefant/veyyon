import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { submitInteractiveInput } from "../src/main";
import { InteractiveMode } from "../src/modes/terminal/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { initTheme } from "../src/theme/theme";

describe("a pending submission lifecycle in interactive mode", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pending-submission-test-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.addMessageToChat = vi.fn();
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("allows a pending submission to be marked started", () => {
		if (!mode) throw new Error("Expected mode");
		const submission = mode.startPendingSubmission({ text: "test input" });
		expect(submission.started).toBe(false);
		expect(submission.cancelled).toBe(false);

		const started = mode.markPendingSubmissionStarted(submission);
		expect(started).toBe(true);
		expect(submission.started).toBe(true);

		// Once started, it cannot be cancelled
		const cancelledAfterStart = mode.cancelPendingSubmission();
		expect(cancelledAfterStart).toBe(false);
	});

	it("allows a pending submission to be cancelled before it starts", () => {
		if (!mode) throw new Error("Expected mode");
		const submission = mode.startPendingSubmission({ text: "test input to cancel" });
		expect(submission.started).toBe(false);
		expect(submission.cancelled).toBe(false);

		const cancelled = mode.cancelPendingSubmission();
		expect(cancelled).toBe(true);
		expect(submission.cancelled).toBe(true);

		// Once cancelled, markPendingSubmissionStarted must refuse it
		const startedAfterCancel = mode.markPendingSubmissionStarted(submission);
		expect(startedAfterCancel).toBe(false);
	});
	it("preserves Telegram trace metadata from the real interactive submit to provider invocation", async () => {
		const realMode = mode;
		const realSession = session;
		if (!realMode || !realSession || !authStorage) throw new Error("Expected initialized interactive session");
		// The provider is entirely in-memory; the real InteractiveMode, submission code and
		// AgentSession are exercised, rather than copying their trace-forwarding logic into a fake.
		const fakeProvider = createMockModel({ responses: [{ content: ["Trace delivered"], stopReason: "stop" }] });
		authStorage.setRuntimeApiKey("mock", "test-only-token");
		realSession.agent.setModel(fakeProvider.model);
		const traceRecords: Array<Record<string, unknown>> = [];
		vi.spyOn(logger, "info").mockImplementation((message, context) => {
			if (message === "Telegram delivery trace") traceRecords.push(context ? { ...context } : {});
		});
		const traceAtProvider: Array<Array<Record<string, unknown>>> = [];
		realSession.agent.streamFn = (model, context, options) => {
			// The agent-loop emits provider_call_start immediately before invoking this callback.
			traceAtProvider.push(traceRecords.map(record => ({ ...record })));
			return fakeProvider.stream(model, context, options);
		};
		const errors: string[] = [];
		vi.spyOn(realMode, "showError").mockImplementation(message => {
			errors.push(message);
		});
		const telegramTrace = { updateId: 9001, messageId: 42, chatId: "-1001999888", topicId: 10 };
		const input = realMode.startPendingSubmission({
			text: "traced input",
			streamingBehavior: "followUp",
			telegramTrace,
		});
		await submitInteractiveInput(realMode, realSession, input);
		await realSession.waitForIdle();
		expect(errors).toEqual([]);
		expect(input.started).toBe(true);
		expect(fakeProvider.calls).toHaveLength(1);
		expect(JSON.stringify(fakeProvider.calls[0]?.context.messages)).toContain("traced input");
		expect(traceAtProvider).toHaveLength(1);
		const traceId = "-1001999888:9001:42";
		expect(traceAtProvider[0]?.filter(record => record.stage === "provider_call_start")).toEqual([
			expect.objectContaining({
				stage: "provider_call_start",
				traceId,
				sessionId: realSession.sessionManager.getSessionId(),
			}),
		]);
		expect(traceAtProvider[0]?.some(record => record.stage === "turn_consumption" && record.traceId === traceId)).toBe(true);
		expect(JSON.stringify(traceRecords)).not.toContain("traced input");
	});

	it("attributes queued Telegram steer and follow-up to their own provider calls", async () => {
		const realMode = mode;
		const realSession = session;
		if (!realMode || !realSession || !authStorage) throw new Error("Expected initialized interactive session");
		const releaseFirstProvider = Promise.withResolvers<void>();
		const firstProviderEntered = Promise.withResolvers<void>();
		let responseCount = 0;
		const fakeProvider = createMockModel({
			handler: async () => {
				if (responseCount++ === 0) await releaseFirstProvider.promise;
				return { content: ["Acknowledged"], stopReason: "stop" };
			},
		});
		authStorage.setRuntimeApiKey("mock", "test-only-token");
		realSession.agent.setModel(fakeProvider.model);
		const records: Array<Record<string, unknown>> = [];
		vi.spyOn(logger, "info").mockImplementation((message, context) => {
			if (message === "Telegram delivery trace") records.push(context ? { ...context } : {});
		});
		const atProvider: Array<{ traceIds: string[]; messages: string }> = [];
		let observedStartCount = 0;
		realSession.agent.streamFn = (model, context, options) => {
			// Snapshot only the start records that appeared since the previous provider invocation.
			const starts = records.filter(record => record.stage === "provider_call_start");
			const traceIds = starts.slice(observedStartCount).map(record => String(record.traceId));
			observedStartCount = starts.length;
			atProvider.push({ traceIds, messages: JSON.stringify(context.messages) });
			if (atProvider.length === 1) firstProviderEntered.resolve();
			return fakeProvider.stream(model, context, options);
		};
		const errors: string[] = [];
		vi.spyOn(realMode, "showError").mockImplementation(message => errors.push(message));
		const base = { chatId: "-1001999888", topicId: 10 };
		const initial = realMode.startPendingSubmission({
			text: "original traced turn",
			streamingBehavior: "followUp",
			telegramTrace: { ...base, updateId: 9101, messageId: 51 },
		});
		const initialDelivery = submitInteractiveInput(realMode, realSession, initial);
		let providerTimer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				firstProviderEntered.promise,
				new Promise<void>((_, reject) => {
					providerTimer = setTimeout(() => reject(new Error("First mock provider call did not start")), 10_000);
				}),
			]);
			if (!realSession.isStreaming) throw new Error("Expected first turn to remain in flight");
			const steering = realMode.startPendingSubmission({
				text: "steering traced turn",
				streamingBehavior: "steer",
				telegramTrace: { ...base, updateId: 9102, messageId: 52 },
			});
			await submitInteractiveInput(realMode, realSession, steering);
			const followUp = realMode.startPendingSubmission({
				text: "follow-up traced turn",
				streamingBehavior: "followUp",
				telegramTrace: { ...base, updateId: 9103, messageId: 53 },
			});
			await submitInteractiveInput(realMode, realSession, followUp);
			expect(steering.started).toBe(true);
			expect(followUp.started).toBe(true);
		} finally {
			if (providerTimer !== undefined) clearTimeout(providerTimer);
			releaseFirstProvider.resolve();
		}
		await initialDelivery;
		await realSession.waitForIdle();
		expect(errors).toEqual([]);
		const expectedTraceIds = ["-1001999888:9101:51", "-1001999888:9102:52", "-1001999888:9103:53"];
		// A queued steer is delivered before a follow-up; neither trace may leak into
		// the provider invocation for the previous or subsequent logical user turn.
		expect(atProvider.map(call => call.traceIds)).toEqual(expectedTraceIds.map(id => [id]));
		expect(fakeProvider.calls).toHaveLength(3);
		for (const [index, prompt] of [
			"original traced turn",
			"steering traced turn",
			"follow-up traced turn",
		].entries()) {
			expect(atProvider[index]?.messages).toContain(prompt);
		}
		expect(records.filter(record => record.stage === "turn_consumption").map(record => record.traceId)).toEqual(
			expectedTraceIds,
		);
		for (const text of ["original traced turn", "steering traced turn", "follow-up traced turn"]) {
			expect(JSON.stringify(records)).not.toContain(text);
		}
	});
});
