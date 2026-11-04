/**
 * Resuming or deleting a session leaves the screen on the session it names.
 *
 * THE CLASS. `/resume`, the session picker and `/session delete` each move the screen from one
 * session to another, and each has a branch where the obvious move is wrong: a session still
 * running in the background must be re-attached as the live object rather than replayed from its
 * file, a resumed session from another project must move the process cwd with it, and deleting the
 * session on screen must first move the screen to a fresh session (and keep the file when that move
 * is refused). Every refusal reports why and leaves the file in place.
 *
 * WHAT THIS SUITE PINS.
 *
 *  1. Delete refuses an in-memory session and an unsaved one, and a declined confirmation, each
 *     with its own message, and deletes nothing.
 *  2. Deleting the session on screen opens a fresh session first, then removes the transcript and
 *     its artifacts directory, reports it, and reopens the session picker.
 *  3. A refused fresh session cancels the delete and keeps the file.
 *  4. Resuming a session kept in the background re-attaches that object, follows its cwd, and does
 *     not replay a file.
 *  5. Resuming a saved session switches to it, and moves the cwd only when its project differs.
 *
 * WHAT IT DOES NOT CATCH. The picker's own `onDelete` for a row that is not on screen (the card is
 * proven in the session-selector suites), the terminal title written after a move, and the
 * transcript repaint itself, which the context records only as a call.
 *
 * Subject: `modes/terminal/controllers/session-flows.ts`, driven through `SelectorController`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/session-selector";
import {
	SelectorController,
	type SelectorControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { shortenPath } from "@veyyon/coding-agent/tools/core/render-utils";
import type { Component } from "@veyyon/tui";

let root = "";

beforeAll(async () => {
	await initTheme();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-session-flows-"));
});

afterAll(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
});

/** Paths a test registered as live; reclaimed afterwards so a failed test leaves the keeper empty. */
const kept: string[] = [];
afterEach(() => {
	for (const file of kept.splice(0)) BackgroundSessions.global().take(file);
});

interface Harness {
	controller: SelectorController;
	/** Every call the flows made on the context, in order, with the argument that tells them apart. */
	log: string[];
	overlays: Component[];
	attached: unknown[];
	state: { cwd: string; file: string | undefined };
}

interface HarnessOptions {
	cwd: string;
	file: string | undefined;
	confirm?: boolean;
	newSession?: boolean;
	/** The cwd the session manager reports once `switchSession` lands. */
	switchedCwd?: string;
}

function harness(options: HarnessOptions): Harness {
	const log: string[] = [];
	const overlays: Component[] = [];
	const attached: unknown[] = [];
	const state = { cwd: options.cwd, file: options.file };
	const sessionDir = path.join(root, "sessions");
	const ctx = {
		sessionManager: {
			getCwd: () => state.cwd,
			getSessionDir: () => sessionDir,
			getSessionFile: () => state.file,
			getSessionName: () => undefined,
		},
		historyStorage: undefined,
		ui: {
			showOverlay: (component: Component) => {
				overlays.push(component);
				return { hide: () => log.push("overlay hidden") };
			},
			setFocus: () => {},
			requestRender: () => {},
			terminal: { rows: 40 },
		},
		session: {
			newSession: async () => {
				log.push("newSession");
				if (options.newSession === false) return false;
				state.file = undefined;
				return true;
			},
			switchSession: async (sessionPath: string) => {
				log.push(`switchSession ${sessionPath}`);
				state.file = sessionPath;
				state.cwd = options.switchedCwd ?? state.cwd;
				return true;
			},
		},
		shutdown: async () => {
			log.push("shutdown");
		},
		attachMainSession: (live: unknown) => {
			attached.push(live);
		},
		applyCwdChange: async (cwd: string) => {
			log.push(`applyCwdChange ${cwd}`);
		},
		clearTransientSessionUi: () => log.push("clearTransientSessionUi"),
		statusLine: { invalidate: () => {}, resetActiveTime: () => {} },
		updateEditorBorderColor: () => {},
		renderInitialMessages: () => log.push("renderInitialMessages"),
		reloadTodos: async () => {},
		showStatus: (message: string) => log.push(`status ${message}`),
		showError: (message: string) => log.push(`error ${message}`),
		showHookConfirm: async (title: string) => {
			log.push(`confirm ${title}`);
			return options.confirm ?? true;
		},
		editorContainer: { clear: () => {}, addChild: () => {} },
		editor: {},
	} as unknown as SelectorControllerContext;
	return { controller: new SelectorController(ctx), log, overlays, attached, state };
}

async function savedSession(name: string): Promise<{ file: string; artifacts: string }> {
	const dir = path.join(root, "sessions");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.jsonl`);
	const artifacts = path.join(dir, name);
	await fs.writeFile(file, "");
	await fs.mkdir(artifacts, { recursive: true });
	await fs.writeFile(path.join(artifacts, "out.txt"), "artifact");
	return { file, artifacts };
}

async function exists(target: string): Promise<boolean> {
	return fs.access(target).then(
		() => true,
		() => false,
	);
}

describe("deleting the session on screen", () => {
	it("refuses an in-memory session", async () => {
		const h = harness({ cwd: root, file: undefined });
		await h.controller.handleSessionDeleteCommand();
		expect(h.log).toEqual(["error No session file to delete (in-memory session)"]);
	});

	it("refuses a session that was never saved, without asking", async () => {
		const h = harness({ cwd: root, file: path.join(root, "sessions", "never-written.jsonl") });
		await h.controller.handleSessionDeleteCommand();
		expect(h.log).toEqual(["error Session has not been saved yet"]);
	});

	it("keeps the file when the confirmation is declined", async () => {
		const { file, artifacts } = await savedSession("declined");
		const h = harness({ cwd: root, file, confirm: false });
		await h.controller.handleSessionDeleteCommand();
		expect(h.log).toEqual(["confirm Delete Session", "status Delete cancelled"]);
		expect(await exists(file)).toBe(true);
		expect(await exists(artifacts)).toBe(true);
	});

	it("keeps the file when a fresh session cannot be opened in its place", async () => {
		const { file, artifacts } = await savedSession("refused");
		const h = harness({ cwd: root, file, newSession: false });
		await h.controller.handleSessionDeleteCommand();
		expect(h.log).toEqual(["confirm Delete Session", "newSession", "status Delete cancelled"]);
		expect(await exists(file)).toBe(true);
		expect(await exists(artifacts)).toBe(true);
	});

	it("moves to a fresh session, removes the transcript and its artifacts, and reopens the picker", async () => {
		const { file, artifacts } = await savedSession("deleted");
		const h = harness({ cwd: root, file });
		await h.controller.handleSessionDeleteCommand();
		expect(h.log).toEqual([
			"confirm Delete Session",
			"newSession",
			"clearTransientSessionUi",
			"renderInitialMessages",
			"status Session deleted",
		]);
		expect(h.state.file).toBeUndefined();
		expect(await exists(file)).toBe(false);
		expect(await exists(artifacts)).toBe(false);
		expect(h.overlays).toHaveLength(1);
		expect(h.overlays[0]).toBeInstanceOf(SessionSelectorComponent);
	});
});

describe("resuming a session", () => {
	it("re-attaches a session still running in the background and follows its cwd", async () => {
		const liveFile = path.join(root, "sessions", "live.jsonl");
		const liveCwd = path.join(root, "other-project");
		const live = {
			isStreaming: true,
			sessionManager: {
				getSessionId: () => "live-session",
				getSessionFile: () => liveFile,
				getCwd: () => liveCwd,
				flush: async () => {},
			},
			waitForQuiescence: (signal: AbortSignal) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => resolve(), { once: true });
				return promise;
			},
		} as unknown as AgentSession;
		BackgroundSessions.global().keep(live, 4);
		kept.push(liveFile);

		const h = harness({ cwd: root, file: undefined });
		await h.controller.handleResumeSession(liveFile);

		expect(h.attached).toEqual([live]);
		expect(h.log).toEqual([
			"clearTransientSessionUi",
			`applyCwdChange ${liveCwd}`,
			"renderInitialMessages",
			"status Resumed a session that is still running",
		]);
		expect(BackgroundSessions.global().find(liveFile)).toBeUndefined();
	});

	it("switches to a saved session in the same project without moving the cwd", async () => {
		const { file } = await savedSession("same-project");
		const h = harness({ cwd: root, file: undefined });
		await h.controller.handleResumeSession(file);
		expect(h.attached).toEqual([]);
		expect(h.log).toEqual([
			"clearTransientSessionUi",
			`switchSession ${file}`,
			"renderInitialMessages",
			"status Resumed session",
		]);
	});

	it("moves the cwd to a saved session's own project and names it", async () => {
		const { file } = await savedSession("moved-project");
		const elsewhere = path.join(root, "elsewhere");
		const h = harness({ cwd: root, file: undefined, switchedCwd: elsewhere });
		await h.controller.handleResumeSession(file);
		expect(h.log).toEqual([
			"clearTransientSessionUi",
			`switchSession ${file}`,
			`applyCwdChange ${elsewhere}`,
			"renderInitialMessages",
			`status Resumed session in ${shortenPath(elsewhere)}`,
		]);
	});
});
