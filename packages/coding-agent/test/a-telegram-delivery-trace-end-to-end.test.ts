// WHY: Wire Telegram delivery tracing across socket acceptance, terminal control,
// interactive mode submission, agent session message creation, and provider stream invocation.
// Verify all 5 stages in order with allowlisted metadata, ordered shared key, and no prompt text.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import * as utils from "@veyyon/utils";
import { type as arkType } from "arktype";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";
import { submitInteractiveInput } from "../src/main";
import { startTerminalControl } from "../src/modes/terminal/terminal-control";
import type { SubmittedUserInput } from "../src/modes/terminal/types";
import { AgentSession } from "../src/session/agent-session";

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

	interface DeliveryEventFrame {
		event: {
			kind: "delivery";
			messageId?: string;
			state?: string;
			outcome?: string;
			[key: string]: unknown;
		};
		[key: string]: unknown;
	}

	function isDeliveryEvent(frame: Record<string, unknown>, messageId?: string): frame is DeliveryEventFrame {
		const event = frame.event;
		if (typeof event !== "object" || event === null) return false;
		const record = event as Record<string, unknown>;
		if (record.kind !== "delivery") return false;
		if (messageId !== undefined && record.messageId !== messageId) return false;
		return true;
	}
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
		next<T = Record<string, unknown>>(predicate: (frame: Record<string, unknown>) => boolean): Promise<T> {
			const existing = frames.find(predicate);
			if (existing) return Promise.resolve(existing as unknown as T);
			const { promise, resolve } = Promise.withResolvers<T>();
			waiters.push({ predicate, resolve: resolve as (frame: Record<string, unknown>) => void });
			return promise;
		},
		isDeliveryEvent,
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
		spyOn(utils.logger, "info").mockImplementation((msg, ctx) => {
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
			sessionId: "fake-provider-session-id",
		});

		const session = new AgentSession({
			agent,
			sessionManager: store,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			modelRegistry: registry,
			providerSessionId: "fake-provider-session-id",
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
		const deliveryEvent = await client.next<
			Parameters<typeof client.isDeliveryEvent>[0] & {
				event: { kind: "delivery"; messageId: string; state: string; outcome: string };
			}
		>(f => client.isDeliveryEvent(f));
		expect(deliveryEvent.event).toMatchObject({
			kind: "delivery",
			messageId: "msg-trace-1",
			state: "delivered",
			outcome: "started",
		});

		// Verify logged stages and exact order
		const stages = loggedTraces.map(t => t.context.stage);
		const acceptanceIdx = stages.indexOf("session_acceptance");
		const deliveryStartIdx = stages.indexOf("terminal_delivery_start");
		const consumptionIdx = stages.indexOf("turn_consumption");
		const providerStartIdx = stages.indexOf("provider_call_start");
		const deliveryOutcomeIdx = stages.indexOf("delivery_outcome");

		expect(acceptanceIdx).toBeGreaterThanOrEqual(0);
		expect(deliveryStartIdx).toBeGreaterThan(acceptanceIdx);
		expect(consumptionIdx).toBeGreaterThan(deliveryStartIdx);
		expect(providerStartIdx).toBeGreaterThan(consumptionIdx);
		expect(deliveryOutcomeIdx).toBeGreaterThan(deliveryStartIdx);
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
			expect(record.context.sessionId).toBe(store.getSessionId());
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

	it("traces streaming steer and followUp with exact-turn attribution and strict order", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-streaming-root-"));
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

		const { promise: toolRunning, resolve: signalToolRunning } = Promise.withResolvers<void>();
		const { promise: canFinishTool, resolve: signalFinishTool } = Promise.withResolvers<void>();

		const probeTool: AgentTool = {
			name: "probe",
			label: "probe",
			description: "test probe tool",
			parameters: arkType({}),
			execute: async () => {
				signalToolRunning();
				await canFinishTool;
				return { content: [{ type: "text" as const, text: "probe complete" }] };
			},
		} as unknown as AgentTool;

		const auth = await AuthStorage.create(path.join(tempDir, "auth.db"));
		auth.setRuntimeApiKey("mock", "test-key");
		const registry = new ModelRegistry(auth, path.join(tempDir, "models.yml"));
		const store = SessionManager.create(tempDir, tempDir);
		const mock = createMockModel({
			responses: [
				// Turn 1 step 1: call probe tool
				{
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "probe",
							arguments: {},
						},
					],
					stopReason: "toolUse",
				},
				// Turn 1 step 2 (after tool + steer): reply to steer
				{ content: ["Steered step reply"], stopReason: "stop" },
				// Turn 2: reply to followUp
				{ content: ["FollowUp turn reply"], stopReason: "stop" },
			],
		});

		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test prompt"], tools: [probeTool], messages: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: store,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
			modelRegistry: registry,
			toolRegistry: new Map([["probe", probeTool as never]]),
			providerSessionId: "fake-provider-turn-session-id",
		});

		const mockMode = {
			sessionManager: store,
			session,
			isShuttingDown: false,
			isInitialized: true,
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
		};

		const serverClose = await startTerminalControl(mockMode as never);
		cleanup.push(serverClose);

		const owner = await readOwner(tempDir);
		const client = connect(owner);

		// Start initial prompt
		const promptPromise = session.prompt("Initial task");

		// Wait until probe tool is actively executing (streaming is guaranteed true)
		await toolRunning;
		expect(session.isStreaming).toBe(true);

		const steerTrace: utils.TelegramDeliveryTraceData = {
			updateId: 7001,
			messageId: 101,
			chatId: "-100222333",
		};
		const followUpTrace: utils.TelegramDeliveryTraceData = {
			updateId: 7002,
			messageId: 102,
			chatId: "-100222333",
		};

		// 1. Deliver steer via socket while streaming
		client.send({
			id: "req-steer",
			op: "deliver",
			text: "Steer now",
			mode: "steer",
			ack: true,
			messageId: "msg-steer-1",
			telegramTrace: steerTrace,
		});

		const steerAck = await client.next(f => f.id === "req-steer");
		expect(steerAck).toMatchObject({
			ok: true,
			result: { accepted: true, messageId: "msg-steer-1" },
		});

		// 2. Deliver followUp via socket while streaming
		client.send({
			id: "req-followup",
			op: "deliver",
			text: "Follow up next",
			mode: "followUp",
			ack: true,
			messageId: "msg-followup-1",
			telegramTrace: followUpTrace,
		});

		const followUpAck = await client.next(f => f.id === "req-followup");
		expect(followUpAck).toMatchObject({
			ok: true,
			result: { accepted: true, messageId: "msg-followup-1" },
		});

		// Release the tool execution now
		signalFinishTool();

		// Wait for initial prompt and follow-up continuation turn to settle
		await promptPromise;
		await session.waitForIdle();

		// Verify delivery events on socket
		const steerDeliveryEvent = await client.next<{
			event: { kind: "delivery"; messageId: string; state: string; outcome: string };
		}>(f => client.isDeliveryEvent(f, "msg-steer-1"));
		expect(steerDeliveryEvent.event).toMatchObject({
			kind: "delivery",
			messageId: "msg-steer-1",
			state: "delivered",
			outcome: "steered",
		});

		const followUpDeliveryEvent = await client.next<{
			event: { kind: "delivery"; messageId: string; state: string; outcome: string };
		}>(f => client.isDeliveryEvent(f, "msg-followup-1"));
		expect(followUpDeliveryEvent.event).toMatchObject({
			kind: "delivery",
			messageId: "msg-followup-1",
			state: "delivered",
			outcome: "queued",
		});

		// Exact lifecycle order checks
		const steerRecords = loggedTraces.filter(t => t.context.traceId === "-100222333:7001:101");
		const followUpRecords = loggedTraces.filter(t => t.context.traceId === "-100222333:7002:102");

		const steerStages = steerRecords.map(t => t.context.stage);
		const followUpStages = followUpRecords.map(t => t.context.stage);

		// Core order: session_acceptance -> terminal_delivery_start -> turn_consumption -> provider_call_start
		expect(steerStages.indexOf("session_acceptance")).toBeGreaterThanOrEqual(0);
		expect(steerStages.indexOf("terminal_delivery_start")).toBeGreaterThan(steerStages.indexOf("session_acceptance"));
		expect(steerStages.indexOf("turn_consumption")).toBeGreaterThan(steerStages.indexOf("terminal_delivery_start"));
		expect(steerStages.indexOf("provider_call_start")).toBeGreaterThan(steerStages.indexOf("turn_consumption"));
		expect(steerStages).toContain("delivery_outcome");

		expect(followUpStages.indexOf("session_acceptance")).toBeGreaterThanOrEqual(0);
		expect(followUpStages.indexOf("terminal_delivery_start")).toBeGreaterThan(
			followUpStages.indexOf("session_acceptance"),
		);
		expect(followUpStages.indexOf("turn_consumption")).toBeGreaterThan(
			followUpStages.indexOf("terminal_delivery_start"),
		);
		expect(followUpStages.indexOf("provider_call_start")).toBeGreaterThan(followUpStages.indexOf("turn_consumption"));
		expect(followUpStages).toContain("delivery_outcome");

		// Exact-turn attribution: steer was consumed during turn 1, followUp was consumed during turn 2
		const steerConsumptionIdx = loggedTraces.findIndex(
			t => t.context.traceId === "-100222333:7001:101" && t.context.stage === "turn_consumption",
		);
		const followUpConsumptionIdx = loggedTraces.findIndex(
			t => t.context.traceId === "-100222333:7002:102" && t.context.stage === "turn_consumption",
		);
		expect(steerConsumptionIdx).toBeGreaterThanOrEqual(0);
		expect(followUpConsumptionIdx).toBeGreaterThan(steerConsumptionIdx);
		for (const record of [...steerRecords, ...followUpRecords]) {
			expect(record.context.sessionId).toBe(store.getSessionId());
		}
	});

	it("withholds hostile thrown error text, user prompt, and secrets when target.deliver throws", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trace-hostile-root-"));
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

		const hostileToken = "secret-token-sk-ant-live-XYZ123456";
		const hostilePrompt = "DROP DATABASE users; -- sensitive instruction";
		const hostileError = new Error(`Connection failed for prompt: "${hostilePrompt}" with auth "${hostileToken}"`);

		const target = {
			identity: () => ({
				sessionId: "sess-hostile",
				cwd: tempDir,
				sessionFile: path.join(tempDir, "session.jsonl"),
			}),
			deliver: async () => {
				throw hostileError;
			},
			abort: async () => true,
			history: () => [],
			subscribe: () => () => {},
		};

		const serverClose = await serveTerminalControl(target, tempDir);
		cleanup.push(serverClose);

		const owner = await readOwner(tempDir);
		const client = connect(owner);

		const hostileTrace: utils.TelegramDeliveryTraceData = {
			updateId: 9999,
			messageId: 55,
			chatId: "-100888",
		};

		client.send({
			id: "req-hostile",
			op: "deliver",
			text: hostilePrompt,
			mode: "auto",
			ack: true,
			messageId: "msg-hostile-1",
			telegramTrace: hostileTrace,
		});

		const replyFrame = await client.next(f => f.id === "req-hostile");
		expect(replyFrame).toMatchObject({
			ok: true,
			result: {
				accepted: true,
				messageId: "msg-hostile-1",
				state: "pending",
			},
		});

		const deliveryEvent = await client.next<{
			event: { kind: "delivery"; messageId: string; state: string; outcome: string };
		}>(f => client.isDeliveryEvent(f, "msg-hostile-1"));
		expect(deliveryEvent.event).toMatchObject({
			kind: "delivery",
			messageId: "msg-hostile-1",
			state: "failed",
		});

		// Verify that logged trace for delivery_outcome exists and withholds prompt/secret/error
		const outcomeRecords = loggedTraces.filter(
			t => t.context.traceId === "-100888:9999:55" && t.context.stage === "delivery_outcome",
		);
		expect(outcomeRecords.length).toBe(1);
		const outcomeRecord = outcomeRecords[0];
		expect(outcomeRecord).toBeDefined();
		if (!outcomeRecord) throw new Error("Expected outcomeRecord");
		const serialized = JSON.stringify(outcomeRecord.context);
		expect(serialized).not.toContain(hostileToken);
		expect(serialized).not.toContain(hostilePrompt);
		expect(serialized).not.toContain(hostileError.message);
		expect(outcomeRecord.context.error).toBeUndefined();
		expect(outcomeRecord.context.outcome).toBe("failed");
		expect(outcomeRecord.context.sessionId).toBe("sess-hostile");
	});
});
