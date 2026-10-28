/**
 * WHY: native Responses history replays each stored `function_call` item as sent. A call whose
 * stream was cut off mid-JSON stored unparsable `arguments`, and the replay sanitizer passed that
 * text through, so every later request in the session carried it and the provider rejected the
 * whole request (oh-my-pi 46bc9331d0df7db37bd25531ecfd4e09077288fb).
 *
 * The class: whatever a stored call's `arguments` hold, the replayed value parses as JSON, and the
 * call stays on the wire so its recorded output keeps a partner. Unparsable text becomes the same
 * bounded `{__parseError, __rawJson}` diagnostic the stream paths already record.
 *
 * What it does not catch: arguments that parse but violate the tool's schema; replay is not where
 * those are judged.
 */
import { describe, expect, it } from "bun:test";
import type { ResponseInput } from "@veyyon/ai/providers/openai-responses-wire";
import { sanitizeOpenAIResponsesHistoryItemsForReplay } from "@veyyon/ai/utils";

function storedCall(args: unknown): Array<Record<string, unknown>> {
	return [
		{ type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: args, status: "completed" },
		{ type: "function_call_output", call_id: "call_1", output: "ok" },
	];
}

function replayedArguments(items: ResponseInput): string {
	for (const item of items) {
		if (item.type === "function_call") return item.arguments;
	}
	throw new Error("the replay dropped the function_call");
}

function replay(args: unknown): { items: ResponseInput; parsed: unknown } {
	const items = sanitizeOpenAIResponsesHistoryItemsForReplay(storedCall(args));
	return { items, parsed: JSON.parse(replayedArguments(items)) };
}

describe("a replayed function_call always carries parseable arguments", () => {
	it("replays arguments cut off mid-JSON as a diagnostic and keeps the call paired with its output", () => {
		const { items, parsed } = replay('{"path": "a');

		expect(items.map(item => item.type)).toEqual(["function_call", "function_call_output"]);
		expect(parsed).toMatchObject({ __rawJson: '{"path": "a' });
		expect(parsed).toHaveProperty("__parseError");
	});

	it("bounds the raw text a diagnostic echoes", () => {
		const raw = `{"content": "${"x".repeat(5000)}`;
		const { parsed } = replay(raw);

		expect(parsed).toHaveProperty("__parseError");
		expect(JSON.stringify(parsed).length).toBeLessThan(1024);
	});

	it("replays arguments that parse byte for byte", () => {
		const raw = '{"path":"a.ts", "content": "x"}';
		const items = sanitizeOpenAIResponsesHistoryItemsForReplay(storedCall(raw));

		expect(replayedArguments(items)).toBe(raw);
	});

	it.each([
		["blank", "   "],
		["absent", undefined],
	])("replays %s arguments as an empty object", (_shape, args) => {
		expect(replay(args).parsed).toEqual({});
	});

	it("re-derives the replay when the same item's arguments change", () => {
		const items = storedCall('{"path": "a');
		sanitizeOpenAIResponsesHistoryItemsForReplay(items);
		const call = items[0];
		if (call === undefined) throw new Error("fixture has no call");
		call.arguments = '{"path":"b"}';

		expect(replayedArguments(sanitizeOpenAIResponsesHistoryItemsForReplay(items))).toBe('{"path":"b"}');
	});
});
