import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import { MoveOverlay } from "@veyyon/coding-agent/modes/terminal/components/selectors/move-overlay";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";

function createMoveContext(sourceDir: string, settingsFlush?: () => Promise<void>, isStreaming = false) {
	const state = {
		cwd: sourceDir,
		movedTo: undefined as string | undefined,
		completedBtwVisible: true,
	};
	const present = vi.fn();
	const captureState = vi.fn(() => ({ cwd: state.cwd }));
	const restoreState = vi.fn((snap: { cwd: string }) => {
		state.cwd = snap.cwd;
	});
	const applyCwdChange = vi.fn(async (cwd: string): Promise<void> => {
		expect(state.cwd).toBe(cwd);
	});
	const withBtwSessionMove = vi.fn(async (operation: () => Promise<boolean>) => {
		const moved = await operation();
		if (moved) state.completedBtwVisible = false;
		return moved;
	});
	const ctx = {
		session: { isStreaming },
		sessionManager: {
			getCwd: () => state.cwd,
			moveTo: vi.fn(async (cwd: string) => {
				state.cwd = cwd;
				state.movedTo = cwd;
			}),
			dropSession: vi.fn(async () => {}),
			captureState,
			restoreState,
		},
		settings: {
			flush: settingsFlush ?? vi.fn(async () => {}),
		},
		showHookCustom: vi.fn(),
		showHookConfirm: vi.fn(async () => true),
		showError: vi.fn(),
		showWarning: vi.fn(),
		applyCwdChange,
		withBtwSessionMove,
		updateEditorBorderColor: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		ui: {
			requestRender: vi.fn(),
			setFocus: vi.fn(),
			showOverlay: vi.fn((overlay: unknown) => {
				if (overlay instanceof MoveOverlay) {
					overlay.handleInput("\x1b");
				}
				return { close: vi.fn() };
			}),
		},
		focusActiveEditorArea: vi.fn(),
		present,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { ctx, state, present, captureState, restoreState, withBtwSessionMove };
}

describe("CommandController /move", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});


	it("relocates the active session before re-scoping cwd-derived state", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-source-"));
		const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-target-"));
		try {
			const { ctx, state, present } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(state.completedBtwVisible).toBe(false);
			expect(ctx.sessionManager.dropSession).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).toHaveBeenCalledWith(targetDir);
			expect(ctx.updateEditorBorderColor).toHaveBeenCalled();
			expect(ctx.reloadTodos).toHaveBeenCalled();
			expect(ctx.ui.requestRender).toHaveBeenCalledWith();
			expect(present).toHaveBeenCalled();
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("does not prompt or create a move target when pending settings flush fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-source-"));
		const targetDir = path.join(sourceDir, "destination");
		try {
			const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir, async () => {
				throw new Error("disk full");
			});
			ctx.showHookConfirm = vi.fn(async () => true);
			const mkdir = vi.spyOn(fs, "mkdir");
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
			expect(ctx.showHookConfirm).not.toHaveBeenCalled();
			expect(mkdir).not.toHaveBeenCalled();
			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(withBtwSessionMove).not.toHaveBeenCalled();
			expect(state.completedBtwVisible).toBe(true);
			expect(state.cwd).toBe(sourceDir);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it.each(["cancelled picker", "empty path", "missing parent", "declined creation", "streaming"] as const)(
		"preserves the session and BTW state when /move is cancelled or rejected on %s",
		async rejection => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-source-"));
			try {
				const isStreaming = rejection === "streaming";
				const { ctx, state, withBtwSessionMove } = createMoveContext(sourceDir, undefined, isStreaming);
				const controller = new CommandController(ctx);
				let targetPath: string | undefined;

				if (rejection === "cancelled picker") {
					targetPath = undefined;
				} else if (rejection === "empty path") {
					targetPath = `""`;
				} else if (rejection === "missing parent") {
					targetPath = path.join(sourceDir, "missing-parent", "destination");
				} else if (rejection === "declined creation") {
					targetPath = path.join(sourceDir, "destination");
					ctx.showHookConfirm = vi.fn(async () => false);
				} else if (rejection === "streaming") {
					targetPath = path.join(sourceDir, "destination");
				}

				await controller.handleMoveCommand(targetPath);

				if (rejection === "declined creation") {
					expect(withBtwSessionMove).toHaveBeenCalledTimes(1);
					const firstResult = await withBtwSessionMove.mock.results[0]?.value;
					expect(firstResult).toBe(false);
				} else {
					expect(withBtwSessionMove).not.toHaveBeenCalled();
				}
				expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
				expect(ctx.applyCwdChange).not.toHaveBeenCalled();
				expect(state.cwd).toBe(sourceDir);
				expect(state.movedTo).toBeUndefined();
				expect(state.completedBtwVisible).toBe(true);
			} finally {
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);

	it("does not prompt or create a move target when the BTW migration gate refuses", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-gate-"));
		try {
			const { ctx, state } = createMoveContext(sourceDir);
			const targetDir = path.join(sourceDir, "destination");
			ctx.showHookConfirm = vi.fn(async () => true);
			ctx.withBtwSessionMove = vi.fn(async () => false);
			const mkdir = vi.spyOn(fs, "mkdir");

			await new CommandController(ctx).handleMoveCommand(targetDir);

			expect(ctx.withBtwSessionMove).toHaveBeenCalledTimes(1);
			expect(ctx.showHookConfirm).not.toHaveBeenCalled();
			expect(mkdir).not.toHaveBeenCalled();
			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
			expect(ctx.applyCwdChange).not.toHaveBeenCalled();
			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(state.completedBtwVisible).toBe(true);
			expect(ctx.present).not.toHaveBeenCalled();
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
		}
	});

	it.each([true, false])(
		"holds the move gate across creation confirmation and only commits an accepted move (confirmed=%s)",
		async confirmed => {
			const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-lifecycle-"));
			const confirming = Promise.withResolvers<void>();
			const confirmation = Promise.withResolvers<boolean>();
			const creating = Promise.withResolvers<void>();
			const created = Promise.withResolvers<void>();
			const relocating = Promise.withResolvers<void>();
			const relocated = Promise.withResolvers<void>();
			let command: Promise<void> | undefined;
			let restoreMkdir: (() => void) | undefined;
			try {
				const { ctx, state } = createMoveContext(sourceDir);
				const targetDir = path.join(sourceDir, "destination");
				const sourceFile = path.join(sourceDir, "session.jsonl");
				const targetFile = path.join(targetDir, "session.jsonl");
				await Bun.write(sourceFile, "session data\n");
				let held = false;
				let commits = 0;
				ctx.withBtwSessionMove = vi.fn(async operation => {
					if (held) throw new Error("Nested migration gate");
					held = true;
					try {
						const moved = await operation();
						if (moved) {
							commits++;
							state.completedBtwVisible = false;
						}
						return moved;
					} finally {
						held = false;
					}
				});
				ctx.showHookConfirm = vi.fn(async () => {
					confirming.resolve();
					return confirmation.promise;
				});
				const originalMkdir = fs.mkdir;
				const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options): Promise<undefined> => {
					creating.resolve();
					await created.promise;
					await originalMkdir(directory, options);
					return undefined;
				});
				restoreMkdir = () => mkdir.mockRestore();
				ctx.sessionManager.moveTo = vi.fn(async cwd => {
					relocating.resolve();
					await relocated.promise;
					await fs.rename(sourceFile, targetFile);
					state.cwd = cwd;
					state.movedTo = cwd;
				});
				command = new CommandController(ctx).handleMoveCommand(targetDir);
				await confirming.promise;
				expect(held).toBe(true);
				expect(commits).toBe(0);
				expect(state.completedBtwVisible).toBe(true);
				expect(mkdir).not.toHaveBeenCalled();
				expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
				confirmation.resolve(confirmed);
				if (confirmed) {
					await creating.promise;
					expect(held).toBe(true);
					expect(commits).toBe(0);
					expect(ctx.sessionManager.moveTo).not.toHaveBeenCalled();
					created.resolve();
					await relocating.promise;
					expect((await fs.stat(targetDir)).isDirectory()).toBe(true);
					expect(held).toBe(true);
					expect(commits).toBe(0);
					expect(state.cwd).toBe(sourceDir);
					relocated.resolve();
				}
				await command;

				expect(held).toBe(false);
				expect(ctx.withBtwSessionMove).toHaveBeenCalledTimes(1);
				expect(ctx.showHookConfirm).toHaveBeenCalledTimes(1);
				expect(mkdir).toHaveBeenCalledTimes(confirmed ? 1 : 0);
				expect(ctx.sessionManager.moveTo).toHaveBeenCalledTimes(confirmed ? 1 : 0);
				expect(commits).toBe(confirmed ? 1 : 0);
				expect(state.completedBtwVisible).toBe(!confirmed);
				expect(state.cwd).toBe(confirmed ? targetDir : sourceDir);
				if (confirmed) {
					expect(await Bun.file(targetFile).text()).toBe("session data\n");
					expect(await Bun.file(sourceFile).exists()).toBe(false);
					expect(ctx.present).toHaveBeenCalledTimes(1);
				} else {
					expect(await Bun.file(sourceFile).text()).toBe("session data\n");
					expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
					expect(ctx.applyCwdChange).not.toHaveBeenCalled();
					expect(ctx.present).not.toHaveBeenCalled();
				}
			} finally {
				restoreMkdir?.();
				confirmation.resolve(false);
				created.resolve();
				relocated.resolve();
				await command;
				await fs.rm(sourceDir, { recursive: true, force: true });
			}
		},
	);
});
