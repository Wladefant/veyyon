// WHY: on 2026-10-10 a warning for another session went through the terminal pipe once and failed the
// second time with "Terminal owner disconnected"; the target session's lanes never saw it. A notice is a
// file, so a dropped socket, a missing owner or a busy session cannot lose it.
// Covers the queue (connected owner, no owner, broadcast, once-only, bounds, failure paths) and the
// session that reads it at the start of its next prompt, forwards it to its running lanes and
// acknowledges it only once it is in the turn.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import * as utils from "@veyyon/utils";
import { Snowflake, TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	ackSessionNotices,
	CLAIM_STALE_MS,
	claimSessionNotices,
	MAX_NOTICE_BODY,
	NOTICE_TTL_MS,
	noticeState,
	registerSessionNoticeQueue,
	sendSessionNotice,
} from "../src/launch/session-notices";
import { serveTerminalControl } from "../src/launch/terminal-control";
import { AgentRegistry } from "../src/registry/agent-registry";
import { AgentSession } from "../src/session/agent-session";
import { IrcBus } from "../src/task/irc-bus";

let temp: TempDir;
let root: string;
const closers: Array<() => void> = [];

beforeEach(() => {
	temp = TempDir.createSync("@veyyon-notices-");
	root = temp.path();
});

afterEach(async () => {
	for (const close of closers.splice(0)) close();
	await temp.remove();
});

/** A live terminal owner for `sessionId`, registered the way a real one is. */
async function liveOwner(sessionId: string): Promise<() => void> {
	const close = await serveTerminalControl(
		{
			identity: () => ({ sessionId, cwd: root, sessionFile: path.join(root, `${sessionId}.jsonl`) }),
			deliver: async () => "started",
			abort: async () => false,
			history: () => [],
			subscribe: () => () => {},
		},
		root,
	);
	closers.push(close);
	return close;
}

/** What a recipient does with a notice that reaches its turn: claim, then acknowledge. */
function takeAll(sessionId: string, now = Date.now()) {
	const notices = claimSessionNotices(sessionId, root, now);
	ackSessionNotices(
		sessionId,
		notices.map(notice => notice.id),
		root,
	);
	return notices;
}

const queueDirectory = (sessionId: string) => path.join(root, "run", "notices", sessionId);

describe("the notice queue", () => {
	it("delivers to a connected session at its next read, once, and the sender sees the receipt", async () => {
		await liveOwner("target");

		const [receipt] = sendSessionNotice({ from: "sender", to: "target", body: "VPS frozen, no docker", root });
		expect(receipt?.route).toBe("live");
		expect(noticeState("target", receipt!.id, root)).toBe("queued");

		const first = claimSessionNotices("target", root);
		expect(first.map(notice => [notice.from, notice.body])).toEqual([["sender", "VPS frozen, no docker"]]);
		expect(noticeState("target", receipt!.id, root)).toBe("claimed");
		ackSessionNotices("target", [receipt!.id], root);
		expect(noticeState("target", receipt!.id, root)).toBe("delivered");
		expect(claimSessionNotices("target", root)).toEqual([]);
	});

	it("delivers to a session whose owner is gone, at its next turn", async () => {
		registerSessionNoticeQueue("target", root); // the session ran before, so it announced its queue
		const close = await liveOwner("target");
		close(); // the owner disconnects: the pipe that failed on 2026-10-10 is no longer there
		// close() removes the record asynchronously; removing it here makes "owner gone" deterministic.
		const records = path.join(root, "run", "terminals");
		for (const name of fs.readdirSync(records)) fs.rmSync(path.join(records, name), { force: true });

		const [receipt] = sendSessionNotice({ from: "sender", to: "target", body: "stop the deploy", root });
		expect(receipt?.route).toBe("offline");
		expect(noticeState("target", receipt!.id, root)).toBe("queued");

		expect(takeAll("target").map(notice => notice.body)).toEqual(["stop the deploy"]);
	});

	it("broadcasts to every other live session and never to the sender", async () => {
		await liveOwner("sender");
		await liveOwner("one");
		await liveOwner("two");

		const receipts = sendSessionNotice({ from: "sender", to: "all", body: "freeze", root });

		expect(receipts.map(receipt => receipt.to).sort()).toEqual(["one", "two"]);
		expect(takeAll("one")).toHaveLength(1);
		expect(takeAll("two")).toHaveLength(1);
		expect(takeAll("sender")).toEqual([]);
	});

	it("keeps order and never hands one notice to two readers", () => {
		registerSessionNoticeQueue("target", root);
		const ids = ["a", "b", "c"].map(body => sendSessionNotice({ from: "s", to: "target", body, root })[0]!.id);
		const first = claimSessionNotices("target", root);
		const second = claimSessionNotices("target", root);
		expect(first.map(notice => notice.body)).toEqual(["a", "b", "c"]);
		expect(first.map(notice => notice.id)).toEqual(ids);
		expect(second).toEqual([]);
	});

	it("drops an expired notice unread and refuses unsafe or oversized input", () => {
		registerSessionNoticeQueue("target", root);
		const [receipt] = sendSessionNotice({ from: "s", to: "target", body: "old", root });
		const aged = Date.now() + NOTICE_TTL_MS + 1000;
		expect(takeAll("target", aged)).toEqual([]);
		expect(noticeState("target", receipt!.id, root)).toBe("unknown"); // discarded, never shown

		expect(() => sendSessionNotice({ from: "s", to: "../escape", body: "x", root })).toThrow("Invalid session id");
		expect(() => sendSessionNotice({ from: "s", to: "target", body: "x".repeat(MAX_NOTICE_BODY + 1), root })).toThrow(
			"exceeds",
		);
		expect(() => sendSessionNotice({ from: "s", to: "s", body: "x", root })).toThrow("own session");
		expect(fs.existsSync(path.join(root, "run", "escape"))).toBe(false);
	});

	it("does not read a notice that names another session", () => {
		const directory = queueDirectory("target");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(
			path.join(directory, "x.json"),
			JSON.stringify({ version: 1, id: "x", from: "s", to: "other", body: "misfiled", ts: Date.now() }),
		);
		expect(claimSessionNotices("target", root)).toEqual([]);
	});
});

describe("the notice queue under failure", () => {
	it("keeps going when one notice cannot be moved: the others are claimed, the stuck one stays queued", () => {
		registerSessionNoticeQueue("target", root);
		const ids = ["a", "b", "c"].map(body => sendSessionNotice({ from: "s", to: "target", body, root })[0]!.id);
		// A non-empty directory on the second notice's claim name makes its rename fail with a non-ENOENT error.
		const blocker = path.join(queueDirectory("target"), "claimed", `${ids[1]}.json`);
		fs.mkdirSync(blocker, { recursive: true });
		fs.writeFileSync(path.join(blocker, "keep"), "x");

		const taken = claimSessionNotices("target", root);

		expect(taken.map(notice => notice.body)).toEqual(["a", "c"]);
		expect(noticeState("target", ids[0]!, root)).toBe("claimed");
		expect(noticeState("target", ids[2]!, root)).toBe("claimed");
		expect(fs.existsSync(path.join(queueDirectory("target"), `${ids[1]}.json`))).toBe(true);
	});

	it("offers an unacknowledged claim again once it is stale, and never before", () => {
		registerSessionNoticeQueue("target", root);
		const [receipt] = sendSessionNotice({ from: "s", to: "target", body: "warn", root });
		expect(claimSessionNotices("target", root)).toHaveLength(1); // the owner crashes before it acknowledges

		expect(claimSessionNotices("target", root)).toEqual([]);
		const later = Date.now() + CLAIM_STALE_MS + 1000;
		expect(claimSessionNotices("target", root, later).map(notice => notice.body)).toEqual(["warn"]);
		ackSessionNotices("target", [receipt!.id], root);
		expect(noticeState("target", receipt!.id, root)).toBe("delivered");
		expect(claimSessionNotices("target", root, later + CLAIM_STALE_MS + 1000)).toEqual([]);
	});

	it("does not count expired notices toward the cap, and purges them", () => {
		const directory = queueDirectory("target");
		fs.mkdirSync(directory, { recursive: true });
		const old = Date.now() - NOTICE_TTL_MS - 5000;
		for (let index = 0; index < 100; index++) {
			const id = `${String(old).padStart(15, "0")}-${String(index).padStart(6, "0")}-x`;
			fs.writeFileSync(
				path.join(directory, `${id}.json`),
				JSON.stringify({ version: 1, id, from: "s", to: "target", body: "old", ts: old }),
			);
		}

		const [receipt] = sendSessionNotice({ from: "s", to: "target", body: "fresh", root });

		expect(noticeState("target", receipt!.id, root)).toBe("queued");
		expect(fs.readdirSync(directory).filter(name => name.endsWith(".json"))).toHaveLength(1);
	});

	it("refuses a hundred-and-first live notice", () => {
		registerSessionNoticeQueue("target", root);
		for (let index = 0; index < 100; index++) sendSessionNotice({ from: "s", to: "target", body: `n${index}`, root });
		expect(() => sendSessionNotice({ from: "s", to: "target", body: "one more", root })).toThrow("unread notices");
	});

	it("prunes old claimed and delivered files even when nothing is pending", () => {
		const stale = ["delivered", "claimed"].map(where => {
			const directory = path.join(queueDirectory("target"), where);
			fs.mkdirSync(directory, { recursive: true });
			const file = path.join(directory, "old.json");
			fs.writeFileSync(file, "{}");
			const aged = new Date(Date.now() - NOTICE_TTL_MS - 5000);
			fs.utimesSync(file, aged, aged);
			return file;
		});
		// The claimed file is also named for no timestamp, so it is read as expired and removed.
		expect(claimSessionNotices("target", root)).toEqual([]);

		for (const file of stale) expect(fs.existsSync(file)).toBe(false);
	});

	it("refuses an unknown recipient instead of creating a queue for it", () => {
		expect(() => sendSessionNotice({ from: "s", to: "typo-session", body: "x", root })).toThrow("Unknown session");
		expect(fs.existsSync(queueDirectory("typo-session"))).toBe(false);
	});
});

describe("a session reading its notices", () => {
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		spyOn(utils, "getConfigRootDir").mockReturnValue(root);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		auth?.close();
		auth = undefined;
	});

	async function createSession(): Promise<{ session: AgentSession; sessionId: string; calls: () => number }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const mock = createMockModel({ responses: [{ content: ["noted"] }, { content: ["noted again"] }] });
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "Fake read",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			streamFn: mock.stream,
		});
		auth = await AuthStorage.create(temp.join(`auth-${Snowflake.next()}.db`));
		auth.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(auth, temp.join(`models-${Snowflake.next()}.yml`)),
			toolRegistry: new Map<string, AgentTool>([["read", readTool]]),
			builtInToolNames: ["read"],
			agentId: "Main",
		});
		const sessionId = sessionManager.getSessionId();
		registerSessionNoticeQueue(sessionId, root); // the session announced its queue on an earlier turn
		return { session, sessionId, calls: () => mock.calls.length };
	}

	const noticeRecords = (messages: readonly AgentMessage[]) =>
		messages.filter(message => message.role === "custom" && message.customType === "session:notice");

	it("shows a notice queued while it was disconnected in the next prompt, ahead of the user's text", async () => {
		const created = await createSession();
		const [receipt] = sendSessionNotice({
			from: "other-session",
			to: created.sessionId,
			body: "VPS frozen, no docker",
			root,
		});

		await created.session.prompt("carry on");
		await created.session.waitForIdle();

		const messages = created.session.agent.state.messages;
		const records = noticeRecords(messages);
		expect(records).toHaveLength(1);
		expect(JSON.stringify(records[0])).toContain("VPS frozen, no docker");
		expect(JSON.stringify(records[0])).toContain("other-session");
		expect(messages.indexOf(records[0]!)).toBeLessThan(messages.findIndex(message => message.role === "user"));
		expect(created.calls()).toBe(1);
		expect(noticeState(created.sessionId, receipt!.id, root)).toBe("delivered");

		await created.session.prompt("again");
		await created.session.waitForIdle();
		expect(noticeRecords(created.session.agent.state.messages)).toHaveLength(1); // not delivered twice
	});

	it("delivers a claim an earlier owner never acknowledged, once, and drops a repeat of it", async () => {
		const created = await createSession();
		const [receipt] = sendSessionNotice({ from: "other-session", to: created.sessionId, body: "stop builds", root });
		expect(claimSessionNotices(created.sessionId, root)).toHaveLength(1); // the earlier owner claims, then crashes
		const claim = path.join(queueDirectory(created.sessionId), "claimed", `${receipt!.id}.json`);
		const aged = new Date(Date.now() - CLAIM_STALE_MS - 5000);
		fs.utimesSync(claim, aged, aged);

		await created.session.prompt("carry on");
		await created.session.waitForIdle();

		expect(noticeRecords(created.session.agent.state.messages)).toHaveLength(1);
		expect(noticeState(created.sessionId, receipt!.id, root)).toBe("delivered");

		// The acknowledgement of a prior delivery did not land: the same claim reappears. It is dropped, not shown again.
		fs.copyFileSync(
			path.join(queueDirectory(created.sessionId), "delivered", `${receipt!.id}.json`),
			path.join(queueDirectory(created.sessionId), "claimed", `${receipt!.id}.json`),
		);
		fs.utimesSync(path.join(queueDirectory(created.sessionId), "claimed", `${receipt!.id}.json`), aged, aged);
		await created.session.prompt("again");
		await created.session.waitForIdle();

		expect(noticeRecords(created.session.agent.state.messages)).toHaveLength(1);
		expect(fs.existsSync(path.join(queueDirectory(created.sessionId), "claimed", `${receipt!.id}.json`))).toBe(false);
	});

	it("forwards the notice to the lanes the session is running", async () => {
		const created = await createSession();
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "running" });
		registry.register({
			id: "ImageWidgetFinish",
			displayName: "ImageWidgetFinish",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "running",
		});
		sendSessionNotice({ from: "other-session", to: created.sessionId, body: "no builds now", root });

		await created.session.prompt("carry on");
		await created.session.waitForIdle();

		const toLane = IrcBus.global()
			.log()
			.filter(entry => entry.message.to === "ImageWidgetFinish");
		expect(toLane).toHaveLength(1);
		expect(toLane[0]?.message.body).toContain("no builds now");
	});

	it("negative control: with nothing queued, no notice record and no lane traffic appear", async () => {
		const created = await createSession();
		await created.session.prompt("carry on");
		await created.session.waitForIdle();
		expect(noticeRecords(created.session.agent.state.messages)).toHaveLength(0);
		expect(IrcBus.global().log()).toHaveLength(0);
	});
});
