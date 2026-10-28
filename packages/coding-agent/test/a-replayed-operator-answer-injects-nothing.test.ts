// WHY: Telegram answers reach a session at least once (the sender retries until it sees an ack), so the same
// operator answer can arrive twice, or once before a crash and once after the restart (#668). The receiver must
// journal the question id before it injects, treat the answer's own user message as the consumption record, and
// inject nothing for a question already consumed.
// Gap: this drives the inbox against a real file-backed SessionManager; the terminal-control wiring that calls it is not
// exercised here, and a user message that never reaches the journal is the one case recovery re-injects on purpose.
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
	const inbox = new OperatorAnswerInbox(manager, injectingInto(manager, injected));
	expect(operatorAnswerQuestionId("hello")).toBeUndefined();
	expect(await inbox.accept("hello", "auto")).toBeUndefined();
	expect(injected).toEqual([]);
});

test("the first deliver injects the answer once; a replay and a repeated update event inject nothing and log no answer text", async () => {
	const { manager } = newSession();
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(manager, injectingInto(manager, injected));
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
	const inbox = new OperatorAnswerInbox(manager, injectingInto(manager, injected));
	await inbox.accept(envelope("q-1", "evt-1"), "auto");
	expect(await inbox.accept(envelope("q-2", "evt-2"), "auto")).toBe("queued");
	expect(injected).toHaveLength(2);
});

test("after a restart a consumed question injects nothing, even replayed with a new event id", async () => {
	const { manager, dir } = newSession();
	const injected: string[] = [];
	const before = new OperatorAnswerInbox(manager, injectingInto(manager, injected));
	await before.accept(envelope("q-1", "evt-1"), "auto");
	await manager.flush();
	const file = manager.getSessionFile();
	expect(file).toBeString();

	const reopened = await SessionManager.open(file as string, dir.path());
	const afterRestart: string[] = [];
	const inbox = new OperatorAnswerInbox(reopened, injectingInto(reopened, afterRestart));
	await inbox.recover();
	expect(await inbox.accept(envelope("q-1", "evt-9"), "auto")).toBe("duplicate");
	expect(afterRestart).toEqual([]);
});

test("a crash after the answer was journaled but before it was injected re-injects it exactly once on recovery", async () => {
	const { manager, dir } = newSession();
	const failing = new OperatorAnswerInbox(manager, async () => {
		throw new Error("crashed before injection");
	});
	await expect(failing.accept(envelope("q-1", "evt-1"), "followUp")).rejects.toThrow("crashed before injection");
	await manager.flush();
	const file = manager.getSessionFile();
	expect(file).toBeString();

	const reopened = await SessionManager.open(file as string, dir.path());
	const injected: string[] = [];
	const inbox = new OperatorAnswerInbox(reopened, injectingInto(reopened, injected));
	await inbox.recover();
	await inbox.recover();
	expect(injected).toEqual([envelope("q-1", "evt-1")]);
	// The sender's retry of the same question after recovery is a replay, not a second injection.
	expect(await inbox.accept(envelope("q-1", "evt-1"), "followUp")).toBe("duplicate");
	expect(injected).toHaveLength(1);
});
