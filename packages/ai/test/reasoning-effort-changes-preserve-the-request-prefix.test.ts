// WHY: Changing request effort invalidates the cached prefix. Defend transition placement,
// replay and rewritten-history reset; provider capability gating is covered by wire tests.
import { describe, expect, it } from "bun:test";
import {
	type ConfigurationUpdateItem,
	createOpenAIEffortControlState,
	getOpenAIEffortControlState,
	type OpenAIEffortControlState,
	planStableOpenAIEffort,
} from "../src/providers/openai-configuration-update";

type Item = { role?: string; type?: string; content?: string; id?: string; status?: string } | ConfigurationUpdateItem;
const user = (content: string): Item => ({ role: "user", content });
const assistant: Item = { role: "assistant", content: "answer" };
const update = (effort: string): Item => ({ type: "configuration_update", reasoning: { effort } });

describe("stable Responses reasoning effort", () => {
	it("pins effort and replays a change before the user message it applies to", () => {
		const state = createOpenAIEffortControlState<string>();
		expect(planStableOpenAIEffort(state, [user("first")], "low")).toBe("low");
		const second = [user("first"), assistant, user("second")];
		expect(planStableOpenAIEffort(state, second, "high")).toBe("low");
		expect(second).toEqual([user("first"), assistant, update("high"), user("second")]);
		const third = [user("first"), assistant, user("second"), assistant, user("third")];
		expect(planStableOpenAIEffort(state, third, "high")).toBe("low");
		expect(third).toEqual([user("first"), assistant, update("high"), user("second"), assistant, user("third")]);
	});
	it("replays distinct transitions at their original positions and changes back after an earlier transition", () => {
		const state = createOpenAIEffortControlState<string>();
		planStableOpenAIEffort(state, [user("first")], "low");
		planStableOpenAIEffort(state, [user("first"), assistant, user("second")], "high");
		const third = [user("first"), assistant, user("second"), assistant, user("third")];
		expect(planStableOpenAIEffort(state, third, "medium")).toBe("low");
		expect(third).toEqual([
			user("first"),
			assistant,
			update("high"),
			user("second"),
			assistant,
			update("medium"),
			user("third"),
		]);
		const replay = [user("first"), assistant, user("second"), assistant, user("third")];
		expect(planStableOpenAIEffort(state, replay, "medium")).toBe("low");
		expect(replay).toEqual(third);
		const changeBack = [user("first"), assistant, user("second"), assistant, user("third")];
		expect(planStableOpenAIEffort(state, changeBack, "low")).toBe("low");
		expect(changeBack).toEqual([
			user("first"),
			assistant,
			update("high"),
			user("second"),
			assistant,
			update("low"),
			user("third"),
		]);
		const fourth = [user("first"), assistant, user("second"), assistant, user("third"), assistant, user("fourth")];
		expect(planStableOpenAIEffort(state, fourth, "low")).toBe("low");
		expect(fourth).toEqual([...changeBack, assistant, user("fourth")]);
	});
	it("places an in-loop change after tool output and coalesces changes at the same position", () => {
		const state = createOpenAIEffortControlState<string>();
		planStableOpenAIEffort(state, [user("first")], "low");
		const output: Item = { type: "function_call_output", content: "result" };
		const input = [user("first"), output];
		planStableOpenAIEffort(state, input, "high");
		expect(input).toEqual([user("first"), output, update("high")]);
		const retry = [user("first"), output];
		planStableOpenAIEffort(state, retry, "medium");
		expect(retry).toEqual([user("first"), output, update("medium")]);
		const undo = [user("first"), output];
		planStableOpenAIEffort(state, undo, "low");
		expect(undo).toEqual([user("first"), output]);
	});
	it("ignores replay lifecycle fields but re-baselines shortened or rewritten history", () => {
		for (const replacement of [
			[user("compacted")],
			[user("first"), { ...assistant, content: "rewritten" }, user("second")],
		]) {
			const state = createOpenAIEffortControlState<string>();
			planStableOpenAIEffort(state, [user("first")], "low");
			planStableOpenAIEffort(
				state,
				[user("first"), { ...assistant, id: "fake-id", status: "completed" }, user("second")],
				"high",
			);
			const replay = [user("first"), assistant, user("second")];
			expect(planStableOpenAIEffort(state, replay, "high")).toBe("low");
			expect(replay[2]).toEqual(update("high"));
			expect(planStableOpenAIEffort(state, replacement, "medium")).toBe("medium");
			expect(replacement.some(item => item.type === "configuration_update")).toBe(false);
		}
	});
	it("bounds independent conversations and evicts the least recently used baseline", () => {
		const states = new Map<string, OpenAIEffortControlState<string>>();
		for (let i = 0; i < 16; i++)
			planStableOpenAIEffort(getOpenAIEffortControlState(states, String(i)), [user("first")], "low");
		expect(planStableOpenAIEffort(getOpenAIEffortControlState(states, "0"), [user("first")], "high")).toBe("low");
		getOpenAIEffortControlState(states, "16");
		expect([...states.keys()]).toEqual([
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
			"8",
			"9",
			"10",
			"11",
			"12",
			"13",
			"14",
			"15",
			"0",
			"16",
		]);
		expect(planStableOpenAIEffort(getOpenAIEffortControlState(states, "1"), [user("first")], "high")).toBe("high");
	});
});
