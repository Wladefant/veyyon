// WHY: A live terminal may have been loaded from an older binary whose notice reader is unknown.
// This suite closes silent sends to registered but unsupported or unverified receivers, while
// preserving the distinction from an unknown session. It does not exercise a real terminal pipe.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertNotTerminalOwned } from "@veyyon/kernel/session/terminal-ownership";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../src/registry/agent-registry";
import { Settings } from "../src/config/settings";
import {
	type BuildIdentity,
	formatBuildIdentity,
	getLoadedBuildIdentity,
	parseBuildIdentity,
} from "../src/launch/build-info";
import { claimSessionNotices, sendSessionNotice } from "../src/launch/session-notices";
import { serveTerminalControl } from "../src/launch/terminal-control";
import type { ToolSession } from "../src/tools";
import { IrcTool } from "../src/tools/agent/irc";

let temp: TempDir;
let root: string;
const closers: Array<() => void> = [];
const senderId = "0-Main";
const senderSessionId = "sender-session";
const targetSessionId = "target-session";
const loadedReceiverSha = "a".repeat(40);
const installedSha = "b".repeat(40);
const installedBuild: BuildIdentity = { version: "1.5.6", buildSha: installedSha, buildTag: "b2c3d4e5-local" };

beforeEach(() => {
	temp = TempDir.createSync("@veyyon-mixed-build-irc-");
	root = temp.path();
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	for (const close of closers.splice(0)) close();
	await temp.remove();
	AgentRegistry.resetGlobalForTests();
});

function makeTool(readInstalled: () => BuildIdentity = () => installedBuild): IrcTool {
	const registry = AgentRegistry.global();
	registry.register({ id: senderId, displayName: "Main", kind: "main", session: null, status: "running" });
	const session: ToolSession = {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => senderId,
		getSessionId: () => senderSessionId,
		settings: Settings.isolated(),
		agentRegistry: registry,
	};
	const runtime = {
		sendSessionNotice: (args: Parameters<typeof sendSessionNotice>[0]) => sendSessionNotice({ ...args, root }),
		readInstalledBuildIdentity: async () => readInstalled(),
	};
	return new IrcTool(session, runtime);
}

function writeLiveOwner(sessionId: string, version: 1, metadata: Record<string, unknown> = {}): void {
	const directory = path.join(root, "run", "terminals");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, `${sessionId}.json`),
		JSON.stringify({ version, sessionId, pid: process.pid, ...metadata }),
	);
}

describe("mixed-build session notices", () => {
	it("records the loaded build and notice capability, then delivers through the supported production path", async () => {
		const close = await serveTerminalControl(
			{
				identity: () => ({ sessionId: targetSessionId, cwd: root, sessionFile: path.join(root, "target.jsonl") }),
				deliver: async () => "started",
				abort: async () => false,
				history: () => [],
				subscribe: () => () => {},
			},
			root,
		);
		closers.push(close);

		const ownerDirectory = path.join(root, "run", "terminals");
		const ownerFiles = fs.readdirSync(ownerDirectory);
		const owner = JSON.parse(fs.readFileSync(path.join(ownerDirectory, ownerFiles[0]!), "utf8"));
		expect(owner).toMatchObject({
			version: 1,
			capabilities: expect.arrayContaining(["session-notices"]),
		});
		expect(owner.loadedVersion).toBe(getLoadedBuildIdentity().version);
		expect(owner.loadedBuildSha).toBe(getLoadedBuildIdentity().buildSha);
		await expect(assertNotTerminalOwned(path.join(root, "target.jsonl"), root)).rejects.toThrow(
			"Session is owned by a live terminal",
		);

		const result = await makeTool().execute("send-supported", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "Build-aware notice",
		});

		expect(result.isError).not.toBe(true);
		expect(claimSessionNotices(targetSessionId, root).map(notice => notice.body)).toEqual(["Build-aware notice"]);
	});

	// WHY: Building a second real executable inside a unit test is not practical, so a replaced disk binary
	// is simulated at the runtime seam: the injected reader's identity changes after the tool exists, while
	// the receiver's loaded version and build SHA stay in its live owner record. This proves that a send
	// does not consult the disk identity to decide delivery. It does not cover the real OS path where a
	// compiled binary is swapped on disk under a running terminal; that gap needs a compiled-binary check.
	it("delivers a stop notice to a live receiver whose installed executable was replaced", async () => {
		writeLiveOwner(targetSessionId, 1, {
			loadedVersion: "1.5.6",
			loadedBuildSha: loadedReceiverSha,
			capabilities: ["session-notices"],
		});
		let installed: BuildIdentity = installedBuild;
		const tool = makeTool(() => installed);
		installed = { version: "1.5.7", buildSha: "c".repeat(40), buildTag: "c3d4e5f6-local" };

		const result = await tool.execute("send-replaced-binary", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "stop",
		});

		expect(result.isError).not.toBe(true);
		const notices = claimSessionNotices(targetSessionId, root);
		expect(notices.map(notice => ({ from: notice.from, to: notice.to, body: notice.body }))).toEqual([
			{ from: senderSessionId, to: targetSessionId, body: "stop" },
		]);
		const owner = JSON.parse(fs.readFileSync(path.join(root, "run", "terminals", `${targetSessionId}.json`), "utf8"));
		expect(owner).toMatchObject({ loadedVersion: "1.5.6", loadedBuildSha: loadedReceiverSha });
	});

	it("refuses a known receiver without notice support and explains loaded versus installed builds", async () => {
		writeLiveOwner(targetSessionId, 1, {
			loadedVersion: "1.5.6",
			loadedBuildSha: loadedReceiverSha,
			capabilities: ["deliver-ack"],
		});
		const queue = path.join(root, "run", "notices", targetSessionId);
		fs.mkdirSync(queue, { recursive: true });

		const result = await makeTool().execute("send-unsupported", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "Must not be silently queued",
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(result.isError).toBe(true);
		expect(text).toContain(`session:${targetSessionId}`);
		expect(text).toContain("Loaded sender:");
		expect(text).toContain(`Loaded receiver: 1.5.6 (build SHA ${loadedReceiverSha}).`);
		expect(text).toContain(`Installed executable: 1.5.6 (tag b2c3d4e5-local; build SHA ${installedSha}).`);
		expect(text).toContain("Main only");
		expect(text).toContain("not its lanes");
		expect(text).toContain("does not guarantee acceptance");
		expect(text).toContain("No terminal-control fallback was sent");
		expect(text).not.toContain("irc list");
		expect(claimSessionNotices(targetSessionId, root)).toEqual([]);
	});

	it("fails closed when a legacy live owner cannot prove its loaded build or notice capability", async () => {
		writeLiveOwner(targetSessionId, 1);
		fs.mkdirSync(path.join(root, "run", "notices", targetSessionId), { recursive: true });

		const result = await makeTool().execute("send-legacy", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "Must not be accepted without capability evidence",
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(result.isError).toBe(true);
		expect(text).toContain(`session:${targetSessionId}`);
		expect(text).toContain("loaded version/build SHA are unavailable");
		expect(text).toContain("capability support is unverified");
		expect(claimSessionNotices(targetSessionId, root)).toEqual([]);
	});

	it("keeps an unknown destination distinct from a registered unsupported receiver", async () => {
		const result = await makeTool().execute("send-unknown", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "Unknown target",
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(result.isError).toBe(true);
		expect(text).toBe(`Unknown session ${targetSessionId}: no live terminal and no notice queue`);
		expect(text).not.toContain("irc list");
	});

	// WHY: `session:all` reaches every live session, so one owner without notice support must refuse the whole
	// send. Recipients are checked before any queue is written: the supported session gets nothing either.
	it("refuses session:all when a live owner lacks notice support, and queues nothing for any receiver", async () => {
		const currentId = "current-session";
		const olderId = "older-session";
		writeLiveOwner(currentId, 1, {
			loadedVersion: "1.5.6",
			loadedBuildSha: loadedReceiverSha,
			capabilities: ["session-notices"],
		});
		writeLiveOwner(olderId, 1, {
			loadedVersion: "1.5.6",
			loadedBuildSha: loadedReceiverSha,
			capabilities: ["deliver-ack"],
		});
		fs.mkdirSync(path.join(root, "run", "notices", currentId), { recursive: true });
		fs.mkdirSync(path.join(root, "run", "notices", olderId), { recursive: true });

		const result = await makeTool().execute("send-broadcast-mixed", {
			op: "send",
			to: "session:all",
			message: "Must not partially land",
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");

		expect(result.isError).toBe(true);
		expect(text).toContain(`Receiver session:${olderId} is registered, but capability support is unsupported.`);
		expect(text).not.toContain(currentId);
		expect(claimSessionNotices(currentId, root)).toEqual([]);
		expect(claimSessionNotices(olderId, root)).toEqual([]);
	});
});

describe("build identity text", () => {
	const taggedSha = "d".repeat(40);

	it("parses a legacy plain semver line as a version with no build fields", () => {
		expect(parseBuildIdentity("1.5.6\n")).toEqual({ version: "1.5.6", buildSha: null, buildTag: null });
	});

	it("parses a prefixed version line carrying a tag and a full build SHA", () => {
		expect(parseBuildIdentity(`veyyon/1.5.6 (tag a1b2c3d4-local; build SHA ${taggedSha})\n`)).toEqual({
			version: "1.5.6",
			buildSha: taggedSha,
			buildTag: "a1b2c3d4-local",
		});
	});

	it("parses a prefixed version line with a build SHA and no tag", () => {
		expect(parseBuildIdentity(`veyyon/1.5.6 (build SHA ${taggedSha})\n`)).toEqual({
			version: "1.5.6",
			buildSha: taggedSha,
			buildTag: null,
		});
	});

	it("rejects output that carries no version", () => {
		expect(parseBuildIdentity("")).toBeNull();
		expect(parseBuildIdentity("command not found: veyyon")).toBeNull();
	});

	it("formats a tagged identity with a literal label and parses it back unchanged", () => {
		const identity: BuildIdentity = { version: "1.5.6", buildSha: taggedSha, buildTag: "a1b2c3d4-local" };
		expect(formatBuildIdentity(identity)).toBe(`1.5.6 (tag a1b2c3d4-local; build SHA ${taggedSha})`);
		expect(parseBuildIdentity(formatBuildIdentity(identity))).toEqual(identity);
	});

	it("formats an identity without a SHA as unavailable and parses it back unchanged", () => {
		const identity: BuildIdentity = { version: "1.5.6", buildSha: null, buildTag: null };
		expect(formatBuildIdentity(identity)).toBe("1.5.6 (build SHA unavailable)");
		expect(parseBuildIdentity(formatBuildIdentity(identity))).toEqual(identity);
	});
});
