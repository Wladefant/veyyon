/**
 * WHY: a `session_stop` handler that returns a continuation starts another turn, and that turn's
 * final stop runs the handlers again. The chain is held by one collaborator, `SessionStopHook`, and
 * the defects at that boundary share one shape: a chain that does not end. A count that survives an
 * abort reports `stop_hook_active: true` to the first stop of the next prompt; a result that arrives
 * after an abort or a dispose queues a turn nobody asked for; a cap that is not enforced lets a
 * handler that always continues run the session forever.
 *
 * The class this closes is a continuation chain that outlives what ended it. Every way a chain ends
 * runs through one table, and each case proves the next pass reports `stop_hook_active: false`.
 *
 * What it does not catch: whether `AgentSession` calls `run` at every final stop, and only for a
 * top-level session with a `session_stop` handler (`agent-session-concurrent` drives a real
 * session through two chained stops), and the event fan-out across several handlers, which
 * `extensions-runner` owns.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionStopEvent, SessionStopEventResult } from "@veyyon/coding-agent/extensibility/extensions";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import { SESSION_STOP_CONTINUATION_CAP } from "@veyyon/coding-agent/session/nudges";
import { SessionStopHook } from "@veyyon/coding-agent/session/runtime/session-stop-hook";
import { createAssistantMessage } from "../helpers/agent-session-setup";

type StopEvent = Omit<SessionStopEvent, "type">;
type Respond = (event: StopEvent, harness: Harness) => Promise<SessionStopEventResult | undefined>;

interface Harness {
	readonly hook: SessionStopHook;
	readonly events: StopEvent[];
	readonly queued: CustomMessage[];
	halted: boolean;
	generation: number;
	respond: Respond;
}

function harness(respond: Respond): Harness {
	const state = {
		events: [] as StopEvent[],
		queued: [] as CustomMessage[],
		halted: false,
		generation: 0,
		respond,
	};
	const hook = new SessionStopHook({
		isHalted: () => state.halted,
		stopHookRunner: () => ({
			emitSessionStop: async event => {
				state.events.push(event);
				return state.respond(event, h);
			},
		}),
		promptGeneration: () => state.generation,
		turnId: () => 4,
		sessionId: () => "session-a",
		sessionFile: () => "/repo/.sessions/session-a.jsonl",
		queueContinuation: message => {
			state.queued.push(message);
		},
	});
	const h: Harness = Object.assign(state, { hook });
	return h;
}

const continueWith =
	(text: string): Respond =>
	async () => ({ continue: true, additionalContext: text });

const stopMessages: AgentMessage[] = [];
const lastAssistant = createAssistantMessage("done");

async function pass(h: Harness): Promise<void> {
	await h.hook.run(stopMessages, lastAssistant);
}

describe("SessionStopHook", () => {
	it("reports the stop it ran on and queues each continuation hidden for the next turn", async () => {
		const h = harness(continueWith("check the tests again"));
		await pass(h);
		await pass(h);

		expect(h.events).toHaveLength(2);
		const [first, second] = h.events;
		expect(first.messages).toBe(stopMessages);
		expect(first.last_assistant_message).toBe(lastAssistant);
		expect(first.turn_id).toBe(4);
		expect(first.session_id).toBe("session-a");
		expect(first.session_file).toBe("/repo/.sessions/session-a.jsonl");
		expect([first.stop_hook_active, second.stop_hook_active]).toEqual([false, true]);
		expect(h.queued.map(({ timestamp: _, ...rest }) => rest)).toEqual([
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: "check the tests again",
				display: false,
				attribution: "agent",
			},
			{
				role: "custom",
				customType: "session-stop-continuation",
				content: "check the tests again",
				display: false,
				attribution: "agent",
			},
		]);
	});

	it.each([
		{
			name: "continue with context",
			result: { continue: true, additionalContext: "ctx", reason: "why" },
			text: "ctx",
		},
		{ name: "continue with a reason only", result: { continue: true, reason: "why" }, text: "why" },
		{
			name: "continue with empty context",
			result: { continue: true, additionalContext: "", reason: "why" },
			text: "why",
		},
		{
			name: "block with a reason",
			result: { decision: "block", additionalContext: "ctx", reason: "why" },
			text: "why",
		},
		{ name: "block with context only", result: { decision: "block", additionalContext: "ctx" }, text: "ctx" },
		{
			name: "context without continue or block",
			result: { additionalContext: "ctx", reason: "why" },
			text: undefined,
		},
		{ name: "continue with no text", result: { continue: true }, text: undefined },
		{ name: "no result", result: undefined, text: undefined },
	] as { name: string; result: SessionStopEventResult | undefined; text: string | undefined }[])(
		"$name continues with $text",
		async ({ result, text }) => {
			const h = harness(async () => result);
			await pass(h);
			expect(h.queued.map(message => message.content)).toEqual(text === undefined ? [] : [text]);
		},
	);

	it("drops the continuation past the cap and starts the next chain fresh", async () => {
		const h = harness(continueWith("again"));
		for (let i = 0; i < SESSION_STOP_CONTINUATION_CAP + 2; i++) await pass(h);

		expect(h.events.map(event => event.stop_hook_active)).toEqual([
			false,
			...Array.from({ length: SESSION_STOP_CONTINUATION_CAP }, () => true),
			false,
		]);
		// The pass at the cap queues nothing; the pass after it begins a new chain and queues again.
		expect(h.queued).toHaveLength(SESSION_STOP_CONTINUATION_CAP + 1);
	});

	it.each([
		{
			name: "a pass that continues nothing",
			end: async (h: Harness) => {
				h.respond = async () => undefined;
				await pass(h);
			},
		},
		{
			name: "reset",
			end: async (h: Harness) => h.hook.reset(),
		},
		{
			name: "a halt before the pass",
			end: async (h: Harness) => {
				h.halted = true;
				await pass(h);
				h.halted = false;
			},
		},
		{
			name: "an abort while the handlers run",
			end: async (h: Harness) => {
				h.respond = async () => {
					h.generation++;
					return { continue: true, additionalContext: "late" };
				};
				await pass(h);
			},
		},
		{
			name: "a dispose while the handlers run",
			end: async (h: Harness) => {
				h.respond = async () => {
					h.halted = true;
					return { continue: true, additionalContext: "late" };
				};
				await pass(h);
				h.halted = false;
			},
		},
	] as { name: string; end: (h: Harness) => Promise<void> }[])("$name ends the chain", async ({ end }) => {
		const h = harness(continueWith("first"));
		await pass(h);
		expect(h.queued).toHaveLength(1);

		await end(h);
		expect(h.queued).toHaveLength(1);

		h.respond = continueWith("next");
		await pass(h);
		expect(h.events.at(-1)?.stop_hook_active).toBe(false);
		expect(h.queued.at(-1)?.content).toBe("next");
	});
});
