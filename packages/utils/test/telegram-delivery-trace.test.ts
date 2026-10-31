import { describe, expect, it, spyOn } from "bun:test";
import * as logger from "../src/logger";
import {
	attachTelegramTrace,
	computeTelegramTraceId,
	consumeTelegramTrace,
	getTelegramTrace,
	logTelegramDeliveryTrace,
	parseTelegramTrace,
	transferTelegramTrace,
	type TelegramDeliveryTraceData,
} from "../src/telegram-delivery-trace";

describe("telegram-delivery-trace", () => {
	it("computes traceId as chatId:updateId:messageId", () => {
		const trace: TelegramDeliveryTraceData = {
			chatId: "-100123456",
			updateId: 987,
			messageId: 42,
		};
		expect(computeTelegramTraceId(trace)).toBe("-100123456:987:42");
	});

	it("parses valid wire metadata and allowlists fields only", () => {
		const parsed = parseTelegramTrace({
			updateId: 101,
			messageId: 202,
			chatId: "-100123456",
			topicId: 5,
			sourceTimestampMs: 1700000000000,
			extraField: "should-be-stripped",
			text: "secret user text",
		});
		expect(parsed).toEqual({
			updateId: 101,
			messageId: 202,
			chatId: "-100123456",
			topicId: 5,
			sourceTimestampMs: 1700000000000,
		});
		const parsedRecord = parsed as unknown as Record<string, unknown>;
		expect(parsedRecord.extraField).toBeUndefined();
		expect(parsedRecord.text).toBeUndefined();
	});

	it("rejects invalid wire metadata, malformed numeric IDs, and non-numeric chat IDs", () => {
		expect(parseTelegramTrace(null)).toBeUndefined();
		expect(parseTelegramTrace(undefined)).toBeUndefined();
		expect(parseTelegramTrace("invalid")).toBeUndefined();
		expect(parseTelegramTrace({ updateId: "not-a-number", messageId: 1, chatId: "-1001" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: "not-a-number", chatId: "-1001" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: 123 })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "not-numeric" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "<script>" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "0" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "123.456" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "99999999999999999999999" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 0, messageId: 1, chatId: "-1001" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: -1, messageId: 1, chatId: "-1001" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1.5, messageId: 1, chatId: "-1001" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 0, chatId: "-1001" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: -5, chatId: "-1001" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "-1001", topicId: "bad" })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "-1001", topicId: 0 })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "-1001", topicId: -1 })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "-1001", sourceTimestampMs: NaN })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "-1001", sourceTimestampMs: 0 })).toBeUndefined();
		expect(parseTelegramTrace({ updateId: 1, messageId: 2, chatId: "-1001", sourceTimestampMs: -100 })).toBeUndefined();
	});

	it("logs fixed message with allowlisted metadata and never leaks prompt text", () => {
		const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
		try {
			const trace: TelegramDeliveryTraceData = {
				chatId: "-100777",
				updateId: 505,
				messageId: 12,
				topicId: 99,
				sourceTimestampMs: 1700000005000,
			};
			logTelegramDeliveryTrace(trace, {
				stage: "session_acceptance",
				sessionId: "sess-abc",
			});

			expect(infoSpy).toHaveBeenCalledTimes(1);
			const [message, context] = infoSpy.mock.calls[0];
			expect(message).toBe("Telegram delivery trace");
			expect(context).toMatchObject({
				traceId: "-100777:505:12",
				chatId: "-100777",
				updateId: 505,
				messageId: 12,
				topicId: 99,
				sourceTimestampMs: 1700000005000,
				stage: "session_acceptance",
				sessionId: "sess-abc",
			});
			expect(typeof context.wallTimeMs).toBe("number");
			expect(typeof context.monotonicMs).toBe("number");
			expect(typeof context.processId).toBe("number");
			expect(typeof context.bootId).toBe("string");
			expect(context.text).toBeUndefined();
			expect(context.prompt).toBeUndefined();
			expect(context.token).toBeUndefined();
			expect(context.error).toBeUndefined();
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("withholds hostile thrown error text, user prompt, and secrets from delivery outcome trace", () => {
		const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
		try {
			const trace: TelegramDeliveryTraceData = {
				chatId: "-100888",
				updateId: 999,
				messageId: 44,
			};
			const hostileToken = "secret-token-sk-ant-live-XYZ123456";
			const hostilePrompt = "DROP DATABASE users; -- sensitive instruction";
			const hostileError = new Error(`Connection failed for prompt: "${hostilePrompt}" with auth "${hostileToken}"`);

			// Delivery failure records closed literal outcome only, NEVER arbitrary error message
			logTelegramDeliveryTrace(trace, {
				stage: "delivery_outcome",
				sessionId: "sess-hostile",
				outcome: "failed",
			});

			expect(infoSpy).toHaveBeenCalledTimes(1);
			const [message, context] = infoSpy.mock.calls[0];
			expect(message).toBe("Telegram delivery trace");
			expect(context.stage).toBe("delivery_outcome");
			expect(context.outcome).toBe("failed");

			const serializedContext = JSON.stringify(context);
			expect(serializedContext).not.toContain(hostileToken);
			expect(serializedContext).not.toContain(hostilePrompt);
			expect(serializedContext).not.toContain(hostileError.message);
			expect(context.error).toBeUndefined();
		} finally {
			infoSpy.mockRestore();
		}
	});

	it("attaches, transfers on copy, and consumes trace exactly once", () => {
		const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
		try {
			const trace: TelegramDeliveryTraceData = {
				chatId: "c1",
				updateId: 1,
				messageId: 2,
			};
			const msg1 = { role: "user", content: "hello" };
			attachTelegramTrace(msg1, trace);
			expect(getTelegramTrace(msg1)).toEqual(trace);

			const msgCopy = { ...msg1 };
			transferTelegramTrace(msg1, msgCopy);
			expect(getTelegramTrace(msgCopy)).toEqual(trace);

			// First consume logs turn_consumption
			const consumed = consumeTelegramTrace(msgCopy, "session-123");
			expect(consumed).toEqual(trace);
			expect(infoSpy).toHaveBeenCalledTimes(1);
			expect(infoSpy.mock.calls[0][0]).toBe("Telegram delivery trace");
			expect(infoSpy.mock.calls[0][1]).toMatchObject({
				stage: "turn_consumption",
				traceId: "c1:1:2",
				sessionId: "session-123",
			});

			// Second consume on same or copied message does not log again
			const second = consumeTelegramTrace(msgCopy, "session-123");
			expect(second).toBeUndefined();
			expect(infoSpy).toHaveBeenCalledTimes(1);
		} finally {
			infoSpy.mockRestore();
		}
	});
});
