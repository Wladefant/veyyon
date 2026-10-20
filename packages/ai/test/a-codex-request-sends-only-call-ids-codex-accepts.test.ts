/**
 * WHY: OpenAI Codex rejects the whole request when any `input[i].call_id` is longer than 64 characters or
 * leaves `[a-zA-Z0-9_-]`. History from another provider (a Cursor id joined by a newline, an id with dots, a
 * long id) reached the wire unchanged and failed the turn (oh-my-pi 828008bbbcd9a9fc90c0e37f5838e5b5dfbf1d77).
 *
 * The class closed: every `call_id` the Codex turn builder and the Responses Lite shaper (shared with remote
 * compaction) send matches the accepted shape, a call and its output stay paired, and a valid id is never
 * rewritten, so ids already on the wire keep matching.
 *
 * Gap: this pins the request body only; it does not prove Codex accepts every value of that shape.
 */
import { describe, expect, it } from "bun:test";
import {
	applyCodexResponsesLiteShape,
	type InputItem,
	type RequestBody,
	sanitizeCodexCallId,
	transformRequestBody,
} from "@veyyon/ai/providers/openai-codex/request-transformer";
import { createCodexModel } from "./helpers";

const ACCEPTED_CALL_ID = /^[a-zA-Z0-9_-]{1,64}$/;

const FOREIGN_CALL_IDS = [
	"call_abc\nitem_def",
	"call.with.dots",
	`call_${"x".repeat(80)}`,
	`toolu_${"y".repeat(70)}|fc_123`,
	"|leading-separator",
	"!!!",
];

function pairedInput(callId: string): InputItem[] {
	return [
		{ type: "message", role: "user", content: [{ type: "input_text", text: "Read README.md" }] },
		{ type: "function_call", call_id: callId, name: "read", arguments: '{"path":"README.md"}' },
		{ type: "function_call_output", call_id: callId, output: "ok" },
	];
}

function callIds(input: readonly unknown[] | undefined): string[] {
	return (input ?? []).flatMap(item =>
		item && typeof item === "object" && "call_id" in item && typeof item.call_id === "string" ? [item.call_id] : [],
	);
}

describe("Codex call_id on the wire", () => {
	it.each(FOREIGN_CALL_IDS)("sends a paired, accepted call_id for %j", async callId => {
		const model = createCodexModel("gpt-5.1-codex");
		const body: RequestBody = { model: model.id, input: pairedInput(callId) };

		const transformed = await transformRequestBody(body, model);
		const ids = callIds(transformed.input);

		expect(ids).toHaveLength(2);
		expect(ids[0]).toMatch(ACCEPTED_CALL_ID);
		expect(ids[1]).toBe(ids[0]);
	});

	it.each(FOREIGN_CALL_IDS)("the Responses Lite shaper sends an accepted call_id for %j", callId => {
		const body = { input: pairedInput(callId) };

		applyCodexResponsesLiteShape(body);
		const ids = callIds(body.input);
		expect(ids).toHaveLength(2);
		expect(ids[0]).toMatch(ACCEPTED_CALL_ID);
		expect(ids[1]).toBe(ids[0]);
	});

	it("leaves a valid call_id unchanged", () => {
		const valid = `call_${"a".repeat(59)}`;
		expect(sanitizeCodexCallId(valid)).toBe(valid);
		expect(sanitizeCodexCallId("toolu_01AbC-xyz")).toBe("toolu_01AbC-xyz");
	});

	it("keeps distinct over-long ids distinct", () => {
		const shared = "z".repeat(80);
		expect(sanitizeCodexCallId(`${shared}1`)).not.toBe(sanitizeCodexCallId(`${shared}2`));
	});

	it("maps both halves of a composite id to the same call_id", () => {
		expect(sanitizeCodexCallId("call.a|fc_1")).toBe(sanitizeCodexCallId("call.a\nfc_2"));
	});

	it.each([
		["a valid call half", "call_abc"],
		["an invalid call half", "call.abc"],
	])("pairs a composite call with an output that carries only %s", (_shape, callHalf) => {
		// A call stored as `call\nitem` and its output stored as the bare call id must still pair.
		expect(sanitizeCodexCallId(`${callHalf}\nitem_def`)).toBe(sanitizeCodexCallId(callHalf));
		expect(sanitizeCodexCallId(`${callHalf}|item_def`)).toBe(sanitizeCodexCallId(callHalf));
	});
});
