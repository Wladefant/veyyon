// WHY: Telegram answers reach a session at least once (the sender retries until it sees an ack), so the same
// operator answer can arrive twice, or once before a crash and once after the restart (#668). The receiver must
// journal the question id before it injects, treat the answer's own user message as the consumption record, and
// inject nothing for a question already consumed.
// Gap: this drives the inbox against a real file-backed SessionManager; the terminal-control wiring that calls it
// (which manager it reads, how it asks the runtime queue) is not exercised here, and a dequeue between the runtime
// taking an answer and journaling it is the one window a retry can inject twice.
import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, TempDir } from "@veyyon/utils";
import { OperatorAnswerInbox, operatorAnswerQuestionId } from "../src/session/operator-answer-inbox";

const dirs: TempDir[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) dir.removeSync();
});

const envelope = (question: string, event: string, body = "the secret answer text") =>
	`[operator-answer question=${question} event=${event}] ${body}`;

function newSession(): { manager: SessionManager; dir: TempDir } {
	const dir = TempDir.createSync("@operator-answer-");
	dirs.push(dir);
	return { manager: SessionManager.create(dir.path(), dir.path()), dir };
}

/** Injection as the live session does it: the answer becomes a user message in the journal. */
function injectingInto(manager: SessionManager, injected: string[]) {
	return async (text: string) => {
		injected.push(text);
		manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		return "queued";
	};
}

test("only the operator envelope is an answer; ordinary input is left to the normal path", async () => {
	const { manager } = newSession();
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(() => manager, injectingInto(manager, injected), () => false);
	expect(operatorAnswerQuestionId("hello")).toBeUndefined();
	expect(await inbox.accept("hello", "auto")).toBeUndefined();
	expect(injected).toEqual([]);
});

test("the first deliver injects the answer once; a replay and a repeated update event inject nothing and log no answer text", async () => {
	const { manager } = newSession();
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(() => manager, injectingInto(manager, injected), () => false);
	const info = spyOn(logger, "info").mockImplementation(() => {});
	try {
		expect(await inbox.accept(envelope("q-1", "evt-1"), "auto")).toBe("queued");
		expect(await inbox.accept(envelope("q-1", "evt-1"), "auto")).toBe("duplicate");
		expect(await inbox.accept(envelope("q-1", "evt-2"), "auto")).toBe("duplicate");
		expect(injected).toHaveLength(1);
		const logged = info.mock.calls.map(call => String(call[0]));
		expect(logged).toEqual(["DUPLICATE-ANSWER q-1", "DUPLICATE-ANSWER q-1"]);
		expect(logged.join("\n")).not.toContain("secret answer text");
	} finally {
		info.mockRestore();
	}
});

test("a distinct question is still injected after another was consumed", async () => {
	const { manager } = newSession();
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(() => manager, injectingInto(manager, injected), () => false);
	await inbox.accept(envelope("q-1", "evt-1"), "auto");
	expect(await inbox.accept(envelope("q-2", "evt-2"), "auto")).toBe("queued");
	expect(injected).toHaveLength(2);
});

test("after a restart a consumed question injects nothing, even replayed with a new event id", async () => {
	const { manager, dir } = newSession();
	const injected: string[] = [];
	const before = new OperatorAnswerInbox(() => manager, injectingInto(manager, injected), () => false);
	await before.accept(envelope("q-1", "evt-1"), "auto");
	await manager.flush();
	const file = manager.getSessionFile();
	expect(file).toBeString();

	const reopened = await SessionManager.open(file as string, dir.path());
	const afterRestart: string[] = [];
	const inbox = new OperatorAnswerInbox(() => reopened, injectingInto(reopened, afterRestart), () => false);
	await inbox.recover();
	expect(await inbox.accept(envelope("q-1", "evt-9"), "auto")).toBe("duplicate");
	expect(afterRestart).toEqual([]);
});

test("a crash after the answer was journaled but before it was injected re-injects it exactly once on recovery", async () => {
	const { manager, dir } = newSession();
	const failing = new OperatorAnswerInbox(
		() => manager,
		async () => {
			throw new Error("crashed before injection");
		},
		() => false,
	);
	await expect(failing.accept(envelope("q-1", "evt-1"), "followUp")).rejects.toThrow("crashed before injection");
	await manager.flush();
	const file = manager.getSessionFile();
	expect(file).toBeString();

	const reopened = await SessionManager.open(file as string, dir.path());
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(() => reopened, injectingInto(reopened, injected), () => false);
	await inbox.recover();
	await inbox.recover();
	expect(injected).toEqual([envelope("q-1", "evt-1")]);
	// The sender's retry of the same question after recovery is a replay, not a second injection.
	expect(await inbox.accept(envelope("q-1", "evt-1"), "followUp")).toBe("duplicate");
	expect(injected).toHaveLength(1);
});

/** A runtime queue as the live session keeps it: an answer waits there until the agent consumes it. */
function queueingInto(queue: string[]) {
	return async (text: string) => {
		queue.push(text);
		return "queued";
	};
}
const waiting = (queue: string[]) => (questionId: string) =>
	queue.some(text => operatorAnswerQuestionId(text) === questionId);

test("an answer is journaled in the session that receives it, after a session switch", async () => {
	const first = newSession();
	const second = newSession();
	const current = { manager: first.manager };
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(() => current.manager, async text => {
		injected.push(text);
		current.manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		return "queued";
	}, () => false);
	await inbox.accept(envelope("q-1", "evt-1"), "auto");

	current.manager = second.manager;
	expect(await inbox.accept(envelope("q-2", "evt-2"), "auto")).toBe("queued");
	await second.manager.flush();

	const inSecond = second.manager.getEntries();
	const inFirst = first.manager.getEntries();
	expect(inSecond.some(entry => entry.type === "custom" && JSON.stringify(entry.data).includes("q-2"))).toBe(true);
	expect(inFirst.some(entry => JSON.stringify(entry).includes("q-2"))).toBe(false);

	const file = second.manager.getSessionFile();
	const reopened = await SessionManager.open(file as string, second.dir.path());
	const afterRestart: string[] = [];
	const restarted = new OperatorAnswerInbox(() => reopened, injectingInto(reopened, afterRestart), () => false);
	expect(await restarted.accept(envelope("q-2", "evt-3"), "auto")).toBe("duplicate");
	expect(afterRestart).toEqual([]);
});

test("an answer the operator cleared from the runtime queue is delivered again by the sender's retry", async () => {
	const { manager } = newSession();
	const queue: string[] = [];
	const inbox = new OperatorAnswerInbox(() => manager, queueingInto(queue), waiting(queue));
	expect(await inbox.accept(envelope("q-1", "evt-1"), "followUp")).toBe("queued");
	expect(await inbox.accept(envelope("q-1", "evt-1"), "followUp")).toBe("duplicate");
	queue.length = 0;
	expect(await inbox.accept(envelope("q-1", "evt-1"), "followUp")).toBe("queued");
	expect(queue).toEqual([envelope("q-1", "evt-1")]);
});

test("two deliveries of one question at the same moment inject it once", async () => {
	const { manager } = newSession();
	const queue: string[] = [];
	const inbox = new OperatorAnswerInbox(() => manager, queueingInto(queue), waiting(queue));
	const results = await Promise.all([
		inbox.accept(envelope("q-1", "evt-1"), "auto"),
		inbox.accept(envelope("q-1", "evt-1"), "auto"),
	]);
	expect([...results].sort()).toEqual(["duplicate", "queued"]);
	expect(queue).toHaveLength(1);
});

test("a record the build cannot read neither stops startup nor blocks the next answer", async () => {
	const { manager } = newSession();
	manager.appendCustomEntry("terminal:operator-answer", "not an object");
	manager.appendCustomEntry("terminal:operator-answer", {
		version: 2,
		sessionId: manager.getSessionId(),
		questionId: "q-old",
		inputId: "operator-answer:q-old",
		text: envelope("q-old", "evt-0"),
		mode: "auto",
	});
	manager.appendCustomEntry("terminal:operator-answer", {
		version: 1,
		sessionId: manager.getSessionId(),
		questionId: "q-bad",
		inputId: "wrong",
		text: envelope("q-bad", "evt-0"),
		mode: "sideways",
	});
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(() => manager, injectingInto(manager, injected), () => false);
	await inbox.recover();
	expect(injected).toEqual([]);
	expect(await inbox.accept(envelope("q-1", "evt-1"), "auto")).toBe("queued");
	expect(injected).toEqual([envelope("q-1", "evt-1")]);
});

test("a recovery that cannot inject leaves the answer pending for the sender's retry instead of failing startup", async () => {
	const { manager, dir } = newSession();
	const failing = new OperatorAnswerInbox(() => manager, async () => {
		throw new Error("not ready");
	}, () => false);
	await expect(failing.accept(envelope("q-1", "evt-1"), "auto")).rejects.toThrow("not ready");
	await manager.flush();

	const reopened = await SessionManager.open(manager.getSessionFile() as string, dir.path());
	const stillFailing = new OperatorAnswerInbox(() => reopened, async () => {
		throw new Error("not ready");
	}, () => false);
	await expect(stillFailing.recover()).resolves.toBeUndefined();

	const injected: string[] = [];
	const ready = new OperatorAnswerInbox(() => reopened, injectingInto(reopened, injected), () => false);
	expect(await ready.accept(envelope("q-1", "evt-1"), "auto")).toBe("queued");
	expect(injected).toEqual([envelope("q-1", "evt-1")]);
});


test("repeated recovery and reconnect never requeue a pending answer already held by the runtime", async () => {
	const { manager, dir } = newSession();
	const answer = envelope("q-reconnect", "evt-original");
	const beforeCrash = new OperatorAnswerInbox(
		() => manager,
		async () => {
			throw new Error("crash before the queued user message was committed");
		},
		() => false,
	);
	await expect(beforeCrash.accept(answer, "followUp")).rejects.toThrow("crash before");
	const file = manager.getSessionFile();
	expect(file).toBeString();
	const reopened = await SessionManager.open(file as string, dir.path());
	const queue: string[] = [];
	const first = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	await first.recover();
	expect(queue).toEqual([answer]);

	// The pending journal has not yet been consumed. It is not permission to enqueue the same answer again.
	await first.recover();
	expect(queue).toEqual([answer]);
	const reconnected = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	await reconnected.recover();
	expect(queue).toEqual([answer]);

	// A deliberately cleared queue does not count as delivery; recover it again from the original journal.
	queue.length = 0;
	await reconnected.recover();
	expect(queue).toEqual([answer]);
	// Once the answer's own user entry is persisted, no later reconnect or sender replay may inject it.
	reopened.appendMessage({ role: "user", content: answer, timestamp: Date.now() });
	await reopened.flush();
	queue.length = 0;
	const consumed = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	await consumed.recover();
	expect(queue).toEqual([]);
	expect(await consumed.accept(envelope("q-reconnect", "evt-replay"), "followUp")).toBe("duplicate");
	expect(queue).toEqual([]);
});
