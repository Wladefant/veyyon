/**
 * WHY: recalled memory reaches the model through one collaborator, `MemoryContext`, as a
 * `memory-context` message at the context tail. The defects at that boundary share one shape: the
 * model reads a block a number of times other than once per transcript. An unchanged recall resent
 * every turn grows the context for no new information; a block queued mid-run and then collected
 * at the next prompt is sent twice; a block a compaction or a rewind took out of the context, or a
 * prompt collected and then abandoned, is never sent again because a record of what was sent says
 * the model has it; a block is never sent to a new transcript, or sent twice to a fork that already
 * carries it; a hook that throws takes the whole turn's context with it; a rekey or reset reaches the
 * backend that is not active; a session that ends drops Hindsight's state before its retain queue
 * flushed, and the queue discards the batch as `session vanished`, or leaves a backend undisposed.
 *
 * The class this closes is a memory block delivered zero or two times to a transcript that needs it
 * once, or backend state touched for a backend that is not selected. Each case drives the real
 * collaborator against a scripted backend and real message arrays; `deliver` lands a block in those
 * messages the way a sent request does, and a block not landed was never sent.
 *
 * What it does not catch: which session paths call `rekey` and `resetForNewTranscript`
 * (`memory-context-rides-the-tail` drives `/new`, a session switch and a real Hindsight backend
 * through `AgentSession`), and what a backend recalls.
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { HindsightSessionState } from "@veyyon/coding-agent/memory/hindsight/state";
import type { MnemopiSessionState } from "@veyyon/coding-agent/memory/mnemopi/state";
import { MEMORY_CONTEXT_MESSAGE_TYPE } from "@veyyon/coding-agent/session/nudges";
import {
	lastDeliveredBlock,
	MemoryContext,
	type SessionMemoryBackend,
} from "@veyyon/coding-agent/session/runtime/memory-context";

const SESSION = { name: "session" } as const;
type Session = typeof SESSION;

interface BackendState {
	readonly calls: string[];
	aliasOf?: object;
	setSessionId(sessionId: string): void;
	resetConversationTracking(): void;
	flushRetainQueue(): Promise<void>;
	dispose(options?: { timeoutMs?: number }): Promise<void>;
}

/** A backend state that records each call, with whether the session still holds it (`held`). */
function backendState(label: string, calls: string[], held: () => boolean): BackendState {
	return {
		calls,
		setSessionId: sessionId => calls.push(`${label}.setSessionId(${sessionId})`),
		resetConversationTracking: () => calls.push(`${label}.reset`),
		flushRetainQueue: async () => void calls.push(`${label}.flush(held=${held()})`),
		dispose: async options => void calls.push(`${label}.dispose(held=${held()}, timeoutMs=${options?.timeoutMs})`),
	};
}

interface Script {
	backendId: string;
	sessionId: string | undefined;
	recall?: string | Error;
	volatile?: string | Error;
	messages: AgentMessage[];
}

function harness(script: Partial<Script> = {}) {
	const state: Script = { backendId: "hindsight", sessionId: "sid-1", messages: [], ...script };
	const calls: string[] = [];
	let memory: MemoryContext<Session> | undefined;
	let mnemopiAttached = true;
	const hindsight: BackendState = backendState("hindsight", calls, () => (memory?.hindsight as unknown) === hindsight);
	const mnemopi = backendState("mnemopi", calls, () => mnemopiAttached);
	const answer = (value: string | Error | undefined): Promise<string | undefined> =>
		value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
	const backend: SessionMemoryBackend<Session> = {
		id: "scripted",
		beforeAgentStartPrompt: (session, promptText) => {
			calls.push(`recall(${session.name}, ${promptText})`);
			return answer(state.recall);
		},
		buildVolatileContext: session => {
			calls.push(`volatile(${session.name})`);
			return answer(state.volatile);
		},
	};
	memory = new MemoryContext<Session>({
		session: SESSION,
		backend: async () => backend,
		backendId: () => state.backendId,
		sessionId: () => state.sessionId,
		mnemopiState: () => (mnemopiAttached ? (mnemopi as unknown as MnemopiSessionState) : undefined),
		detachMnemopiState: () => {
			if (!mnemopiAttached) return undefined;
			mnemopiAttached = false;
			return mnemopi as unknown as MnemopiSessionState;
		},
		messages: () => state.messages,
	});
	memory.swapHindsight(hindsight as unknown as HindsightSessionState);
	return { state, calls, memory, hindsight, mnemopi, backend };
}

function block(content: string): AgentMessage {
	return {
		role: "custom",
		customType: MEMORY_CONTEXT_MESSAGE_TYPE,
		content,
		display: false,
		attribution: "agent",
		timestamp: 1,
	};
}

/** Land a collected or taken block in the live context, as a request that sends it does. */
function deliver(state: Script, message: AgentMessage | null): void {
	if (!message) throw new Error("expected a block to deliver");
	state.messages = [...state.messages, message];
}

function contentOf(message: AgentMessage | null): string | undefined {
	if (!message) return undefined;
	expect(message.role).toBe("custom");
	return message.role === "custom" && message.customType === MEMORY_CONTEXT_MESSAGE_TYPE
		? (message.content as string)
		: undefined;
}

describe("collecting a turn's memory", () => {
	it("joins the recall and the volatile context, each trimmed, once", async () => {
		const { memory, calls } = harness({ recall: "  recalled  ", volatile: "\nvolatile\n" });
		expect(contentOf(await memory.collect("question"))).toBe("recalled\n\nvolatile");
		expect(calls).toEqual(["recall(session, question)", "volatile(session)"]);
	});

	it("drops a volatile context identical to the recall", async () => {
		const { memory } = harness({ recall: "same", volatile: " same " });
		expect(contentOf(await memory.collect("question"))).toBe("same");
	});

	it("does not resend an unchanged block, and sends a changed one", async () => {
		const { memory, state } = harness({ volatile: "facts" });
		const first = await memory.collect("first");
		expect(contentOf(first)).toBe("facts");
		deliver(state, first);
		expect(await memory.collect("second")).toBeNull();
		state.volatile = "new facts";
		expect(contentOf(await memory.collect("third"))).toBe("new facts");
	});

	it("collects an unchanged block again when the prompt that collected it never sent it", async () => {
		const { memory } = harness({ volatile: "facts" });
		expect(contentOf(await memory.collect("abandoned"))).toBe("facts");
		expect(contentOf(await memory.collect("retried"))).toBe("facts");
	});

	it("collects an unchanged block again once a rewrite took it out of the context", async () => {
		const { memory, state } = harness({ volatile: "facts" });
		state.messages = [block("facts")];
		expect(await memory.collect("before")).toBeNull();
		state.messages = [];
		expect(contentOf(await memory.collect("after"))).toBe("facts");
	});

	it("skips a hook that throws and keeps what the other reported", async () => {
		const recallFails = harness({ recall: new Error("recall down"), volatile: "volatile" });
		expect(contentOf(await recallFails.memory.collect("question"))).toBe("volatile");
		const volatileFails = harness({ recall: "recalled", volatile: new Error("volatile down") });
		expect(contentOf(await volatileFails.memory.collect("question"))).toBe("recalled");
	});

	it("returns nothing when the backend reports nothing", async () => {
		const { memory } = harness({ recall: "  ", volatile: undefined });
		expect(await memory.collect("question")).toBeNull();
	});
});

describe("a block published mid-run", () => {
	it("waits for the next step boundary and is taken once", async () => {
		const { memory } = harness({ volatile: "mid-run" });
		expect(await memory.publish("recall")).toBe(true);
		expect(contentOf(memory.takePending())).toBe("mid-run");
		expect(memory.takePending()).toBeNull();
	});

	it("is not queued when the conversation already carries it", async () => {
		const { memory, state } = harness({ volatile: "facts" });
		deliver(state, await memory.collect("question"));
		expect(await memory.publish("reload")).toBe(false);
		expect(memory.takePending()).toBeNull();
	});

	it("is not sent again by the next prompt once taken, and is dropped when the prompt delivers it", async () => {
		const taken = harness({ volatile: "facts" });
		await taken.memory.publish("recall");
		deliver(taken.state, taken.memory.takePending());
		expect(await taken.memory.collect("next")).toBeNull();

		const collected = harness({ volatile: "facts" });
		await collected.memory.publish("recall");
		expect(contentOf(await collected.memory.collect("next"))).toBe("facts");
		expect(collected.memory.takePending()).toBeNull();
	});

	it("is consumed by the boundary that finds the context already carrying it", async () => {
		const { memory, state } = harness({ volatile: "facts" });
		await memory.publish("recall");
		state.messages = [block("facts")];
		expect(memory.takePending()).toBeNull();
		state.messages = [];
		expect(memory.takePending()).toBeNull();
	});

	it("is offered again by the next prompt when the boundary that took it never sent it", async () => {
		const { memory } = harness({ volatile: "facts" });
		await memory.publish("recall");
		expect(contentOf(memory.takePending())).toBe("facts");
		expect(contentOf(await memory.collect("next"))).toBe("facts");
	});

	it("is dropped when the next prompt delivers a newer block", async () => {
		const { memory, state } = harness({ volatile: "older" });
		await memory.publish("recall");
		state.volatile = "newer";
		expect(contentOf(await memory.collect("next"))).toBe("newer");
		expect(memory.takePending()).toBeNull();
	});

	it("is not queued when the backend throws or has no volatile context", async () => {
		const failing = harness({ volatile: new Error("down") });
		expect(await failing.memory.publish("recall")).toBe(false);
		expect(failing.memory.takePending()).toBeNull();

		const { memory, backend } = harness({ volatile: "facts" });
		delete (backend as { buildVolatileContext?: unknown }).buildVolatileContext;
		expect(await memory.publish("recall")).toBe(false);
	});
});

describe("a new transcript", () => {
	it("is told an identical recall again when it carries no block", async () => {
		const { memory, state } = harness({ volatile: "facts" });
		deliver(state, await memory.collect("question"));
		state.messages = [];
		memory.resetForNewTranscript();
		expect(contentOf(await memory.collect("question"))).toBe("facts");
	});

	it("is not told a block it already carries", async () => {
		const { memory, state } = harness({ volatile: "facts" });
		state.messages = [block("older"), block("facts")];
		memory.resetForNewTranscript();
		expect(await memory.collect("question")).toBeNull();
	});

	it("drops a block queued for the conversation being left", async () => {
		const { memory } = harness({ volatile: "facts" });
		await memory.publish("recall");
		memory.resetForNewTranscript();
		expect(memory.takePending()).toBeNull();
	});

	it("resets only the active backend's tracking, and never an alias's", () => {
		for (const backendId of ["hindsight", "mnemopi", "local", "off"]) {
			const { memory, calls } = harness({ backendId });
			memory.resetForNewTranscript();
			expect(calls).toEqual(backendId === "hindsight" || backendId === "mnemopi" ? [`${backendId}.reset`] : []);
		}
		const aliased = harness({ backendId: "mnemopi" });
		aliased.mnemopi.aliasOf = {};
		aliased.memory.resetForNewTranscript();
		expect(aliased.calls).toEqual([]);
	});
});

describe("rekeying the backend", () => {
	it("points only the active backend's state at the current session id", () => {
		for (const backendId of ["hindsight", "mnemopi", "local", "off"]) {
			const { memory, calls } = harness({ backendId, sessionId: "sid-2" });
			memory.rekey();
			expect(calls).toEqual(
				backendId === "hindsight" || backendId === "mnemopi" ? [`${backendId}.setSessionId(sid-2)`] : [],
			);
		}
	});

	it("does nothing while the agent has no session id", () => {
		const { memory, calls } = harness({ sessionId: undefined });
		memory.rekey();
		expect(calls).toEqual([]);
	});

	it("reaches the Hindsight state that replaced the old one, and none after it is cleared", () => {
		const { memory, calls, hindsight } = harness();
		const replacement = backendState("replacement", calls, () => false);
		expect(memory.swapHindsight(replacement as unknown as HindsightSessionState)).toBe(
			hindsight as unknown as HindsightSessionState,
		);
		memory.rekey();
		expect(memory.swapHindsight(undefined)).toBe(replacement as unknown as HindsightSessionState);
		memory.rekey();
		expect(calls).toEqual(["replacement.setSessionId(sid-1)"]);
	});
});

describe("the session's end", () => {
	it("flushes Hindsight while the session still holds it, then drops and disposes both backends", async () => {
		const { memory, calls } = harness();

		await memory.release(1_234);

		expect(calls).toEqual([
			"hindsight.flush(held=true)",
			"hindsight.dispose(held=false, timeoutMs=undefined)",
			"mnemopi.dispose(held=false, timeoutMs=1234)",
		]);
		expect(memory.hindsight).toBeUndefined();
	});
});

describe("the last delivered block", () => {
	it("is the newest block of the type, and undefined when none is a string", () => {
		const other: AgentMessage = { ...block("other"), customType: "session-state" } as AgentMessage;
		expect(lastDeliveredBlock([block("old"), block("new"), other], MEMORY_CONTEXT_MESSAGE_TYPE)).toBe("new");
		expect(lastDeliveredBlock([other], MEMORY_CONTEXT_MESSAGE_TYPE)).toBeUndefined();
		const structured = { ...block(""), content: [{ type: "text", text: "x" }] } as AgentMessage;
		expect(lastDeliveredBlock([block("old"), structured], MEMORY_CONTEXT_MESSAGE_TYPE)).toBeUndefined();
	});
});
