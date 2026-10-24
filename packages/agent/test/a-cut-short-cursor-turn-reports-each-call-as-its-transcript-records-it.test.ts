/**
 * WHY. A Cursor turn runs its tools through the exec channel while the assistant message streams, and the agent holds
 * each result until that message ends. When the stream dropped or the turn was aborted, the partial-completion ledger
 * resolved every exec-channel call against the loop's context, which never holds those results while the turn is open.
 * Every such call was reported "started, no result recorded", with the advice to check state before retrying it, while
 * the transcript the model read next held the call's real result.
 *
 * CLASS. The ledger stating an outcome for an exec-channel call that the transcript contradicts, under both causes
 * (stream error, abort), for every state the exec channel can leave a call in (answered ok, answered with an error,
 * still running), alone and mixed, with and without a call that never ran; a result the host rewrites, where the
 * ledger must follow what the transcript keeps; and a ledger that restates a batch whose every call has its result.
 *
 * GAP. A stream function stands in for the Cursor provider. That the provider hands each exec result to
 * `options.cursorOnToolResult` is covered in packages/ai. A result that arrives after the turn has ended is outside the
 * turn and outside this suite.
 */
import { describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentOptions, type StreamFn } from "@veyyon/agent-core";
import {
	buildToolBatchLedger,
	renderToolBatchLedger,
	TOOL_BATCH_LEDGER_HEADLINE_PREFIX,
	type ToolBatchCallEntry,
	type ToolBatchLedger,
	type ToolBatchLedgerCause,
} from "@veyyon/agent-core/tool-batch-ledger";
import { toolResultNeverRan } from "@veyyon/agent-core/tool-result-never-ran";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@veyyon/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";

/** What the exec channel did with one call before the turn was cut short. */
type ExecState = "answered ok" | "answered with an error" | "still running";
const EXEC_STATES: readonly ExecState[] = ["answered ok", "answered with an error", "still running"];
const CAUSES: readonly ToolBatchLedgerCause[] = ["stream_error", "aborted"];

interface Scenario {
	cause: ToolBatchLedgerCause;
	exec: ExecState[];
	/** A call with complete arguments that the loop never dispatched, after the exec-channel calls. */
	withUndispatchedCall: boolean;
	/** The host's result hook; the agent installs its own when this is absent. */
	cursorOnToolResult?: AgentOptions["cursorOnToolResult"];
}

const NO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Every non-empty ordered subset of the exec states, under each cause, with and without an undispatched call. */
function sweep(): Scenario[] {
	const subsets: ExecState[][] = [];
	for (let mask = 1; mask < 1 << EXEC_STATES.length; mask++) {
		subsets.push(EXEC_STATES.filter((_, bit) => (mask & (1 << bit)) !== 0));
	}
	return CAUSES.flatMap(cause =>
		subsets.flatMap(exec => [false, true].map(withUndispatchedCall => ({ cause, exec, withUndispatchedCall }))),
	);
}

function execId(state: ExecState, index: number): string {
	return `exec-${index}-${state.replaceAll(" ", "-")}`;
}

interface Run {
	/** The assistant turn's tool calls, in emission order, with whether the exec channel dispatched each. */
	calls: Array<{ id: string; name: string; exec: boolean }>;
	transcript: AgentMessage[];
	/** Every ledger the model can read: the structured one on a placeholder result, and a turn-level notice. */
	ledgers: string[];
}

async function runScenario(scenario: Scenario): Promise<Run> {
	const blocks: Array<ToolCall & CursorExecResolvedCarrier> = scenario.exec.map((state, index) => ({
		type: "toolCall",
		id: execId(state, index),
		name: "bash",
		arguments: { command: `step ${index}` },
		[kCursorExecResolved]: true,
	}));
	if (scenario.withUndispatchedCall) {
		blocks.push({ type: "toolCall", id: "undispatched", name: "read", arguments: { path: "a.ts" } });
	}
	let agent: Agent | undefined;
	const streamFn: StreamFn = (_model, _context, options) => {
		const stream = new AssistantMessageEventStream();
		void (async () => {
			const partial: AssistantMessage = {
				role: "assistant",
				content: blocks,
				api: "cursor-agent",
				provider: "cursor",
				model: "composer",
				usage: NO_USAGE,
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial });
			blocks.forEach((toolCall, contentIndex) => {
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
			});
			// The exec channel answers the calls it finished, through the callback the provider receives.
			for (const [index, state] of scenario.exec.entries()) {
				if (state === "still running") continue;
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: execId(state, index),
					toolName: "bash",
					content: [{ type: "text", text: `output ${index}` }],
					isError: state === "answered with an error",
					timestamp: Date.now(),
				};
				await options?.cursorOnToolResult?.(result);
			}
			// Let the loop consume every event above before the turn is cut short.
			await sleep(0);
			if (scenario.cause === "aborted") {
				agent?.abort();
				stream.push({
					type: "error",
					reason: "aborted",
					error: { ...partial, stopReason: "aborted", errorMessage: "Request was aborted" },
				});
				return;
			}
			stream.push({
				type: "error",
				reason: "error",
				error: {
					...partial,
					stopReason: "error",
					errorMessage: "Stream closed with error code NGHTTP2_INTERNAL_ERROR",
				},
			});
		})();
		return stream;
	};
	agent = new Agent({
		initialState: { model: createMockModel().model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn,
		cursorExecHandlers: {},
		cursorOnToolResult: scenario.cursorOnToolResult,
	});
	await agent.prompt("go");
	const transcript = agent.state.messages;
	const ledgers: string[] = [];
	for (const message of transcript) {
		if (message.role === "user" && typeof message.content === "string") {
			if (message.content.startsWith(TOOL_BATCH_LEDGER_HEADLINE_PREFIX)) ledgers.push(message.content);
		}
		if (message.role === "toolResult") {
			const ledger = batchLedgerOf(message.details);
			if (ledger) ledgers.push(renderToolBatchLedger(ledger));
		}
	}
	return {
		calls: blocks.map(block => ({ id: block.id, name: block.name, exec: block[kCursorExecResolved] === true })),
		transcript,
		ledgers,
	};
}

/** The structured ledger a placeholder result carries, if any. */
function batchLedgerOf(details: unknown): ToolBatchLedger | undefined {
	if (typeof details !== "object" || details === null || !("batchLedger" in details)) return undefined;
	return details.batchLedger as ToolBatchLedger;
}

/** Whether each call's real result in the transcript is an error, by id. Placeholders for calls that never ran are not results. */
function recordedResults(transcript: AgentMessage[]): Map<string, boolean> {
	const recorded = new Map<string, boolean>();
	for (const message of transcript) {
		if (message.role !== "toolResult" || toolResultNeverRan(message.details)) continue;
		recorded.set(message.toolCallId, message.isError === true);
	}
	return recorded;
}

/** The ledger the transcript implies, or none when the transcript already states every call's outcome. */
function ledgerTheTranscriptImplies(cause: ToolBatchLedgerCause, run: Run): string[] {
	const recorded = recordedResults(run.transcript);
	const entries: ToolBatchCallEntry[] = run.calls.map(call => {
		if (!call.exec) return { toolCallId: call.id, toolName: call.name, outcome: "dropped" };
		const isError = recorded.get(call.id);
		const outcome = isError === undefined ? "interrupted" : isError ? "failed" : "ok";
		return { toolCallId: call.id, toolName: call.name, outcome };
	});
	if (entries.every(entry => entry.outcome === "ok" || entry.outcome === "failed")) return [];
	return [renderToolBatchLedger(buildToolBatchLedger(cause, entries))];
}

describe("a cut-short Cursor turn reports each call as its transcript records it", () => {
	const scenarios = sweep();

	it("sweeps both causes and every mix of exec-channel states", () => {
		expect(scenarios).toHaveLength(CAUSES.length * (2 ** EXEC_STATES.length - 1) * 2);
	});

	for (const scenario of scenarios) {
		const label = `${scenario.cause}: ${scenario.exec.join(", ")}${scenario.withUndispatchedCall ? ", then an undispatched call" : ""}`;
		it(label, async () => {
			const run = await runScenario(scenario);

			// The control: the transcript holds a real result for exactly the calls the exec channel answered, so
			// agreement below is between the ledger and a transcript that does record those calls as ran.
			const answered = scenario.exec.flatMap((state, index) =>
				state === "still running" ? [] : [execId(state, index)],
			);
			expect([...recordedResults(run.transcript).keys()].sort()).toEqual(answered.sort());

			expect(run.ledgers).toEqual(ledgerTheTranscriptImplies(scenario.cause, run));
		});
	}

	it("follows the result the host hook kept, not the one the exec channel produced", async () => {
		const scenario: Scenario = {
			cause: "stream_error",
			exec: ["answered ok", "still running"],
			withUndispatchedCall: false,
			cursorOnToolResult: result => ({ ...result, isError: true }),
		};
		const run = await runScenario(scenario);

		expect(recordedResults(run.transcript)).toEqual(new Map([[execId("answered ok", 0), true]]));
		expect(run.ledgers).toEqual([
			[
				"Partial completion ledger for this tool batch (2 calls): 1 ran, 1 interrupted, 0 never ran.",
				"Cause: the provider stream ended before the remaining calls were dispatched. That is a transport failure, not a tool failure.",
				`- ran, failed: ${execId("answered ok", 0)} (bash)`,
				`- started, no result recorded: ${execId("still running", 1)} (bash)`,
				'Results for the calls marked "ran" are already in this transcript, including the failed ones. Do not re-run them.',
				'The calls marked "started, no result recorded" may have applied partial side effects. Check state before retrying them.',
			].join("\n"),
		]);
	});
});
