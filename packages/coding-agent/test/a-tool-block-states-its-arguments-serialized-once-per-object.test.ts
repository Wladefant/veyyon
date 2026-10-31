/**
 * WHY: a tool execution block states the call's arguments as `input`, and a long write's arguments
 * serialize to the whole file. A producer's block serializes them when `input` is read, once per
 * arguments object, through one accessor shared by every block, with its sources in symbol slots
 * (`presentation/tool-input.ts`).
 *
 * The class: a lazily derived block field that disagrees with the block built without a producer,
 * goes stale when the arguments change, is paid again on every rebuild with the same arguments, or
 * leaks its sources into the copies a transcript makes of a block; and arguments JSON cannot hold
 * that stall the render while `JSON.stringify` walks a cycle to its depth limit before it throws.
 * Every case drives a real `ToolExecutionProducer` and compares its block with
 * `buildToolExecutionBlock` or with a copy. The transcript builder and the event bridge state a tool
 * call's arguments through the same `serializeToolInput` when given no renderer.
 *
 * Not covered: the memory a kept block retains, which the shared accessor exists to bound. That is a
 * heap measurement rather than an assertion.
 */
import { describe, expect, it } from "bun:test";
import { buildToolExecutionBlock, ToolExecutionProducer } from "@veyyon/coding-agent/presentation/tool-execution";

const circular: Record<string, unknown> = { name: "loop" };
circular.self = circular;

const VARIANTS: ReadonlyArray<{ label: string; args: unknown; input: string }> = [
	{ label: "a string as it is", args: "*** Begin Patch", input: "*** Begin Patch" },
	{ label: "no arguments as empty text", args: undefined, input: "" },
	{ label: "a number as JSON", args: 42, input: "42" },
	{ label: "null as JSON", args: null, input: "null" },
	{
		label: "an object as indented JSON",
		args: { path: "a.ts", lines: [1, 2] },
		input: '{\n  "path": "a.ts",\n  "lines": [\n    1,\n    2\n  ]\n}',
	},
	{ label: "an array as indented JSON", args: ["a", "b"], input: '[\n  "a",\n  "b"\n]' },
	{ label: "a circular object as unserializable", args: circular, input: "[unserializable]" },
	{ label: "a bigint as unserializable", args: 10n, input: "[unserializable]" },
];

/** Arguments whose every serialization is numbered, so a block's `input` shows which one it holds. */
function numberedArgs(): { toJSON(): { serialization: number } } {
	let serializations = 0;
	return { toJSON: () => ({ serialization: ++serializations }) };
}

/** Fresh cyclic arguments in each shape the serializer walks: self, deep, array, and an array of cycles. */
function cyclicArgs(): unknown[] {
	const self: Record<string, unknown> = { name: "loop" };
	self.self = self;
	const deep: { b: { c: Record<string, unknown> } } = { b: { c: {} } };
	deep.b.c.back = deep;
	const list: unknown[] = [1];
	list.push(list);
	return [self, deep, list, [self, deep]];
}

describe("a tool block's input", () => {
	for (const variant of VARIANTS) {
		it(`states ${variant.label}, as the block built without a producer does`, () => {
			const producer = new ToolExecutionProducer({ toolName: "probe", args: variant.args, toolCallId: "call-1" });
			const eager = buildToolExecutionBlock({ toolName: "probe", args: variant.args, toolCallId: "call-1" });
			expect(producer.block.input).toBe(variant.input);
			expect(eager.input).toBe(variant.input);
		});
	}

	it("states cyclic arguments as unserializable without walking the cycle to the depth limit", () => {
		// Under Bun 1.4.3 an indented stringify spent 250-850 ms in each of these before it threw; with
		// the cycle check it throws in microseconds. The bound sits far from both.
		const started = performance.now();
		for (const args of cyclicArgs()) {
			const producer = new ToolExecutionProducer({ toolName: "probe", args, toolCallId: "call-1" });
			const eager = buildToolExecutionBlock({ toolName: "probe", args, toolCallId: "call-1" });
			expect(producer.block.input).toBe("[unserializable]");
			expect(eager.input).toBe("[unserializable]");
		}
		expect(performance.now() - started).toBeLessThan(200);
	});

	it("is serialized once per arguments object across rebuilt blocks", () => {
		const producer = new ToolExecutionProducer({ toolName: "probe", args: numberedArgs(), toolCallId: "call-1" });
		const first = producer.block;
		expect(first.input).toBe('{\n  "serialization": 1\n}');
		producer.toolCallId = "call-2";
		const rebuilt = producer.block;
		expect(rebuilt).not.toBe(first);
		expect(rebuilt.input).toBe('{\n  "serialization": 1\n}');
		expect(first.input).toBe('{\n  "serialization": 1\n}');
	});

	it("follows new arguments, while a kept block states the arguments it was built from", () => {
		const producer = new ToolExecutionProducer({ toolName: "probe", args: { step: 1 }, toolCallId: "call-1" });
		const kept = producer.block;
		expect(kept.input).toBe('{\n  "step": 1\n}');
		producer.updateArgs({ step: 2 });
		expect(producer.block.input).toBe('{\n  "step": 2\n}');
		expect(kept.input).toBe('{\n  "step": 1\n}');
		expect(producer.block.input).toBe('{\n  "step": 2\n}');
	});

	it("is an enumerable field of every copy, and its sources reach none", () => {
		const args = { path: "a.ts" };
		const block = new ToolExecutionProducer({ toolName: "probe", args, toolCallId: "call-1" }).block;
		const eager = buildToolExecutionBlock({ toolName: "probe", args, toolCallId: "call-1" });
		expect(Object.keys(block).sort()).toEqual(Object.keys(eager).sort());

		const spread = { ...block };
		expect(spread.input).toBe('{\n  "path": "a.ts"\n}');
		expect(Object.getOwnPropertySymbols(spread)).toEqual([]);
		expect(Object.getOwnPropertyDescriptor(spread, "input")?.value).toBe('{\n  "path": "a.ts"\n}');

		const parsed = JSON.parse(JSON.stringify(block)) as { input: unknown };
		expect(parsed.input).toBe('{\n  "path": "a.ts"\n}');
	});
});
