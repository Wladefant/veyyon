/**
 * WHY: a tool result whose details held a cycle (a JS eval cell that displayed a cyclic value, an
 * extension tool returning a live object graph) sent the persistence walk recursing until the stack
 * overflowed. The append threw `RangeError: Maximum call stack size exceeded`, the entry stayed in
 * memory only, and the reopened session had lost the tool result.
 *
 * The class: a value in any entry that loops back to one of its own ancestors, at any depth, in an
 * object or an array, written by either path a line takes to the file: the whole-file publish that
 * writes the entries recorded before the first assistant message, and the synchronous append after
 * it. The negative case is one object reached twice without a loop, which persists whole both times.
 * The entry a session holds keeps its cycle; only the written line marks it.
 *
 * Not covered: a `toJSON` that returns a cyclic value. The walk does not call `toJSON`, so such a
 * value reaches `JSON.stringify` intact and the line is not written.
 */
import { describe, expect, it } from "bun:test";
import { emptyUsage } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { CIRCULAR_MARKER } from "@veyyon/utils/json";

/** Fresh cyclic values in each shape, with the form a written line holds for each. */
function shapes(): Array<{ value: unknown; written: unknown }> {
	const self: Record<string, unknown> = { name: "loop" };
	self.self = self;
	const deep: { b: { c: Record<string, unknown> } } = { b: { c: {} } };
	deep.b.c.back = deep;
	const list: unknown[] = [1];
	list.push(list);
	const shared = { v: 1 };
	return [
		{ value: self, written: { name: "loop", self: CIRCULAR_MARKER } },
		{ value: deep, written: { b: { c: { back: CIRCULAR_MARKER } } } },
		{ value: list, written: [1, CIRCULAR_MARKER] },
		{ value: { a: shared, b: shared }, written: { a: { v: 1 }, b: { v: 1 } } },
	];
}

describe("a session entry holding a cycle", () => {
	it("reaches the file with each cycle marked where it loops back, by either write path", async () => {
		using temp = TempDir.createSync("@kernel-cyclic-entry-");
		const dir = temp.path();
		const sm = SessionManager.create(dir, dir);
		const published = shapes();
		const appended = shapes();

		sm.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
		const customId = sm.appendCustomEntry("probe", { shapes: published.map(shape => shape.value) });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }],
			timestamp: 2,
			api: "mock",
			provider: "mock",
			model: "mock",
			stopReason: "toolUse",
			usage: emptyUsage(),
		});
		const details = { shapes: appended.map(shape => shape.value) };
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "probe",
			content: [{ type: "text", text: "done" }],
			details,
			isError: false,
			timestamp: 3,
		});
		await sm.flush();

		const reopened = await SessionManager.open(sm.getSessionFile()!, dir);
		const entries = reopened.getEntries();
		const custom = entries.find(entry => entry.id === customId);
		if (custom?.type !== "custom") throw new Error("the custom entry did not reach the file");
		expect(custom.data).toEqual({ shapes: published.map(shape => shape.written) });
		const result = entries.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (result?.type !== "message" || result.message.role !== "toolResult") {
			throw new Error("the tool result did not reach the file");
		}
		expect(result.message.details).toEqual({ shapes: appended.map(shape => shape.written) });

		const held = details.shapes[0] as Record<string, unknown>;
		expect(held.self).toBe(held);
	});
});
