/**
 * WHY:
 *
 * When multiple GUI clients observe the same session, or when one client
 * disconnects or switches sessions, SessionManager.onEntryAppended must NOT
 * clobber other clients' listeners or wipe remaining updates.
 *
 * Before this fix:
 * 1. `sm.onEntryAppended` was a single mutable callback property. A second client
 *    observing the session overwritten the first client's callback.
 * 2. When either client disconnected, `disposeTurnSession` or `unsubscribeSession`
 *    set `sm.onEntryAppended = undefined`, destroying all other clients' listeners.
 * 3. `wireSessionManager` did not record an unsubscribe function on `ClientSessionState`,
 *    leading to leaks or clobbering during session switches.
 *
 * This suite defends:
 * 1. Multiple subscribers receive appended entries simultaneously.
 * 2. Either client disconnecting leaves remaining clients' updates intact.
 * 3. Switching sessions unsubscribes from the previous session without leaking or duplicating events.
 * 4. Disposing client state cleanly unsubscribes only its own listener.
 * 5. Single-client behavior remains intact.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../../src/session/session-manager";
import { FileSessionStorage } from "../../src/session/session-storage";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import type { GuiHostServer } from "../../src/gui-host";
import { wireSessionManager } from "../../src/gui-host/actions/active-session";
import type { ActionContext } from "../../src/gui-host/actions/types";
import {
	attachTurnListeners,
	disposeTurnSession,
	type ClientSessionState,
} from "../../src/gui-host/turns";
import type { SessionEntry } from "../../src/session/session-entries";
import { TestSocketClient, startTestGuiHostServer } from "./test-client";

describe("multiple clients observe same session without listener clobbering", () => {
	let tempDir: string;
	let storage: FileSessionStorage;
	let server: GuiHostServer | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-multi-subscriber-test-"));
		storage = new FileSessionStorage();
	});

	afterEach(async () => {
		if (server) {
			await server.close();
			server = null;
		}
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore
		}
	});

	test("SessionManager supports multiple independent subscribers", () => {
		const sm = SessionManager.create(tempDir, tempDir, storage);
		const client1Entries: SessionEntry[] = [];
		const client2Entries: SessionEntry[] = [];

		const unsub1 = sm.onEntryAppended(entry => client1Entries.push(entry));
		const unsub2 = sm.onEntryAppended(entry => client2Entries.push(entry));

		// Both receive initial append
		sm.appendMessage({ role: "user", content: "hello both", timestamp: Date.now() });
		expect(client1Entries).toHaveLength(1);
		expect(client2Entries).toHaveLength(1);

		// Disconnecting / unsubscribing client 1 leaves client 2 intact
		unsub1();
		sm.appendMessage({ role: "user", content: "hello client 2", timestamp: Date.now() });
		expect(client1Entries).toHaveLength(1);
		expect(client2Entries).toHaveLength(2);

		// Disconnecting client 2 cleans up completely
		unsub2();
		sm.appendMessage({ role: "user", content: "hello nobody", timestamp: Date.now() });
		expect(client1Entries).toHaveLength(1);
		expect(client2Entries).toHaveLength(2);
	});

	test("wireSessionManager connects two clients and disconnect leaves remaining updates intact", async () => {
		const sm = SessionManager.create(tempDir, tempDir, storage);

		const client1Frames: unknown[] = [];
		const client2Frames: unknown[] = [];

		const socket1 = {
			write: (data: string) => client1Frames.push(JSON.parse(data.trim())),
		} as unknown as net.Socket;
		const socket2 = {
			write: (data: string) => client2Frames.push(JSON.parse(data.trim())),
		} as unknown as net.Socket;

		const state1: ClientSessionState = { revision: 0 };
		const state2: ClientSessionState = { revision: 0 };

		const ctx1 = { clientState: state1, socket: socket1 } as unknown as ActionContext;
		const ctx2 = { clientState: state2, socket: socket2 } as unknown as ActionContext;

		wireSessionManager(ctx1, sm);
		wireSessionManager(ctx2, sm);

		// Both clients receive appended entries
		sm.appendMessage({ role: "user", content: "turn 1", timestamp: Date.now() });
		expect(client1Frames).toHaveLength(1);
		expect(client2Frames).toHaveLength(1);

		// Disconnect client 1
		await disposeTurnSession(state1);

		// Client 2 continues to receive appended entries intact
		sm.appendMessage({ role: "user", content: "turn 2", timestamp: Date.now() });
		expect(client1Frames).toHaveLength(1);
		expect(client2Frames).toHaveLength(2);

		// Disconnect client 2
		await disposeTurnSession(state2);

		// Subsequent append delivers to neither, no errors
		sm.appendMessage({ role: "user", content: "turn 3", timestamp: Date.now() });
		expect(client1Frames).toHaveLength(1);
		expect(client2Frames).toHaveLength(2);
	});

	test("switching sessions unsubscribes from previous session without leaking or duplicating", async () => {
		const smA = SessionManager.create(path.join(tempDir, "a"), path.join(tempDir, "a"), storage);
		const smB = SessionManager.create(path.join(tempDir, "b"), path.join(tempDir, "b"), storage);

		const receivedFrames: Array<{ TranscriptAppended?: { entries: unknown[] } }> = [];
		const socket = {
			write: (data: string) => receivedFrames.push(JSON.parse(data.trim())),
		} as unknown as net.Socket;

		const state: ClientSessionState = { revision: 0 };
		const ctx = { clientState: state, socket } as unknown as ActionContext;

		// Client wires session A
		wireSessionManager(ctx, smA);
		smA.appendMessage({ role: "user", content: "msg on A", timestamp: Date.now() });
		expect(receivedFrames).toHaveLength(1);

		// Client switches to session B
		wireSessionManager(ctx, smB);

		// Appends to session A should NOT reach client
		smA.appendMessage({ role: "user", content: "msg on A after switch", timestamp: Date.now() });
		expect(receivedFrames).toHaveLength(1);

		// Appends to session B SHOULD reach client
		smB.appendMessage({ role: "user", content: "msg on B", timestamp: Date.now() });
		expect(receivedFrames).toHaveLength(2);

		// Disconnect client
		await disposeTurnSession(state);
		smB.appendMessage({ role: "user", content: "msg on B after dispose", timestamp: Date.now() });
		expect(receivedFrames).toHaveLength(2);
	});

	test("attachTurnListeners connects two clients and disconnect leaves remaining updates intact", async () => {
		const sm = SessionManager.create(tempDir, tempDir, storage);
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		const mockAgentSession = {
			sessionManager: sm,
			subscribe: (l: (event: AgentSessionEvent) => void) => {
				listeners.add(l);
				return () => listeners.delete(l);
			},
			dispose: async () => {},
		} as unknown as AgentSession;

		const client1Frames: unknown[] = [];
		const client2Frames: unknown[] = [];

		const socket1 = {
			write: (data: string) => client1Frames.push(JSON.parse(data.trim())),
		} as unknown as net.Socket;
		const socket2 = {
			write: (data: string) => client2Frames.push(JSON.parse(data.trim())),
		} as unknown as net.Socket;

		const state1: ClientSessionState = { revision: 0, agentSession: mockAgentSession };
		const state2: ClientSessionState = { revision: 0, agentSession: mockAgentSession };

		attachTurnListeners(mockAgentSession, socket1, state1);
		attachTurnListeners(mockAgentSession, socket2, state2);

		sm.appendMessage({ role: "user", content: "shared turn update 1", timestamp: Date.now() });
		expect(client1Frames).toHaveLength(1);
		expect(client2Frames).toHaveLength(1);

		// Disconnect client 1
		await disposeTurnSession(state1);

		// Client 2 continues to receive updates intact
		sm.appendMessage({ role: "user", content: "shared turn update 2", timestamp: Date.now() });
		expect(client1Frames).toHaveLength(1);
		expect(client2Frames).toHaveLength(2);

		// Disconnect client 2
		await disposeTurnSession(state2);

		sm.appendMessage({ role: "user", content: "shared turn update 3", timestamp: Date.now() });
		expect(client1Frames).toHaveLength(1);
		expect(client2Frames).toHaveLength(2);
	});

	test("real server path: two live TCP clients open same session, append via action, and disconnect leaves updates intact", async () => {
		const sessionDir = path.join(tempDir, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		await sm.ensureOnDisk();
		const sessionPath = sm.getSessionFile()!;

		server = await startTestGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir });
		const client1 = await TestSocketClient.connect(server.endpoint);
		const client2 = await TestSocketClient.connect(server.endpoint);

		// Drain greetings and initial snapshots
		await client1.nextFrame();
		await client1.nextFrame();
		await client2.nextFrame();
		await client2.nextFrame();

		// Both clients open the same session
		const res1 = await client1.request(1, { OpenSession: { session: sessionPath } });
		expect(res1.outcome.RequestSucceeded).toBeDefined();

		const res2 = await client2.request(2, { OpenSession: { session: sessionPath } });
		expect(res2.outcome.RequestSucceeded).toBeDefined();

		// Client 1 renames session (real server action that appends a title_change entry)
		const renameRes1 = await client1.request(3, { RenameSession: { session: sessionPath, title: "Renamed Title 1" } });
		expect(renameRes1.outcome.RequestSucceeded).toBeDefined();
		expect(renameRes1.frames.some(f => "TranscriptAppended" in f)).toBe(true);

		// Client 2 receives TranscriptAppended frame for Client 1's action
		const f2 = (await client2.nextFrame()) as Record<string, unknown>;
		expect(f2.TranscriptAppended).toBeDefined();

		// Client 1 disconnects
		client1.destroy();
		await client1.waitForClose();

		// Client 2 renames session (second real server action)
		const renameRes2 = await client2.request(4, { RenameSession: { session: sessionPath, title: "Renamed Title 2" } });
		expect(renameRes2.outcome.RequestSucceeded).toBeDefined();
		expect(renameRes2.frames.some(f => "TranscriptAppended" in f)).toBe(true);

		client2.destroy();
		await client2.waitForClose();
	});
});
