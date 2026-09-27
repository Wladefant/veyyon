/**
 * WHY: a Telegram `hello` reached the GUI host's `deliver`, which opened a second
 * manager on a transcript an interactive terminal was writing and ran the turn
 * there (https://github.com/Wladefant/veyyon/issues/88). A live terminal
 * publishes a discovery record and takes delivered prompts over its own control
 * endpoint; the kernel refuses to OPEN its file for another writer. That left
 * the session the desktop already held: a terminal that resumes a session after
 * the desktop opened it owns the file, yet every desktop action went on writing
 * through the manager it kept.
 *
 * CLASS CLOSED: a desktop action that reaches a session file a live terminal
 * owns. The sweep drives every action that names a session or acts on the
 * client's current one through the real host, the real discovery record and the
 * real session file, in each state the desktop can hold that session in:
 * unopened, opened, and opened with an agent that has already run a turn. Every
 * action is refused, the file keeps its exact bytes, and no provider stream
 * starts. The host's `ACTION_SESSION_REACH` classifies every wire action, so a
 * new action does not compile until classified, and a reaching action with no
 * payload here fails the classification test. A writer misclassified as
 * "none" is the gap a reviewer of that table must catch.
 *
 * NOT CAUGHT: a turn the desktop started BEFORE the terminal took ownership
 * keeps writing until it ends; the terminal's own resume consults terminal
 * records only, so nothing tells it the desktop holds the file. The window
 * between the ownership check and the first append is not atomic either: the
 * discovery record is advisory, not a lock.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { computeDefaultSessionDir } from "@veyyon/kernel/session/session-paths";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import * as utils from "@veyyon/utils";
import { type GuiHostServer, type HostEvent, startGuiHostServer } from "../../src/gui-host";
import { ACTION_SESSION_REACH } from "../../src/gui-host/actions/active-session";
import { serveTerminalControl } from "../../src/launch/terminal-control";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, TestSocketClient } from "./test-client";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [{ type: "text", text: "" }] } });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/** Every action the host classifies as reaching a session, with a payload it accepts. */
const REACHES_THE_SESSION: Record<string, (session: string) => unknown> = {
	SubmitPrompt: session => ({ SubmitPrompt: { session, text: "hello from telegram", attachments: [] } }),
	Steer: session => ({ Steer: { session, text: "hello from telegram", attachments: [] } }),
	FollowUp: session => ({ FollowUp: { session, text: "hello from telegram", attachments: [] } }),
	DequeueQueuedPrompt: session => ({ DequeueQueuedPrompt: { session } }),
	OpenSession: session => ({ OpenSession: { session } }),
	LoadTranscript: session => ({ LoadTranscript: { session, before: null } }),
	RenameSession: session => ({ RenameSession: { session, title: "renamed by the desktop" } }),
	DeleteSession: session => ({ DeleteSession: { session } }),
	BranchSession: session => ({ BranchSession: { session } }),
	ExportSession: session => ({ ExportSession: { session, format: "html" } }),
	CompactSession: session => ({ CompactSession: { session } }),
	HandoffSession: session => ({ HandoffSession: { session } }),
	SetSessionMode: session => ({ SetSessionMode: { session, mode: "plan" } }),
	SelectModel: () => ({ SelectModel: { provider: "openai", model: "gpt-4o-mini" } }),
	SetThinkingLevel: () => ({ SetThinkingLevel: { level: "high" } }),
	SpawnTask: () => ({ SpawnTask: { task: "inspect the workspace" } }),
};

type DesktopState = "unopened" | "opened" | "prompted";

describe("a session a live terminal owns is never written by the desktop", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let sessionFile: string;
	let sessionId: string;
	const closers: Array<() => void> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-terminal-owned-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir, authStorage });
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();

		const sessionDir = computeDefaultSessionDir(tempDir, new FileSessionStorage(), path.join(tempDir, "sessions"));
		const existing = SessionManager.create(tempDir, sessionDir);
		existing.appendMessage({ role: "user", content: [{ type: "text", text: "Initial question" }], timestamp: 1 });
		existing.appendMessage(assistantMessage("Initial answer"));
		// A named session takes no auto-title after the desktop's first prompt, so
		// no background write lands after the terminal takes ownership.
		await existing.setSessionName("Existing session", "user");
		await existing.flush();
		sessionFile = existing.getSessionFile()!;
		sessionId = existing.getSessionId();
	});

	afterEach(async () => {
		for (const close of closers.splice(0)) close();
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Frames until the streamed reply clears, bounded so a reply that never ends fails by name. */
	async function untilStreamCleared(initialFrames?: RequestFrame[]): Promise<void> {
		if (initialFrames?.some(frame => "StreamingChanged" in frame && (frame as HostEvent).StreamingChanged === null)) return;
		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			if ("StreamingChanged" in frame && frame.StreamingChanged === null) return;
		}
		throw new Error("the streamed reply never cleared within 200 frames");
	}

	/** Wait until the reply the desktop's turn wrote is on disk, woken by the file's own writes. */
	async function untilOnDisk(text: string): Promise<void> {
		const changes = fs.watch(path.dirname(sessionFile))[Symbol.asyncIterator]();
		try {
			for (let read = 0; read < 200; read++) {
				if ((await fs.readFile(sessionFile, "utf8")).includes(text)) return;
				if ((await changes.next()).done) break;
			}
		} finally {
			await changes.return?.();
		}
		throw new Error(`the session file never recorded '${text}'`);
	}

	/** Put the desktop in `state` on the session, before any terminal owns it. */
	async function holdSession(state: DesktopState): Promise<void> {
		if (state === "unopened") return;
		const opened = await client.request(1, { OpenSession: { session: sessionId } });
		expect(opened.outcome).toEqual({ RequestSucceeded: { request: 1 } });
		if (state === "opened") return;
		const submitted = await client.request(2, {
			SubmitPrompt: { session: sessionId, text: "desktop question", attachments: [] },
		});
		expect(submitted.outcome).toEqual({ RequestSucceeded: { request: 2 } });
		await untilStreamCleared(submitted.frames);
		await untilOnDisk("desktop reply");
	}

	/** A live terminal resumes the session: the production control server publishes its discovery record. */
	async function terminalTakesOwnership(): Promise<string[]> {
		const root = path.join(tempDir, "config-root");
		vi.spyOn(utils, "getConfigRootDir").mockReturnValue(root);
		const delivered: string[] = [];
		closers.push(
			await serveTerminalControl(
				{
					identity: () => ({ sessionId, cwd: tempDir, sessionFile }),
					deliver: async text => {
						delivered.push(text);
						return "started";
					},
					abort: async () => false,
					history: () => [],
					subscribe: () => () => {},
				},
				root,
			),
		);
		return delivered;
	}

	test("every action the host classifies as reaching a session is driven here", () => {
		const reaching = Object.entries(ACTION_SESSION_REACH)
			.filter(([, reach]) => reach !== "none")
			.map(([action]) => action)
			.sort();
		expect(Object.keys(REACHES_THE_SESSION).sort()).toEqual(reaching);
	});

	for (const state of ["unopened", "opened", "prompted"] as const) {
		for (const [action, build] of Object.entries(REACHES_THE_SESSION)) {
			if (state === "unopened" && ACTION_SESSION_REACH[action as keyof typeof ACTION_SESSION_REACH] === "current")
				continue;
			test(`${action} on a session the desktop holds ${state} is refused and leaves the file untouched`, async () => {
				const stream = vi.spyOn(ai, "streamSimple").mockImplementation(() => completedStream("desktop reply"));
				await holdSession(state);
				const streamsBefore = stream.mock.calls.length;
				const delivered = await terminalTakesOwnership();
				const before = await fs.readFile(sessionFile);

				const { outcome } = (await client.request(10, build(sessionId))) as { outcome: RequestFrame };

				expect(outcome.RequestFailed?.error.message).toContain("owned by a live terminal");
				expect(await fs.readFile(sessionFile)).toEqual(before);
				expect(stream.mock.calls.length).toBe(streamsBefore);
				expect(delivered).toEqual([]);
			}, 30000);
		}
	}
});
