/**
 * WHY: destructive or decision-bearing controls carry the session the operator
 * saw when clicking them. A stale native surface must not apply that control to
 * whichever session this socket opened most recently, and rejected controls
 * must not mutate the active session or create another one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GuiHostServer } from "../../src/gui-host";
import { type RequestFrame, TestSocketClient, startTestGuiHostServer } from "./test-client";

function snapshot<T>(frames: RequestFrame[], section: string): T | undefined {
	for (const frame of frames) {
		const value = frame.Snapshot?.[section];
		if (value !== undefined) return value as T;
	}
	return undefined;
}

describe("session-scoped GUI controls", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-session-control-test-"));
		server = await startTestGuiHostServer({ endpoint: "tcp:127.0.0.1:0", cwd: tempDir });
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		client.destroy();
		if (server) await server.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("stale controls are denied without changing the active session", async () => {
		const first = await client.request(1, { CreateSession: { title: "First" } });
		const firstId = snapshot<{ value: { id: string } }>(first.frames, "ActiveSession")?.value.id;
		const second = await client.request(2, { CreateSession: { title: "Second" } });
		const secondId = snapshot<{ value: { id: string } }>(second.frames, "ActiveSession")?.value.id;
		if (!firstId || !secondId) throw new Error("created sessions did not carry ids");

		const staleActions: Array<[unknown, string]> = [
			[{ AbortTurn: { session: firstId } }, "Session"],
			[{ SetQueueMode: { session: firstId, mode: "Queue" } }, "Session"],
			[{ CancelTool: { session: firstId, tool_call_id: "tool-1" } }, "Tool"],
			[
				{ RespondToInteraction: { session: firstId, interaction_id: "approval-1", response: { approved: true } } },
				"Interaction",
			],
			[{ ClearOutput: { session: firstId } }, "Session"],
			[{ GetUsage: { session: firstId } }, "Usage"],
			[{ GetContextBreakdown: { session: firstId } }, "Diagnostic"],
		];

		for (const [index, [action, scope]] of staleActions.entries()) {
			const result = await client.request(10 + index, action);
			expect(result.frames).toHaveLength(1);
			expect(result.outcome.RequestFailed?.error).toMatchObject({
				scope,
				code: "SESSION_NOT_ACTIVE",
				retryable: false,
			});
		}

		const allowed = await client.request(30, { SetQueueMode: { session: secondId, mode: "Queue" } });
		expect(allowed.outcome).toEqual({ RequestSucceeded: { request: 30 } });

		const renamed = await client.request(31, {
			RenameSession: { session: secondId, title: "Still Active" },
		});
		expect(renamed.outcome).toEqual({ RequestSucceeded: { request: 31 } });
		expect(snapshot<{ value: { id: string; title: string } }>(renamed.frames, "ActiveSession")?.value).toMatchObject({
			id: secondId,
			title: "Still Active",
		});
		const sessions = snapshot<[{ value: Array<{ id: string }> }, unknown[]]>(renamed.frames, "Sessions");
		expect(sessions?.[0].value).toHaveLength(2);
	});

	test("a malformed session-scoped control is answered instead of hanging", async () => {
		const result = await client.request(1, { AbortTurn: {} });
		expect(result.frames).toHaveLength(1);
		expect(result.outcome.RequestFailed?.error).toMatchObject({
			scope: "Session",
			code: "INVALID_ARGUMENTS",
			retryable: false,
		});
	});

	test("an unauthenticated client receives no snapshots or action access", async () => {
		if (!server) throw new Error("server not started");
		const unauthorized = await TestSocketClient.connect(server.endpoint, "wrong-token");
		await unauthorized.waitForClose();
		await expect(unauthorized.nextFrame()).rejects.toThrow("Socket is closed");
		unauthorized.destroy();
	});
});
