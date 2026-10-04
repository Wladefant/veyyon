import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CommandController } from "@veyyon/coding-agent/modes/terminal/controllers/command-controller";
import { MoveOverlay } from "@veyyon/coding-agent/modes/terminal/components/selectors/move-overlay";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";

/** Counts the directories /move creates while still creating them: the claim is "nothing was created", not "a spy stayed quiet". */
function countMkdir(): { count(): number } {
	const original = fs.mkdir;
	let count = 0;
	vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
		count++;
		return original(...args);
	}) as typeof fs.mkdir);
	return { count: () => count };
}

function createMoveContext(sourceDir: string, settingsFlush?: () => Promise<void>, isStreaming = false) {
	const state = {
		cwd: sourceDir,
		movedTo: undefined as string | undefined,
		completedBtwVisible: true,
	};
	/** What the controller asked of its host, recorded by the fakes below. */
	const calls = {
		present: 0,
		applyCwdChange: [] as string[],
		withBtwSessionMove: 0,
		moveTo: 0,
		dropSession: 0,
		updateEditorBorderColor: 0,
		reloadTodos: 0,
		requestRender: [] as unknown[][],
		showError: [] as string[],
		showHookConfirm: 0,
	};
	const present = () => {
		calls.present++;
	};
	const captureState = vi.fn(() => ({ cwd: state.cwd }));
	const restoreState = vi.fn((snap: { cwd: string }) => {
		state.cwd = snap.cwd;
	});
	const applyCwdChange = async (cwd: string): Promise<void> => {
		calls.applyCwdChange.push(cwd);
		expect(state.cwd).toBe(cwd);
	};
	const withBtwSessionMove = async (operation: () => Promise<boolean>) => {
		calls.withBtwSessionMove++;
		const moved = await operation();
		if (moved) state.completedBtwVisible = false;
		return moved;
	};
	const ctx = {
		session: { isStreaming },
		sessionManager: {
			getCwd: () => state.cwd,
			moveTo: async (cwd: string) => {
				calls.moveTo++;
				state.cwd = cwd;
				state.movedTo = cwd;
			},
			dropSession: async () => {
				calls.dropSession++;
			},
			captureState,
			restoreState,
		},
		settings: {
			flush: settingsFlush ?? vi.fn(async () => {}),
		},
		showHookCustom: vi.fn(),
		showHookConfirm: async () => {
			calls.showHookConfirm++;
			return true;
		},
		showError: (message: string) => {
			calls.showError.push(message);
		},
		showWarning: vi.fn(),
		applyCwdChange,
		withBtwSessionMove,
		updateEditorBorderColor: () => {
			calls.updateEditorBorderColor++;
		},
		reloadTodos: async () => {
			calls.reloadTodos++;
		},
		ui: {
			requestRender: (...args: unknown[]) => {
				calls.requestRender.push(args);
			},
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
	return { ctx, state, calls, captureState, restoreState };
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
			const { ctx, state, calls } = createMoveContext(sourceDir);
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(state.movedTo).toBe(targetDir);
			expect(state.completedBtwVisible).toBe(false);
			expect(calls.dropSession).toBe(0);
			expect(calls.applyCwdChange).toEqual([targetDir]);
			expect(calls.updateEditorBorderColor).toBeGreaterThan(0);
			expect(calls.reloadTodos).toBeGreaterThan(0);
			expect(calls.requestRender).toContainEqual([]);
			expect(calls.present).toBeGreaterThan(0);
			expect(calls.showError).toEqual([]);
		} finally {
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rm(targetDir, { recursive: true, force: true });
		}
	});

	it("does not prompt or create a move target when pending settings flush fails", async () => {
		const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-move-source-"));
		const targetDir = path.join(sourceDir, "destination");
		try {
			const { ctx, state, calls } = createMoveContext(sourceDir, async () => {
				throw new Error("disk full");
			});
			const mkdir = countMkdir();
			const controller = new CommandController(ctx);

			await controller.handleMoveCommand(targetDir);

			expect(calls.showError).toHaveLength(1);
			expect(calls.showError[0]).toContain("disk full");
			expect(calls.showHookConfirm).toBe(0);
			expect(mkdir.count()).toBe(0);
			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(calls.moveTo).toBe(0);
			expect(calls.applyCwdChange).toEqual([]);
			expect(calls.withBtwSessionMove).toBe(0);
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
				const { ctx, state, calls } = createMoveContext(sourceDir, undefined, isStreaming);
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
					ctx.showHookConfirm = async () => false;
				} else if (rejection === "streaming") {
					targetPath = path.join(sourceDir, "destination");
				}

				await controller.handleMoveCommand(targetPath);

				// A declined creation enters the gate once and leaves it with "not moved"; every other
				// rejection never reaches the gate. Either way the session and the BTW state are unchanged.
				expect(calls.withBtwSessionMove).toBe(rejection === "declined creation" ? 1 : 0);
				expect(calls.moveTo).toBe(0);
				expect(calls.applyCwdChange).toEqual([]);
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
			const { ctx, state, calls } = createMoveContext(sourceDir);
			const targetDir = path.join(sourceDir, "destination");
			let gateEntries = 0;
			ctx.withBtwSessionMove = async () => {
				gateEntries++;
				return false;
			};
			const mkdir = countMkdir();

			await new CommandController(ctx).handleMoveCommand(targetDir);

			expect(gateEntries).toBe(1);
			expect(calls.showHookConfirm).toBe(0);
			expect(mkdir.count()).toBe(0);
			expect(await fs.readdir(sourceDir)).toEqual([]);
			expect(calls.moveTo).toBe(0);
			expect(calls.applyCwdChange).toEqual([]);
			expect(state.cwd).toBe(sourceDir);
			expect(state.movedTo).toBeUndefined();
			expect(state.completedBtwVisible).toBe(true);
			expect(calls.present).toBe(0);
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
				const { ctx, state, calls } = createMoveContext(sourceDir);
				const targetDir = path.join(sourceDir, "destination");
				const sourceFile = path.join(sourceDir, "session.jsonl");
				const targetFile = path.join(targetDir, "session.jsonl");
				await Bun.write(sourceFile, "session data\n");
				let held = false;
				let commits = 0;
				let gateEntries = 0;
				let confirmations = 0;
				let mkdirCalls = 0;
				let relocations = 0;
				ctx.withBtwSessionMove = async operation => {
					gateEntries++;
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
				};
				ctx.showHookConfirm = async () => {
					confirmations++;
					confirming.resolve();
					return confirmation.promise;
				};
				const originalMkdir = fs.mkdir;
				const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (directory, options): Promise<undefined> => {
					mkdirCalls++;
					creating.resolve();
					await created.promise;
					await originalMkdir(directory, options);
					return undefined;
				});
				restoreMkdir = () => mkdir.mockRestore();
				ctx.sessionManager.moveTo = async cwd => {
					relocations++;
					relocating.resolve();
					await relocated.promise;
					await fs.rename(sourceFile, targetFile);
					state.cwd = cwd;
					state.movedTo = cwd;
				};
				command = new CommandController(ctx).handleMoveCommand(targetDir);
				await confirming.promise;
				expect(held).toBe(true);
				expect(commits).toBe(0);
				expect(state.completedBtwVisible).toBe(true);
				expect(mkdirCalls).toBe(0);
				expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
				confirmation.resolve(confirmed);
				if (confirmed) {
					await creating.promise;
					expect(held).toBe(true);
					expect(commits).toBe(0);
					expect(relocations).toBe(0);
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
				expect(gateEntries).toBe(1);
				expect(confirmations).toBe(1);
				expect(mkdirCalls).toBe(confirmed ? 1 : 0);
				expect(relocations).toBe(confirmed ? 1 : 0);
				expect(commits).toBe(confirmed ? 1 : 0);
				expect(state.completedBtwVisible).toBe(!confirmed);
				expect(state.cwd).toBe(confirmed ? targetDir : sourceDir);
				if (confirmed) {
					expect(await Bun.file(targetFile).text()).toBe("session data\n");
					expect(await Bun.file(sourceFile).exists()).toBe(false);
					expect(calls.present).toBe(1);
				} else {
					expect(await Bun.file(sourceFile).text()).toBe("session data\n");
					expect(await fs.readdir(sourceDir)).toEqual(["session.jsonl"]);
					expect(calls.applyCwdChange).toEqual([]);
					expect(calls.present).toBe(0);
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
