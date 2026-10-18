import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	estimateCompactionRequestTokens,
	measureSummarySource,
	SUMMARY_TRANSCRIPT_GLUE_BYTES,
	stagedSegmentBudget,
} from "@veyyon/agent-core/compaction";
import * as compactionUtils from "@veyyon/agent-core/compaction/utils";
import type { AssistantMessage, Context, Message, Model } from "@veyyon/ai";
import { DIALECTS } from "@veyyon/catalog/identity";
import { getBundledModel } from "@veyyon/catalog/models";
import { TIME_SLICE_MS } from "@veyyon/utils";

/**
 * Planning a history summary never serializes the whole span in one event-loop turn when the
 * span cannot be sent as one request, and it decides between one request and stages exactly as
 * the exact count of the one request decides.
 *
 * WHY. Planning a summary serialized the whole span synchronously, once as the single request's
 * conversation and once message by message for the staged plan, and the candidate estimate and
 * the summary each planned again. A resumed session summarizing 20,510 messages held the event
 * loop for about 200ms per plan, so the terminal drew nothing and read no key while compaction
 * prepared its request. The class is any O(span) synchronous pass in the plan. The plan now
 * measures the span message by message in slices, and stages a span whose byte floor already
 * exceeds the window without building its joined text. The floor is sound only if joining
 * messages never removes more than `SUMMARY_TRANSCRIPT_GLUE_BYTES` per message, in every dialect.
 *
 * Covered: the floor never exceeds the joined transcript, for every dialect `DIALECTS` lists at
 * run time and for the plain transcript, including spans whose useless tool results the joined
 * transcript drops; the floor stays within a fixed distance of the joined transcript, so it is not
 * a floor of zero; the estimate and the summary of a span past the window serialize at most one
 * segment per event-loop turn; and a span is staged exactly when its single request exceeds the
 * window.
 *
 * Does not catch: a span that fits the window, which is serialized whole in one turn because
 * that text is the request it sends; the `convertToLlm` pass over the span, which is synchronous;
 * a dialect whose framing per message exceeds the glue only on a shape the corpus below lacks.
 */

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, timestamp: 2, provider: "m", model: "m", api: "m", usage, stopReason: "stop" };
}

let shapeSeries = 0;

/**
 * One message of each shape a transcript renders differently, with fresh tool-call ids. The
 * second call's result is useless, so a span holding both drops the call and the result.
 */
function shapes(): Message[] {
	shapeSeries += 1;
	const id = `call-${shapeSeries}`;
	const uselessId = `call-${shapeSeries}-useless`;
	const long = `line of output ${shapeSeries} `.repeat(40);
	const wide = "é漢字 ".repeat(120);
	return [
		{ role: "user", content: [{ type: "text", text: `prompt ${shapeSeries}` }], timestamp: 1 },
		{ role: "user", content: long, timestamp: 1 },
		{ role: "user", content: "", timestamp: 1 },
		{ role: "developer", content: [{ type: "text", text: `note ${shapeSeries}` }], timestamp: 1 },
		{ role: "developer", content: "", timestamp: 1 },
		assistant([{ type: "text", text: wide }]),
		assistant([]),
		assistant([{ type: "thinking", thinking: long }]),
		assistant([
			{ type: "text", text: "calling" },
			{ type: "toolCall", id, name: "bash", arguments: { command: long } },
			{ type: "toolCall", id: uselessId, name: "read", arguments: { path: wide } },
		]),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: long }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: wide }],
			isError: true,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: uselessId,
			toolName: "read",
			content: [{ type: "text", text: wide }],
			isError: false,
			useless: true,
			timestamp: 3,
		},
		{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 1 },
	] as Message[];
}

/** A deterministic generator, so a failing sequence reproduces. */
function seeded(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

/** Random runs over every shape, and a long run of each shape alone. */
function corpus(): Message[][] {
	const sequences: Message[][] = [];
	for (let seed = 1; seed <= 200; seed++) {
		const next = seeded(seed);
		const pool = shapes();
		const length = 1 + Math.floor(next() * 30);
		sequences.push(Array.from({ length }, () => pool[Math.floor(next() * pool.length)]));
	}
	for (const shape of shapes().keys()) sequences.push(Array.from({ length: 30 }, () => shapes()[shape]));
	return sequences;
}

const CORPUS = corpus();

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function hasUselessResult(messages: readonly Message[]): boolean {
	return messages.some(message => message.role === "toolResult" && message.useless === true);
}

/** Every dialect `DIALECTS` lists at run time, and the plain transcript a model with none reads. */
const DIALECT_CASES = [{ name: "plain", dialect: undefined }, ...DIALECTS.map(dialect => ({ name: dialect, dialect }))];

describe("the byte floor of a summary span", () => {
	test.each(DIALECT_CASES)("never exceeds the joined $name transcript", async ({ dialect }) => {
		const offenders: string[] = [];
		for (const [index, messages] of CORPUS.entries()) {
			const source = await measureSummarySource(messages, dialect, undefined);
			const whole = bytes(compactionUtils.serializeConversationForSummary(source.messages, dialect));
			if (source.conversationBytesFloor > whole) {
				offenders.push(`sequence ${index}: floor ${source.conversationBytesFloor} > ${whole}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test.each(DIALECT_CASES)(
		"stays within twice the glue per message of the joined $name transcript",
		async ({ dialect }) => {
			const offenders: string[] = [];
			for (const [index, messages] of CORPUS.entries()) {
				if (hasUselessResult(messages)) continue;
				const source = await measureSummarySource(messages, dialect, undefined);
				const whole = bytes(compactionUtils.serializeConversationForSummary(source.messages, dialect));
				const bound = 2 * SUMMARY_TRANSCRIPT_GLUE_BYTES * messages.length;
				if (whole - source.conversationBytesFloor > bound) {
					offenders.push(`sequence ${index}: ${whole} - floor ${source.conversationBytesFloor} > ${bound}`);
				}
			}
			expect(offenders).toEqual([]);
		},
	);
});

/** A message of about 1.1k tokens. */
function chunkMessage(index: number): AgentMessage {
	const filler = `[[chunk-${index}]] step ${index}: read the seam, recorded what it holds, and moved on. `.repeat(60);
	return { role: "user", content: filler, timestamp: 1 };
}

function chunks(count: number): AgentMessage[] {
	return Array.from({ length: count }, (_, i) => chunkMessage(i + 1));
}

function model(contextWindow: number): Model {
	const found = getBundledModel("openai-codex", "gpt-5.1-codex");
	if (!found) throw new Error("Expected built-in openai-codex/gpt-5.1-codex to exist");
	return { ...found, contextWindow };
}

function preparation(messages: AgentMessage[]): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent", timestamp: 1 }],
		isSplitTurn: false,
		tokensBefore: 200_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

type RequestKind = "single" | "segment" | "merge";

/** A provider that answers every request and records which kind each one was. */
function answeringProvider() {
	const kinds: RequestKind[] = [];
	const completeImpl = async (_model: Model, ctx: Context) => {
		const last = ctx.messages[ctx.messages.length - 1];
		const text =
			last?.role === "user" && typeof last.content !== "string"
				? last.content.map(block => (block.type === "text" ? block.text : "")).join("\n")
				: "";
		kinds.push(
			text.includes("<segment-summaries>") ? "merge" : /segment \d+ of \d+/i.test(text) ? "segment" : "single",
		);
		return { ...assistant([{ type: "text", text: "summary" }]), timestamp: Date.now() };
	};
	return { kinds, completeImpl };
}

/**
 * Bytes serialized in each event-loop turn while it runs: a check-phase callback that requeues
 * itself numbers the turns, and every serialization adds its length to the turn it ran in.
 */
function serializedPerTurn(): { perTurn: Map<number, number>; stop: () => void } {
	let turn = 0;
	let running = true;
	const tick = () => {
		turn += 1;
		if (running) setImmediate(tick);
	};
	setImmediate(tick);
	const perTurn = new Map<number, number>();
	const serialize = compactionUtils.serializeConversationForSummary;
	vi.spyOn(compactionUtils, "serializeConversationForSummary").mockImplementation((messages, dialect) => {
		const text = serialize(messages, dialect);
		perTurn.set(turn, (perTurn.get(turn) ?? 0) + bytes(text));
		return text;
	});
	return {
		perTurn,
		stop: () => {
			running = false;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("planning the summary of a span past the window", () => {
	const window = 60_000;
	const span = chunks(300);
	const spanBytes = bytes(compactionUtils.serializeConversationForSummary(span as Message[], undefined));
	/** One segment of joined text, and the separators between its messages. */
	const segmentBytes = 4 * stagedSegmentBudget(model(window)) + 1_024;

	/**
	 * Every read of the clock advances it by a whole slice, so the plan finds each slice due at its
	 * first check and yields between every two items it serializes. A plan that serializes the span
	 * in one pass serializes it in one turn whatever the clock reads.
	 */
	function everyCheckIsDue(): void {
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			clock += TIME_SLICE_MS;
			return clock;
		});
	}

	test("the span is several segments, so one segment per turn is a bound below the span", () => {
		expect(spanBytes).toBeGreaterThan(4 * segmentBytes);
	});

	test("the candidate estimate serializes at most one segment per event-loop turn", async () => {
		everyCheckIsDue();
		const observed = serializedPerTurn();
		try {
			await estimateCompactionRequestTokens(preparation(span), model(window));
		} finally {
			observed.stop();
		}
		expect(observed.perTurn.size).toBeGreaterThan(1);
		expect(Math.max(...observed.perTurn.values())).toBeLessThanOrEqual(segmentBytes);
	});

	test("the summary serializes at most one segment per event-loop turn", async () => {
		everyCheckIsDue();
		const provider = answeringProvider();
		const observed = serializedPerTurn();
		try {
			await compact(preparation(span), model(window), "test-key", undefined, undefined, {
				completeImpl: provider.completeImpl,
			});
		} finally {
			observed.stop();
		}
		expect(provider.kinds).not.toContain("single");
		expect(observed.perTurn.size).toBeGreaterThan(1);
		expect(Math.max(...observed.perTurn.values())).toBeLessThanOrEqual(segmentBytes);
	});
});

describe("choosing one request or stages", () => {
	/**
	 * The windows straddle the exact count of the one request, and reach below it past the glue
	 * the byte floor allows for, so both the floor and the exact count decide some of them.
	 */
	test("a span is staged exactly when its one request exceeds the window", async () => {
		const span = chunks(60);
		const exact = await estimateCompactionRequestTokens(preparation(span), model(10_000_000));
		const glueTokens = (span.length * SUMMARY_TRANSCRIPT_GLUE_BYTES) / 4;
		const windows = [
			exact + 1,
			exact,
			exact - 1,
			exact - 64,
			exact - Math.floor(glueTokens) + 1,
			exact - Math.ceil(glueTokens) - 1,
			exact - 2 * Math.ceil(glueTokens),
			Math.floor(exact / 2),
		];
		const chosen: string[] = [];
		const expected: string[] = [];
		for (const window of windows) {
			const provider = answeringProvider();
			await compact(preparation(span), model(window), "test-key", undefined, undefined, {
				completeImpl: provider.completeImpl,
			});
			chosen.push(`${window}: ${provider.kinds[0]}`);
			expected.push(`${window}: ${exact <= window ? "single" : "segment"}`);
		}
		expect(chosen).toEqual(expected);
	});
});
