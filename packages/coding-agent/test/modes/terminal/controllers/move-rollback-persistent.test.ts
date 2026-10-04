import { beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { CommandController } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("CommandController /move rollback against a persistent SessionManager", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("moves journal and artifacts back when applying the new cwd fails", async () => {
		const temp = TempDir.createSync("veyyon-move-rollback-");
		const sourceCwd = path.join(temp.path(), "old-project");
		const targetCwd = path.join(temp.path(), "new-project");
		fs.mkdirSync(sourceCwd);
		fs.mkdirSync(targetCwd);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Fixture model is unavailable");
		const manager = SessionManager.create(sourceCwd);
		let reopened: SessionManager | undefined;
		try {
			manager.appendMessage({ role: "user", content: "original-user", timestamp: 1 });
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "original-assistant" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			});
			await manager.flush();
			const originalFile = manager.getSessionFile();
			if (!originalFile) throw new Error("Persistent fixture has no session file");
			const originalArtifacts = originalFile.replace(/\.jsonl$/, "");
			fs.mkdirSync(originalArtifacts, { recursive: true });
			fs.writeFileSync(path.join(originalArtifacts, "proof.txt"), "original-artifact");

			const appliedCwds: string[] = [];
			const applyCwdChange = async (cwd: string): Promise<void> => {
				appliedCwds.push(cwd);
				if (cwd === targetCwd) throw new Error("forced applyCwdChange failure");
			};
			const showError = vi.fn();
			const ctx = {
				session: { isStreaming: false },
				sessionManager: manager,
				settings: { flush: vi.fn(async () => {}) },
				showHookCustom: vi.fn(),
				showHookConfirm: vi.fn(async () => true),
				showError,
				showWarning: vi.fn(),
				applyCwdChange,
				withBtwSessionMove: async (operation: () => Promise<boolean>) => operation(),
				updateEditorBorderColor: vi.fn(),
				reloadTodos: vi.fn(async () => {}),
				ui: { requestRender: vi.fn(), setFocus: vi.fn(), showOverlay: vi.fn() },
				focusActiveEditorArea: vi.fn(),
				present: vi.fn(),
				refreshComposerShortcuts: vi.fn(),
				dismissWelcome: vi.fn(),
			} as unknown as InteractiveModeContext;

			await new CommandController(ctx).handleMoveCommand(targetCwd);

			expect(appliedCwds).toContain(targetCwd);
			expect(manager.getCwd()).toBe(sourceCwd);
			expect(manager.getSessionFile()).toBe(originalFile);
			expect(fs.existsSync(originalFile)).toBe(true);
			expect(fs.existsSync(path.join(originalArtifacts, "proof.txt"))).toBe(true);

			manager.appendMessage({ role: "user", content: "after-failed-move", timestamp: 3 });
			await manager.flush();
			reopened = await SessionManager.open(originalFile);
			expect(reopened.captureState().entries.length).toBe(3);
		} finally {
			await reopened?.close();
			await manager.close();
			await temp.remove();
		}
	}, 180000);
});
