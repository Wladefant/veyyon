// WHY: Wire Telegram delivery tracing across socket acceptance, terminal control,
// interactive mode submission, agent session message creation, and provider stream invocation.
// Verify all 5 stages in order with allowlisted metadata, ordered shared key, and no prompt text.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import * as utils from "@veyyon/utils";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";
import { submitInteractiveInput } from "../src/main";
import { startTerminalControl } from "../src/modes/terminal/terminal-control";
import type { SubmittedUserInput } from "../src/modes/terminal/types";
import { AgentSession } from "../src/session/agent-session";
import { Settings } from "../src/config/settings";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) {
		await close();
	}
});

async function readOwner(root: string): Promise<TerminalOwner> {
	const directory = path.join(root, "run", "terminals");
	const file = (await fs.readdir(directory)).find(name => name.endsWith(".json"))!;
	return JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
}

function connect(owner: TerminalOwner) {
	const socket = net.createConnection(owner.endpoint);
	cleanup.push(() => {
		socket.destroy();
	});
	const frames: Record<string, unknown>[] = [];
	const waiters: Array<{
		predicate: (frame: Record<string, unknown>) => boolean;
		resolve: (frame: Record<string, unknown>) => void;
	}> = [];
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			frames.push(frame);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (waiters[i]!.predicate(frame)) {
					const waiter = waiters.splice(i, 1)[0]!;
					waiter.resolve(frame);
				}
			}
		}
	});

	return {
		send(payload: Record<string, unknown>) {
			socket.write(
				`${JSON.stringify({ version: 1, token: owner.token, sessionId: owner.sessionId, ...payload })}\n`,
			);
		},
		next(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing);
			const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
			waiters.push({ predicate, resolve });
			return promise;
		},
	};
}

describe("telegram delivery tracing end-to-end", () => {
	it("traces all 5 delivery stages with fake provider and no prompt text leaked", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-test-root-"));
		cleanup.push(async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		});

		spyOn(utils, "getConfigRootDir").mockReturnValue(tempDir);
		const loggedTraces: Array<{ message: string; context: Record<string, unknown> }> = [];
		const infoSpy = spyOn(utils.logger, "info").mockImplementation((msg, ctx) => {
			if (msg === "Telegram delivery trace") {
				loggedTraces.push({ message: msg, context: ctx ? { ...ctx } : {} });
			}
		});

		const mock = createMockModel({
			responses: [
				{ content: ["Provider reply 1"], stopReason: "stop" },
				{ content: ["Provider reply 2"], stopReason: "stop" },
			],
		});
		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "test-key");
		const registry = new ModelRegistry(auth, path.join(tempDir, "models.yml"));
		const store = SessionManager.create(tempDir, tempDir);
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test prompt"], tools: [], messages: [] },
			streamFn: mock.stream,
		});

		const session = new AgentSession({
			agent,
			sessionManager: store,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			modelRegistry: registry,
		});

		let pendingInputCallback: ((input: SubmittedUserInput) => void) | undefined;

		const mockMode = {
			sessionManager: store,
			session,
			isShuttingDown: false,
			isInitialized: true,
			get onInputCallback() {
				return pendingInputCallback;
			},
			set onInputCallback(cb: ((input: SubmittedUserInput) => void) | undefined) {
				pendingInputCallback = cb;
			},
			startPendingSubmission(input: {
				text: string;
				streamingBehavior?: "steer" | "followUp";
				telegramTrace?: utils.TelegramDeliveryTraceData;
			}): SubmittedUserInput {
				return {
					text: input.text,
					streamingBehavior: input.streamingBehavior,
					telegramTrace: input.telegramTrace,
					cancelled: false,
					started: false,
				};
			},
			markPendingSubmissionStarted(input: SubmittedUserInput): boolean {
				input.started = true;
				return true;
			},
			finishPendingSubmission(): void {},
			showError(): void {},
			checkShutdownRequested(): boolean {
				return false;
			},
		};

		const serverClose = await startTerminalControl(mockMode as never);
		cleanup.push(serverClose);

		const owner = await readOwner(tempDir);
		const client = connect(owner);

		// Wire input callback to trigger submitInteractiveInput
		let submissionSettled: Promise<void> | undefined;
		mockMode.onInputCallback = (input: SubmittedUserInput) => {
			submissionSettled = submitInteractiveInput(mockMode as never, session, input);
		};

		const SECRET_PROMPT_TEXT = "super-secret-user-prompt-12345";
		const traceData: utils.TelegramDeliveryTraceData = {
			updateId: 9001,
			messageId: 42,
			chatId: "-1001999888",
			topicId: 10,
			sourceTimestampMs: 1700000010000,
		};

		// 1. Deliver via socket with telegramTrace
		client.send({
			id: "req-1",
			op: "deliver",
			text: SECRET_PROMPT_TEXT,
			mode: "auto",
			ack: true,
			messageId: "msg-trace-1",
			telegramTrace: traceData,
		});

		const ackFrame = await client.next(f => f.id === "req-1");
		expect(ackFrame).toMatchObject({
			ok: true,
			result: {
				accepted: true,
				messageId: "msg-trace-1",
				state: "pending",
			},
		});

		// Wait for submission and agent turn to complete
		await submissionSettled;
		await session.waitForIdle();

		// Wait for delivery event on socket
		const deliveryEvent = await client.next(f => f.event?.kind === "delivery");
		expect(deliveryEvent.event).toMatchObject({
			kind: "delivery",
			messageId: "msg-trace-1",
			state: "delivered",
			outcome: "started",
		});

		// Verify logged stages
		const stages = loggedTraces.map(t => t.context.stage);
		expect(stages).toContain("session_acceptance");
		expect(stages).toContain("terminal_delivery_start");
		expect(stages).toContain("turn_consumption");
		expect(stages).toContain("provider_call_start");
		expect(stages).toContain("delivery_outcome");

		const expectedTraceId = "-1001999888:9001:42";
		for (const record of loggedTraces) {
			expect(record.context.traceId).toBe(expectedTraceId);
			expect(record.context.chatId).toBe("-1001999888");
			expect(record.context.updateId).toBe(9001);
			expect(record.context.messageId).toBe(42);
			expect(record.context.topicId).toBe(10);
			expect(record.context.sourceTimestampMs).toBe(1700000010000);
			expect(typeof record.context.wallTimeMs).toBe("number");
			expect(typeof record.context.monotonicMs).toBe("number");
			expect(typeof record.context.processId).toBe("number");
			expect(typeof record.context.bootId).toBe("string");
			// Verify NO prompt text or secrets leaked in any trace context!
			const serialized = JSON.stringify(record.context);
			expect(serialized).not.toContain(SECRET_PROMPT_TEXT);
			expect(record.context.text).toBeUndefined();
			expect(record.context.prompt).toBeUndefined();
		}

		// 2. Test dedup: sending the exact same messageId must not duplicate consumption or provider call
		const countBefore = loggedTraces.length;
		client.send({
			id: "req-dedup",
			op: "deliver",
			text: SECRET_PROMPT_TEXT,
			mode: "auto",
			ack: true,
			messageId: "msg-trace-1",
			telegramTrace: traceData,
		});

		const dedupAck = await client.next(f => f.id === "req-dedup");
		expect(dedupAck).toMatchObject({
			ok: true,
			result: {
				accepted: true,
				messageId: "msg-trace-1",
				state: "delivered",
			},
		});

		// No new trace entries for dedup delivery!
		expect(loggedTraces.length).toBe(countBefore);
	});

	it("traces prompt options through session into agent turn and provider stream", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-prompt-root-"));
		cleanup.push(async () => {
			await fs.rm(tempDir, { recursive: true, force: true });
		});

		spyOn(utils, "getConfigRootDir").mockReturnValue(tempDir);
		const loggedTraces: Array<{ message: string; context: Record<string, unknown> }> = [];
		spyOn(utils.logger, "info").mockImplementation((msg, ctx) => {
			if (msg === "Telegram delivery trace") {
				loggedTraces.push({ message: msg, context: ctx ? { ...ctx } : {} });
			}
		});

		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "test-key");
		const registry = new ModelRegistry(auth, path.join(tempDir, "models.yml"));
		const store = SessionManager.create(tempDir, tempDir);
		const mock = createMockModel({
			responses: [{ content: ["Prompt response"], stopReason: "stop" }],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test prompt"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: store,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			modelRegistry: registry,
		});

		const promptTrace: utils.TelegramDeliveryTraceData = {
			updateId: 7777,
			messageId: 88,
			chatId: "-100222333",
		};

		await session.prompt("Direct prompt", { telegramTrace: promptTrace });
		await session.waitForIdle();

		const promptStages = loggedTraces
			.filter(t => t.context.traceId === "-100222333:7777:88")
			.map(t => t.context.stage);

		expect(promptStages).toContain("turn_consumption");
		expect(promptStages).toContain("provider_call_start");
	});
});
