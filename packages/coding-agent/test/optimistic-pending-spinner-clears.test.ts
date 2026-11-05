import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { submitInteractiveInput } from "@veyyon/coding-agent/main";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { HistoryStorage } from "@veyyon/kernel/session/history-storage";
import { TempDir } from "@veyyon/utils";
import { createTestAgentSession } from "./helpers/test-agent-session";

describe("issue #927 optimistic pending spinner", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-927-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		({ authStorage, session } = await createTestAgentSession(tempDir.path()));
		vi.spyOn(session, "prompt").mockResolvedValue(true);
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

	it("clears the optimistic loading animation when prompt returns without a model turn", async () => {
		const input = mode.startPendingSubmission({ text: "/extension-no-turn" });
		expect(mode.loadingAnimation).toBeDefined();
		expect(mode.optimisticUserMessageSignature).toBe("/extension-no-turn\u00000");

		await submitInteractiveInput(mode, session, input);

		expect(mode.loadingAnimation).toBeUndefined();
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
		expect(mode.locallySubmittedUserSignatures.has("/extension-no-turn\u00000")).toBe(false);
		expect(mode.statusContainer.children.length).toBe(0);
	});
});
