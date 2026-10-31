import * as crypto from "node:crypto";
import * as logger from "./logger";

export interface TelegramDeliveryTraceData {
	updateId: number;
	messageId: number;
	chatId: string;
	topicId?: number;
	sourceTimestampMs?: number;
}

export type TelegramDeliveryTraceStage =
	| "session_acceptance"
	| "terminal_delivery_start"
	| "turn_consumption"
	| "provider_call_start"
	| "delivery_outcome";

export type TelegramDeliveryOutcome =
	| "started"
	| "steered"
	| "queued"
	| "failed"
	| "rejected"
	| "duplicate";

export function normalizeDeliveryOutcome(outcome: unknown): TelegramDeliveryOutcome {
	if (
		outcome === "started" ||
		outcome === "steered" ||
		outcome === "queued" ||
		outcome === "rejected" ||
		outcome === "duplicate"
	) {
		return outcome;
	}
	return "failed";
}

const BOOT_ID = crypto.randomUUID();

export function computeTelegramTraceId(trace: TelegramDeliveryTraceData): string {
	return `${trace.chatId}:${trace.updateId}:${trace.messageId}`;
}

const TELEGRAM_CHAT_ID_PATTERN = /^-?[1-9]\d{0,18}$/;

export function parseTelegramTrace(value: unknown): TelegramDeliveryTraceData | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.updateId !== "number" || !Number.isSafeInteger(candidate.updateId) || candidate.updateId <= 0) {
		return undefined;
	}
	if (
		typeof candidate.messageId !== "number" ||
		!Number.isSafeInteger(candidate.messageId) ||
		candidate.messageId <= 0
	) {
		return undefined;
	}
	if (
		typeof candidate.chatId !== "string" ||
		!TELEGRAM_CHAT_ID_PATTERN.test(candidate.chatId) ||
		!Number.isSafeInteger(Number(candidate.chatId))
	) {
		return undefined;
	}

	let topicId: number | undefined;
	if (candidate.topicId !== undefined) {
		if (typeof candidate.topicId !== "number" || !Number.isSafeInteger(candidate.topicId) || candidate.topicId <= 0) {
			return undefined;
		}
		topicId = candidate.topicId;
	}

	let sourceTimestampMs: number | undefined;
	if (candidate.sourceTimestampMs !== undefined) {
		if (
			typeof candidate.sourceTimestampMs !== "number" ||
			!Number.isSafeInteger(candidate.sourceTimestampMs) ||
			candidate.sourceTimestampMs <= 0
		) {
			return undefined;
		}
		sourceTimestampMs = candidate.sourceTimestampMs;
	}

	return {
		updateId: candidate.updateId,
		messageId: candidate.messageId,
		chatId: candidate.chatId,
		...(topicId !== undefined ? { topicId } : {}),
		...(sourceTimestampMs !== undefined ? { sourceTimestampMs } : {}),
	};
}

export function logTelegramDeliveryTrace(
	trace: TelegramDeliveryTraceData,
	details: {
		stage: TelegramDeliveryTraceStage;
		sessionId?: string;
		outcome?: TelegramDeliveryOutcome;
	},
): void {
	const context: Record<string, unknown> = {
		traceId: computeTelegramTraceId(trace),
		updateId: trace.updateId,
		messageId: trace.messageId,
		chatId: trace.chatId,
		stage: details.stage,
		wallTimeMs: Date.now(),
		monotonicMs: performance.now(),
		processId: process.pid,
		bootId: BOOT_ID,
	};
	if (trace.topicId !== undefined) {
		context.topicId = trace.topicId;
	}
	if (trace.sourceTimestampMs !== undefined) {
		context.sourceTimestampMs = trace.sourceTimestampMs;
	}
	if (details.sessionId !== undefined) {
		context.sessionId = details.sessionId;
	}
	if (details.outcome !== undefined) {
		context.outcome = details.outcome;
	}

	logger.info("Telegram delivery trace", context);
}

export interface ConsumedTelegramTrace {
	trace: TelegramDeliveryTraceData;
	sessionId?: string;
}

interface TelegramTraceMetadata {
	trace: TelegramDeliveryTraceData;
	sessionId?: string;
}

const traceMap = new WeakMap<object, TelegramTraceMetadata>();
const consumedSet = new WeakSet<object>();

export function attachTelegramTrace(message: object, trace: TelegramDeliveryTraceData, sessionId?: string): void {
	traceMap.set(message, { trace, sessionId });
}

export function getTelegramTrace(message: object): TelegramDeliveryTraceData | undefined {
	return traceMap.get(message)?.trace;
}

export function getTelegramTraceSessionId(message: object): string | undefined {
	return traceMap.get(message)?.sessionId;
}

export function transferTelegramTrace(source: object, target: object): void {
	const metadata = traceMap.get(source);
	if (metadata) {
		traceMap.set(target, metadata);
		if (consumedSet.has(source)) {
			consumedSet.add(target);
		}
	}
}

export function consumeTelegramTrace(message: object, fallbackSessionId?: string): ConsumedTelegramTrace | undefined {
	const metadata = traceMap.get(message);
	if (!metadata) {
		return undefined;
	}
	if (consumedSet.has(message)) {
		return undefined;
	}
	consumedSet.add(message);
	const effectiveSessionId = metadata.sessionId ?? fallbackSessionId;
	logTelegramDeliveryTrace(metadata.trace, {
		stage: "turn_consumption",
		sessionId: effectiveSessionId,
	});
	return { trace: metadata.trace, sessionId: effectiveSessionId };
}
