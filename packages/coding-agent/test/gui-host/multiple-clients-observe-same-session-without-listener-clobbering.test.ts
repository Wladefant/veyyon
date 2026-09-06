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
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import { wireSessionManager } from "../../src/gui-host/actions/active-session";
import type { ActionContext } from "../../src/gui-host/actions/types";
import {
	attachTurnListeners,
	disposeClientState,
	disposeTurnSession,
	type ClientSessionState,
} from "../../src/gui-host/turns";
import type { SessionEntry } from "../../src/session/session-entries";
import { TestSocketClient } from "./test-client";

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

	test("end-to-end: two live TCP clients observe same session and one disconnects", async () => {
		const sessionDir = path.join(tempDir, "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sm = SessionManager.create(tempDir, sessionDir, storage);
		await sm.ensureOnDisk();
		const sessionPath = sm.getSessionFile()!;

		server = await startGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir, agentDir: tempDir });
		const client1 = await TestSocketClient.connect(server.endpoint);
		const client2 = await TestSocketClient.connect(server.endpoint);

		// Drain greetings and initial snapshots
		await client1.nextFrame(); // Greeting
		await client1.nextFrame(); // Capabilities
		await client2.nextFrame(); // Greeting
		await client2.nextFrame(); // Capabilities

		// Client 1 opens session
		const res1 = await client1.request(1, { OpenSession: { session: sessionPath } });
		expect(res1.outcome.RequestSucceeded).toBeDefined();

		// Client 2 opens same session
		const res2 = await client2.request(2, { OpenSession: { session: sessionPath } });
		expect(res2.outcome.RequestSucceeded).toBeDefined();

		// Append an entry to the shared session file
		sm.appendMessage({ role: "user", content: "shared update 1", timestamp: Date.now() });

		// Both client 1 and client 2 receive TranscriptAppended
		const frame1 = (await client1.nextFrame()) as Record<string, unknown>;
		const frame2 = (await client2.nextFrame()) as Record<string, unknown>;

		expect(frame1.TranscriptAppended).toBeDefined();
		expect(frame2.TranscriptAppended).toBeDefined();

		// Client 1 disconnects
		client1.destroy();
		await client1.waitForClose();


		// Append another entry to the shared session
		sm.appendMessage({ role: "user", content: "shared update 2", timestamp: Date.now() });

		// Client 2 still receives the update intact!
		const frame3 = (await client2.nextFrame()) as Record<string, unknown>;
		expect(frame3.TranscriptAppended).toBeDefined();

		client2.destroy();
	});
});
