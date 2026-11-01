// WHY: Telegram answers reach a session at least once (the sender retries until it sees an ack), so the same
// operator answer can arrive twice, or once before a crash and once after the restart (#668). The receiver must
// journal the question id before it injects, treat the answer's own user message as the consumption record, and
// inject nothing for a question already consumed.
// Gap: this drives the inbox against a real file-backed SessionManager; the terminal-control wiring that calls it
// (which manager it reads, how it asks the runtime queue) is not exercised here, and a dequeue between the runtime
// taking an answer and journaling it is the one window a retry can inject twice.
import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
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


test("an unavailable runtime queue during recovery does not block startup or consume the pending answer", async () => {
	const { manager, dir } = newSession();
	const answer = envelope("q-queue-unavailable", "evt-1");
	const beforeCrash = new OperatorAnswerInbox(
		() => manager,
		async () => {
			throw new Error("crash before user-message persistence");
		},
		() => false,
	);
	await expect(beforeCrash.accept(answer, "auto")).rejects.toThrow("crash before");
	const reopened = await SessionManager.open(manager.getSessionFile() as string, dir.path());
	const queue: string[] = [];
	const unavailable = new OperatorAnswerInbox(
		() => reopened,
		queueingInto(queue),
		() => {
			throw new Error("runtime queue not ready");
		},
	);
	await expect(unavailable.recover()).resolves.toBeUndefined();
	expect(queue).toEqual([]);
	const ready = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	await ready.recover();
	expect(queue).toEqual([answer]);
});

test("a sender retry before replacement-inbox recovery does not duplicate a pending queued answer", async () => {
	const { manager, dir } = newSession();
	const queue: string[] = [];
	const answer = envelope("q-accept-reconnect", "evt-original");
	const original = new OperatorAnswerInbox(() => manager, queueingInto(queue), waiting(queue));
	expect(await original.accept(answer, "followUp")).toBe("queued");
	await manager.flush();
	const reopened = await SessionManager.open(manager.getSessionFile() as string, dir.path());
	const replacement = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	const replay = envelope("q-accept-reconnect", "evt-retry");

	// A fresh instance has no in-memory queue marker; the live queue is still authoritative.
	expect(await replacement.accept(replay, "followUp")).toBe("duplicate");
	expect(queue).toEqual([answer]);
	expect(await replacement.accept(replay, "followUp")).toBe("duplicate");
	expect(queue).toEqual([answer]);

	// Clearing an unconsumed follow-up allows a subsequent retry using the journaled original.
	queue.length = 0;
	expect(await replacement.accept(replay, "followUp")).toBe("queued");
	expect(queue).toEqual([answer]);
	reopened.appendMessage({ role: "user", content: answer, timestamp: Date.now() });
	await reopened.flush();
	queue.length = 0;

	const afterConsumption = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	expect(await afterConsumption.accept(replay, "followUp")).toBe("duplicate");
	expect(queue).toEqual([]);
});

test("a pending answer whose queue state is unknown stays retryable without a false ack", async () => {
	const { manager } = newSession();
	const answer = envelope("q-accept-unknown", "evt-original");
	const notReady = new OperatorAnswerInbox(
		() => manager,
		async () => {
			throw new Error("dispatch not ready");
		},
		() => false,
	);
	await expect(notReady.accept(answer, "auto")).rejects.toThrow("dispatch not ready");

	const queue: string[] = [];
	const unavailable = new OperatorAnswerInbox(
		() => manager,
		queueingInto(queue),
		() => {
			throw new Error("runtime queue inspection unavailable");
		},
	);
	await expect(unavailable.accept(envelope("q-accept-unknown", "evt-retry"), "auto")).rejects.toThrow(
		"runtime queue inspection unavailable",
	);
	expect(queue).toEqual([]);

	const ready = new OperatorAnswerInbox(() => manager, queueingInto(queue), waiting(queue));
	expect(await ready.accept(envelope("q-accept-unknown", "evt-retry"), "auto")).toBe("queued");
	expect(queue).toEqual([answer]);
});


test("concurrent inbox instances serialize the same pending decision", async () => {
	const { manager } = newSession();
	const queue: string[] = [];
	const original = envelope("q-concurrent", "evt-first");
	const first = new OperatorAnswerInbox(() => manager, queueingInto(queue), waiting(queue));
	const second = new OperatorAnswerInbox(() => manager, queueingInto(queue), waiting(queue));

	// These calls race from separate inbox objects and enter the journal on the same tick.
	const results = await Promise.all([
		first.accept(original, "followUp"),
		second.accept(envelope("q-concurrent", "evt-retry"), "followUp"),
	]);
	expect(results.sort()).toEqual(["duplicate", "queued"]);
	expect(queue).toEqual([original]);
	expect(manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "terminal:operator-answer")).toHaveLength(1);
});

test("a failed first concurrent injection permits exactly one later pending-answer retry", async () => {
	const { manager } = newSession();
	const queue: string[] = [];
	const original = envelope("q-concurrent-retry", "evt-first");
	const failing = new OperatorAnswerInbox(
		() => manager,
		async () => { throw new Error("first injection failed"); },
		waiting(queue),
	);
	const succeeding = new OperatorAnswerInbox(() => manager, queueingInto(queue), waiting(queue));
	const [failure, retry] = await Promise.allSettled([
		failing.accept(original, "followUp"),
		succeeding.accept(envelope("q-concurrent-retry", "evt-retry"), "followUp"),
	]);
	expect(failure.status).toBe("rejected");
	expect(retry).toEqual({ status: "fulfilled", value: "queued" });
	expect(queue).toEqual([original]);
	expect(manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "terminal:operator-answer")).toHaveLength(1);
});

test("concurrent reconnect managers share one pending answer and preserve it after a cleared queue", async () => {
	const { manager, dir } = newSession();
	manager.appendMessage({ role: "user", content: "session seed", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile();
	expect(file).toBeString();

	// Both managers load the same disk state before either accepts a sender delivery.
	const firstManager = await SessionManager.open(file as string, dir.path());
	const secondManager = await SessionManager.open(file as string, dir.path());
	expect(firstManager).not.toBe(secondManager);
	expect(firstManager.getSessionId()).toBe(secondManager.getSessionId());
	const queue: string[] = [];
	const original = envelope("q-reopened-race", "evt-original");
	const first = new OperatorAnswerInbox(() => firstManager, queueingInto(queue), waiting(queue));
	const second = new OperatorAnswerInbox(() => secondManager, queueingInto(queue), waiting(queue));
	const results = await Promise.all([
		first.accept(original, "followUp"),
		second.accept(envelope("q-reopened-race", "evt-replay"), "followUp"),
	]);
	expect([...results].sort()).toEqual(["duplicate", "queued"]);
	expect(queue).toEqual([original]);

	const persisted = await SessionManager.open(file as string, dir.path());
	const pending = persisted.getEntries().filter(entry => entry.type === "custom" && entry.customType === "terminal:operator-answer");
	expect(pending).toHaveLength(1);
	expect(JSON.stringify(pending[0])).toContain("evt-original");

	// A cleared, unconsumed answer must be retryable from the durable original, not the new envelope.
	queue.length = 0;
	const retryManager = await SessionManager.open(file as string, dir.path());
	const retry = new OperatorAnswerInbox(() => retryManager, queueingInto(queue), waiting(queue));
	expect(await retry.accept(envelope("q-reopened-race", "evt-later"), "followUp")).toBe("queued");
	expect(queue).toEqual([original]);
	await retryManager.flush();
	const afterRetry = await SessionManager.open(file as string, dir.path());
	expect(afterRetry.getEntries().filter(entry => entry.type === "custom" && entry.customType === "terminal:operator-answer")).toHaveLength(1);
});

test("retained reconnect manager never writes retry text over an answer already persisted by another manager", async () => {
	const { manager, dir } = newSession();
	manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile() as string;
	const firstManager = await SessionManager.open(file, dir.path());
	const retainedManager = await SessionManager.open(file, dir.path());
	const queue: string[] = [];
	const original = envelope("q-retained", "evt-original");
	const retry = envelope("q-retained", "evt-retry", "changed answer");
	const first = new OperatorAnswerInbox(() => firstManager, queueingInto(queue), waiting(queue));
	const retained = new OperatorAnswerInbox(() => retainedManager, queueingInto(queue), waiting(queue));

	expect(await first.accept(original, "followUp")).toBe("queued");
	queue.length = 0;
	await expect(retained.accept(retry, "followUp")).rejects.toThrow("journal is stale");
	await retained.recover();
	expect(queue).toEqual([]);

	const durable = await SessionManager.open(file, dir.path());
	expect(durable.getEntries().filter(entry => entry.type === "custom" && entry.customType === "terminal:operator-answer")).toHaveLength(1);
	const resumed = new OperatorAnswerInbox(() => durable, queueingInto(queue), waiting(queue));
	expect(await resumed.accept(retry, "followUp")).toBe("queued");
	expect(queue).toEqual([original]);
	await durable.flush();
	const final = await SessionManager.open(file, dir.path());
	expect(final.getEntries().filter(entry => entry.type === "custom" && entry.customType === "terminal:operator-answer")).toHaveLength(1);
});

test("retained reconnect manager cannot inject a consumed answer missing from its old snapshot", async () => {
	const { manager, dir } = newSession();
	manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile() as string;
	const firstManager = await SessionManager.open(file, dir.path());
	const retainedManager = await SessionManager.open(file, dir.path());
	const original = envelope("q-retained-consumed", "evt-original");
	const queue: string[] = [];
	const first = new OperatorAnswerInbox(() => firstManager, queueingInto(queue), waiting(queue));
	const retained = new OperatorAnswerInbox(() => retainedManager, queueingInto(queue), waiting(queue));
	expect(await first.accept(original, "auto")).toBe("queued");
	firstManager.appendMessage({ role: "user", content: original, timestamp: Date.now() });
	await firstManager.flush();
	queue.length = 0;

	await expect(retained.accept(envelope("q-retained-consumed", "evt-retry"), "auto")).rejects.toThrow("journal is stale");
	expect(queue).toEqual([]);
	const reopened = await SessionManager.open(file, dir.path());
	const after = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	expect(await after.accept(envelope("q-retained-consumed", "evt-retry"), "auto")).toBe("duplicate");
	expect(queue).toEqual([]);
});

class FailOnceReadStorage extends FileSessionStorage {
	failNextRead = false;

	// Exercise the fallback backend with no stable loaded inode identity:
	// this path must still attempt and fail a strict durable read, never guess.
	override statSync(filePath: string) {
		return { ...super.statSync(filePath), identity: undefined };
	}
	override openPinnedReaderSync(_filePath: string) {
		return undefined;
	}

	override async readText(filePath: string): Promise<string> {
		if (this.failNextRead) {
			this.failNextRead = false;
			throw new Error("synthetic durable-read fault");
		}
		return super.readText(filePath);
	}
}

test("a failed durable read cannot acknowledge a retained manager's changed retry", async () => {
	const { manager, dir } = newSession();
	manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile() as string;
	const firstManager = await SessionManager.open(file, dir.path());
	const storage = new FailOnceReadStorage();
	const retainedManager = await SessionManager.open(file, dir.path(), storage);
	const queue: string[] = [];
	const original = envelope("q-read-fault", "evt-original");
	const retry = envelope("q-read-fault", "evt-retry", "different answer");
	const first = new OperatorAnswerInbox(() => firstManager, queueingInto(queue), waiting(queue));
	const retained = new OperatorAnswerInbox(() => retainedManager, queueingInto(queue), waiting(queue));

	expect(await first.accept(original, "followUp")).toBe("queued");
	queue.length = 0;
	storage.failNextRead = true;
	await expect(retained.accept(retry, "followUp")).rejects.toThrow("Cannot verify current session journal");
	expect(storage.failNextRead).toBe(false);
	expect(queue).toEqual([]);

	const authoritative = await SessionManager.open(file, dir.path());
	const resumed = new OperatorAnswerInbox(() => authoritative, queueingInto(queue), waiting(queue));
	expect(await resumed.accept(retry, "followUp")).toBe("queued");
	expect(queue).toEqual([original]);
	await authoritative.flush();
	const persisted = await SessionManager.open(file, dir.path());
	expect(persisted.getEntries().filter(entry => entry.type === "custom" && entry.customType === "terminal:operator-answer")).toHaveLength(1);
});

test("a failed journal read blocks recovery after the pending answer was consumed elsewhere", async () => {
	const { manager, dir } = newSession();
	manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile() as string;
	const firstManager = await SessionManager.open(file, dir.path());
	const queue: string[] = [];
	const answer = envelope("q-read-recovery", "evt-original");
	const first = new OperatorAnswerInbox(() => firstManager, queueingInto(queue), waiting(queue));
	expect(await first.accept(answer, "auto")).toBe("queued");

	// Retained B sees pending but not A's later consumed user message.
	const storage = new FailOnceReadStorage();
	const retainedManager = await SessionManager.open(file, dir.path(), storage);
	const retained = new OperatorAnswerInbox(() => retainedManager, queueingInto(queue), waiting(queue));
	firstManager.appendMessage({ role: "user", content: answer, timestamp: Date.now() });
	await firstManager.flush();
	queue.length = 0;
	storage.failNextRead = true;
	await expect(retained.recover()).resolves.toBeUndefined();
	expect(storage.failNextRead).toBe(false);
	expect(queue).toEqual([]);

	const authoritative = await SessionManager.open(file, dir.path());
	const resumed = new OperatorAnswerInbox(() => authoritative, queueingInto(queue), waiting(queue));
	expect(await resumed.accept(envelope("q-read-recovery", "evt-retry"), "auto")).toBe("duplicate");
	expect(queue).toEqual([]);
});

test("a failed first dispatch cannot let a stale manager replace durable pending text", async () => {
	const { manager, dir } = newSession();
	manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile() as string;
	const firstManager = await SessionManager.open(file, dir.path());
	const retainedManager = await SessionManager.open(file, dir.path());
	const original = envelope("q-failed-dispatch", "evt-original");
	const retry = envelope("q-failed-dispatch", "evt-retry", "different answer");
	const first = new OperatorAnswerInbox(() => firstManager, async () => {
		throw new Error("synthetic dispatch fault");
	}, () => false);
	const queue: string[] = [];
	const retained = new OperatorAnswerInbox(() => retainedManager, queueingInto(queue), waiting(queue));
	await expect(first.accept(original, "followUp")).rejects.toThrow("synthetic dispatch fault");
	await expect(retained.accept(retry, "followUp")).rejects.toThrow("journal is stale");
	expect(queue).toEqual([]);
	const authoritative = await SessionManager.open(file, dir.path());
	const resumed = new OperatorAnswerInbox(() => authoritative, queueingInto(queue), waiting(queue));
	expect(await resumed.accept(retry, "followUp")).toBe("queued");
	expect(queue).toEqual([original]);
});

class CountingJournalStorage extends FileSessionStorage {
	wholeReads = 0;
	override async readText(filePath: string): Promise<string> {
		this.wholeReads++;
		return super.readText(filePath);
	}
}

// WHY: old retained managers were made safe by reading the *entire* historical
// journal on each delayed answer/recovery. A known changed inode/size must
// reject without materializing even a multi-megabyte synthetic transcript.
// This is an application-path negative control: the earlier code performs a
// full read and fails wholeReads === 0, while the bounded guard refuses first.
test("retained manager rejects stale answer and recovery without whole-journal reads", async () => {
	const { manager, dir } = newSession();
	manager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	await manager.ensureOnDisk();
	await manager.flush();
	const file = manager.getSessionFile() as string;
	const firstManager = await SessionManager.open(file, dir.path());
	const storage = new CountingJournalStorage();
	const staleManager = await SessionManager.open(file, dir.path(), storage);
	const queue: string[] = [];
	const original = envelope("q-large-stale", "evt-original");
	const first = new OperatorAnswerInbox(() => firstManager, queueingInto(queue), waiting(queue));
	const retained = new OperatorAnswerInbox(() => staleManager, queueingInto(queue), waiting(queue));

	expect(await first.accept(original, "auto")).toBe("queued");
	firstManager.appendMessage({ role: "user", content: original, timestamp: Date.now() });
	firstManager.appendCustomEntry("synthetic:historical-tail", { padding: "x".repeat(3 * 1024 * 1024) });
	await firstManager.flush();
	queue.length = 0;
	storage.wholeReads = 0;

	await expect(retained.accept(envelope("q-large-stale", "evt-retry"), "auto")).rejects.toThrow("journal is stale");
	await retained.recover();
	expect(storage.wholeReads).toBe(0);
	expect(queue).toEqual([]);

	const reopened = await SessionManager.open(file, dir.path());
	const replay = new OperatorAnswerInbox(() => reopened, queueingInto(queue), waiting(queue));
	expect(await replay.accept(envelope("q-large-stale", "evt-retry"), "auto")).toBe("duplicate");
	expect(queue).toEqual([]);
});
