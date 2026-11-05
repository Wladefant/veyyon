/**
 * WHY: a JS eval cell that displayed a value holding a cycle sent the model `[object Object]`, after an
 * indented `JSON.stringify` spent 250-850 ms walking the cycle to its depth limit before it threw
 * (Bun 1.4.3). The text formatter now renders through `stringifyJsonSafe`, which marks each value
 * JSON cannot hold where it sits.
 *
 * The class: a displayed value JSON throws on (a cycle at any depth, in an object or an array, a
 * bigint) that reaches the model as anything but its own contents with the offending value marked,
 * or that stalls the cell while it is formatted. The negative case is a shared reference that is not
 * a cycle, which must render in full at both places. Every content case drives the real `EvalTool`
 * over the real JS runtime. The stall is bounded at `formatDisplayJsonForText`, the one formatter
 * every displayed JSON value passes through.
 *
 * Not covered: a value `structuredClone` cannot copy (a function, a symbol). It never reaches this
 * formatter; `test/core/js-executor.test.ts` covers the text the runtime states for it instead.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import { EvalTool, formatDisplayJsonForText } from "@veyyon/coding-agent/tools/shell/eval";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSessionAt } from "../helpers/tool-session";

const SHAPES: ReadonlyArray<{ label: string; code: string; text: string }> = [
	{
		label: "an object that holds itself",
		code: 'const loop = { name: "loop" }; loop.self = loop; display(loop);',
		text: '{\n  "name": "loop",\n  "self": "[Circular]"\n}',
	},
	{
		label: "an object that loops back from three levels down",
		code: "const root = { b: { c: {} } }; root.b.c.back = root; display(root);",
		text: '{\n  "b": {\n    "c": {\n      "back": "[Circular]"\n    }\n  }\n}',
	},
	{
		label: "an array that holds itself",
		code: "const list = [1]; list.push(list); display(list);",
		text: '[\n  1,\n  "[Circular]"\n]',
	},
	{
		label: "one object reached twice without a cycle, in full both times",
		code: "const shared = { v: 1 }; display({ a: shared, b: shared });",
		text: '{\n  "a": {\n    "v": 1\n  },\n  "b": {\n    "v": 1\n  }\n}',
	},
	{
		label: "a bigint",
		code: "display({ id: 9007199254740993n });",
		text: '{\n  "id": "9007199254740993n"\n}',
	},
];

/** Fresh cyclic values in each shape the formatter walks: self, deep, array, and an array of cycles. */
function cyclicValues(): unknown[] {
	const self: Record<string, unknown> = { name: "loop" };
	self.self = self;
	const deep: { b: { c: Record<string, unknown> } } = { b: { c: {} } };
	deep.b.c.back = deep;
	const list: unknown[] = [1];
	list.push(list);
	return [self, deep, list, [self, deep]];
}

describe("an eval display of a value JSON cannot hold", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	for (const shape of SHAPES) {
		it(`states ${shape.label} with what JSON cannot hold marked in place`, async () => {
			const tool = new EvalTool(makeToolSessionAt(process.cwd()));
			const result = await tool.execute(`call-${shape.label}`, { language: "js", code: shape.code });
			expect(toolResultText(result)).toContain(`display[1]:\n${shape.text}`);
		});
	}

	it("is formatted without walking a cycle to the depth limit", () => {
		// Each value took 250-850 ms on the indented path that walked its cycle before throwing; marked in
		// place, all four take well under a millisecond. The bound sits far from both.
		const values = cyclicValues();
		const started = performance.now();
		const texts = values.map(formatDisplayJsonForText);
		const elapsed = performance.now() - started;
		for (const text of texts) expect(text).toContain('"[Circular]"');
		expect(elapsed).toBeLessThan(200);
	});
});
