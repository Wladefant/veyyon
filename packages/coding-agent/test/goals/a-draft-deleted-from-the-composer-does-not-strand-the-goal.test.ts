/**
 * WHY: a goal sat idle with no warning. A continuation that comes due while the composer holds a
 * draft or attached images is held, so goal mode never types over the operator. Deleting the draft
 * without sending it left the hold in place: nothing armed the continuation again, the status line
 * still read `Goal`, and the goal waited for a message nobody was going to send.
 *
 * The class this closes: a continuation held by the composer is released by the composer emptying,
 * whichever way the hold came about (the draft was there when the continuation armed, or typed
 * during its delay) and whichever way the composer empties (keystrokes, or a cleared draft that
 * also drops its images). A composer that still holds something keeps the hold.
 *
 * What it does not catch: a composer emptied mid-turn after a hold, which arms nothing here only
 * because a starting turn cancels the hold, and is observable only as a busy-wait warning after
 * five minutes of streaming.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { MockResponse } from "@veyyon/ai/providers/mock";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { createGoalSession, flushMicrotasks, type GoalSession, NOTE_TOOL } from "../helpers/goal-session";

const toolCall = (id: string): MockResponse => ({
	content: [{ type: "toolCall", id, name: NOTE_TOOL, arguments: {} }],
});

/** The delay goal mode waits before it opens a continuation. */
const CONTINUATION_DELAY_MS = 800;

const BACKSPACE = "\x7f";

describe("a draft deleted from the composer does not strand the goal", () => {
	let goal: GoalSession | undefined;
	let submitted: SubmittedUserInput[] = [];

	beforeAll(() => {
		initTheme();
	});

	beforeEach(() => {
		vi.restoreAllMocks();
		submitted = [];
	});

	afterEach(async () => {
		vi.useRealTimers();
		await goal?.dispose();
		goal = undefined;
	});

	/** A session with an active goal, waiting at the composer the way the interactive loop does. */
	const atComposer = async (): Promise<GoalSession> => {
		goal = await createGoalSession([toolCall("tc-1"), { content: ["ok"], stopReason: "stop" }], {
			"goal.enabled": true,
		});
		await goal.session.goalRuntime.createGoal({ objective: "Ship the release" });
		await flushMicrotasks();
		return goal;
	};

	/** Wait for input, which arms the continuation the goal owes. */
	const waitForInput = async (g: GoalSession): Promise<void> => {
		vi.useFakeTimers();
		void g.mode.getUserInput().then(input => submitted.push(input));
		await flushMicrotasks();
	};

	const letDelayPass = async (): Promise<void> => {
		vi.advanceTimersByTime(CONTINUATION_DELAY_MS);
		await flushMicrotasks();
	};

	const type = (g: GoalSession, keys: string): void => {
		for (const key of keys) g.mode.editor.handleInput(key);
	};

	it("opens the held continuation once a draft present when it armed is deleted", async () => {
		const g = await atComposer();
		type(g, "i");
		await waitForInput(g);
		await letDelayPass();
		expect(submitted).toEqual([]);

		type(g, BACKSPACE);
		await letDelayPass();
		expect(submitted.map(input => input.customType)).toEqual(["goal-continuation"]);
		expect(g.warnings).toEqual([]);
	});

	it("opens the held continuation once a draft typed during its delay is deleted", async () => {
		const g = await atComposer();
		await waitForInput(g);
		type(g, "no");
		await letDelayPass();
		expect(submitted).toEqual([]);

		type(g, BACKSPACE + BACKSPACE);
		await letDelayPass();
		expect(submitted.map(input => input.customType)).toEqual(["goal-continuation"]);
	});

	it("keeps holding while the composer still has text", async () => {
		const g = await atComposer();
		type(g, "no");
		await waitForInput(g);
		await letDelayPass();

		type(g, BACKSPACE);
		await letDelayPass();
		type(g, "  ");
		await letDelayPass();
		expect(g.mode.editor.getText()).toBe("n  ");
		expect(submitted).toEqual([]);
	});

	it("opens the held continuation once a cleared draft drops its attached images", async () => {
		const g = await atComposer();
		g.mode.editor.pendingImages.push({ type: "image", data: "aGk=", mimeType: "image/png" });
		await waitForInput(g);
		await letDelayPass();
		expect(submitted).toEqual([]);

		g.mode.editor.clearDraft();
		await letDelayPass();
		expect(submitted.map(input => input.customType)).toEqual(["goal-continuation"]);
	});
});
