/**
 * WHY: a tool card's producer builds its block, and resolves its policies, on the first read after a
 * change and keeps both until the next one. A change that does not drop them serves an earlier state
 * on every later frame: a spinner that stops on one glyph, a card that stays collapsed after it was
 * expanded, a result that never replaces the call, a sealed card that still animates as live.
 *
 * THE CLASS. Any change a producer accepts that its next block or policies read does not show. Every
 * public member of `ToolExecutionProducer` is swept off its prototype at run time and must be recorded
 * here as a change or as a read, so a new mutator fails the suite until it is given a change. Every
 * field of `ToolExecutionDrawContext` is listed in a map typed over its keys, so a new context field
 * fails the type check until it is given one. Each change is read in an unchanged context before and
 * after, the block and the policies in both orders, and compared with a producer built fresh into the
 * same state; each must also change what that fresh producer shows, so a change that shows nothing
 * cannot pass by comparing two stale reads.
 *
 * WHAT IT DOES NOT CATCH. A change that lands through the call preview's asynchronous edit diff is
 * delivered by its `onChange` callback, which only an edit tool with a diff strategy drives; the
 * streamed edit preview suites cover that path.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import type { AnyAgentTool } from "@veyyon/agent-core";
import type { ToolExecutionBlock } from "@veyyon/wire/presentation";
import { type ToolExecutionDrawContext, ToolExecutionProducer } from "../src/presentation/tool-execution";
import { initTheme } from "../src/theme/theme";

/** A tool whose views show every input they were drawn from: the arguments, the result and the view context. */
const ECHO_TOOL = {
	name: "echo",
	label: "echo",
	view: {
		renderCall: (args: unknown, context: unknown) => ({
			kind: "statusRow",
			title: JSON.stringify({ args, context }),
		}),
		renderResult: (result: unknown, context: unknown) => ({
			kind: "statusRow",
			title: JSON.stringify({ result, context }),
		}),
	},
} as unknown as AnyAgentTool;

const ARGS = { input: "first" };
const PARTIAL = { content: [{ type: "text", text: "partial" }] };
const SETTLED = { content: [{ type: "text", text: "settled" }] };

type Step = (producer: ToolExecutionProducer) => void;

/** A change and the state it is applied to, which the fresh producer is built into as well. */
interface Change {
	from: readonly Step[];
	apply: Step;
}

/** Every change each mutating member accepts, keyed by the member. */
const CHANGES: Record<string, Record<string, Change>> = {
	updateArgs: {
		"new arguments": { from: [], apply: producer => producer.updateArgs({ input: "second" }) },
	},
	setArgsComplete: {
		"arguments complete": { from: [], apply: producer => producer.setArgsComplete() },
	},
	updateResult: {
		"a first partial result": { from: [], apply: producer => producer.updateResult(PARTIAL, true) },
		"a settled result after a partial one": {
			from: [producer => producer.updateResult(PARTIAL, true)],
			apply: producer => producer.updateResult(SETTLED, false),
		},
		"a failure after a partial result": {
			from: [producer => producer.updateResult(PARTIAL, true)],
			apply: producer => producer.updateResult({ ...SETTLED, isError: true }, false),
		},
	},
	seal: {
		"sealed while running": { from: [], apply: producer => producer.seal() },
		"sealed after settling": {
			from: [producer => producer.updateResult(SETTLED, false)],
			apply: producer => producer.seal(),
		},
	},
	toolCallId: {
		"a new call id": {
			from: [],
			apply: producer => {
				producer.toolCallId = "call-2";
			},
		},
	},
};

/** Members that read the producer and change nothing it shows. */
const READS = [
	"block",
	"callPreview",
	"constructor",
	"isPartial",
	"policies",
	"produceBlock",
	"result",
	"sealed",
	"subscribe",
	"toolName",
	"whenSettled",
];

/** A change of each draw context field, from the first context to the second. */
const CONTEXT_CHANGES: {
	[Field in keyof Required<ToolExecutionDrawContext>]: readonly [ToolExecutionDrawContext, ToolExecutionDrawContext];
} = {
	expanded: [{ expanded: false }, { expanded: true }],
	frame: [{ frame: 1 }, { frame: 2 }],
	frozen: [{ frozen: false }, { frozen: true }],
};

function producerAt(steps: readonly Step[]): ToolExecutionProducer {
	const producer = new ToolExecutionProducer({ toolName: "echo", args: ARGS, tool: ECHO_TOOL, toolCallId: "call-1" });
	for (const step of steps) step(producer);
	return producer;
}

/** What a card draws from a block: everything but the time the producer was constructed. */
function shown(block: ToolExecutionBlock): Omit<ToolExecutionBlock, "timestamp"> {
	const { timestamp: _timestamp, ...rest } = block;
	return rest;
}

/** The block and the policies read in `context`, policies first so a stale policy is not masked by a fresh build. */
function readPoliciesFirst(producer: ToolExecutionProducer, context: ToolExecutionDrawContext) {
	const policies = producer.policies(context);
	return { policies, block: shown(producer.produceBlock(context)) };
}

function readBlockFirst(producer: ToolExecutionProducer, context: ToolExecutionDrawContext) {
	const block = shown(producer.produceBlock(context));
	return { policies: producer.policies(context), block };
}

const READ_ORDERS = { "policies first": readPoliciesFirst, "block first": readBlockFirst };

describe("a tool card's block shows the latest change it was handed", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("records every public member of the producer as a change or a read", () => {
		const members = Object.getOwnPropertyNames(ToolExecutionProducer.prototype).sort();
		expect(members).toEqual([...Object.keys(CHANGES), ...READS].sort());
	});

	for (const [member, changes] of Object.entries(CHANGES)) {
		for (const [label, { from, apply }] of Object.entries(changes)) {
			for (const [order, read] of Object.entries(READ_ORDERS)) {
				it(`${member}: ${label}, read ${order}`, () => {
					const context: ToolExecutionDrawContext = { expanded: false, frame: 0 };
					const card = producerAt(from);
					// Read first, so the change has a cached block and cached policies to drop.
					read(card, context);
					let notified = 0;
					card.subscribe(() => notified++);
					apply(card);
					const after = read(card, context);
					expect({ after, notified }).toEqual({ after: read(producerAt([...from, apply]), context), notified: 1 });
				});
			}
		}
	}

	it("changes what a fresh producer shows with every change but arguments complete", () => {
		const context: ToolExecutionDrawContext = { expanded: false, frame: 0 };
		const invisible: string[] = [];
		for (const [member, changes] of Object.entries(CHANGES)) {
			for (const { from, apply } of Object.values(changes)) {
				const before = readBlockFirst(producerAt(from), context);
				if (isDeepStrictEqual(before, readBlockFirst(producerAt([...from, apply]), context)))
					invisible.push(member);
			}
		}
		// Completing the arguments only restarts an edit tool's diff preview, which reports through `onChange`.
		expect(invisible).toEqual(["setArgsComplete"]);
	});

	for (const [field, [first, second]] of Object.entries(CONTEXT_CHANGES)) {
		for (const [order, read] of Object.entries(READ_ORDERS)) {
			it(`draws a changed ${field} in the next read, read ${order}`, () => {
				const card = producerAt([producer => producer.updateResult(PARTIAL, true)]);
				const before = read(card, first);
				const after = read(card, second);
				const fresh = read(producerAt([producer => producer.updateResult(PARTIAL, true)]), second);
				expect({ changed: !isDeepStrictEqual(before, after), after }).toEqual({ changed: true, after: fresh });
			});
		}
	}
});
