import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
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
});
