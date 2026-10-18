// WHY: A live terminal may have been loaded from an older binary whose notice reader is unknown.
// This suite closes silent sends to registered but unsupported or unverified receivers, while
// preserving the distinction from an unknown session. It does not exercise a real terminal pipe.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../src/registry/agent-registry";
import { Settings } from "../src/config/settings";
import { claimSessionNotices, sendSessionNotice } from "../src/launch/session-notices";
import { getLoadedBuildIdentity, parseBuildIdentity } from "../src/launch/build-info";
import { serveTerminalControl } from "../src/launch/terminal-control";
import type { ToolSession } from "../src/tools";
import { IrcTool } from "../src/tools/agent/irc";

let temp: TempDir;
let root: string;
const closers: Array<() => void> = [];
const senderId = "0-Main";
const senderSessionId = "sender-session";
const targetSessionId = "target-session";
const installedBuild = { version: "1.5.6", buildSha: "a".repeat(40), buildTag: "a1b2c3d4-local" };

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

function makeTool(): IrcTool {
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
	return new IrcTool(session, {
		sendSessionNotice: args => sendSessionNotice({ ...args, root }),
		readInstalledBuildIdentity: async () => installedBuild,
	});
}

function writeLiveOwner(sessionId: string, metadata: Record<string, unknown> = {}): void {
	const directory = path.join(root, "run", "terminals");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, `${sessionId}.json`),
		JSON.stringify({ version: 1, sessionId, pid: process.pid, ...metadata }),
	);
}

describe("mixed-build session notices", () => {
	it("parses the stable version and full SHA emitted by the installed executable", () => {
		const buildSha = "b".repeat(40);
		expect(parseBuildIdentity(`veyyon/1.5.6 (tag a1b2c3d4-local; build SHA ${buildSha})`)).toEqual({
			version: "1.5.6",
			buildSha,
			buildTag: "a1b2c3d4-local",
		});
		expect(parseBuildIdentity("veyyon/1.5.6 (legacy-build-tag)")).toEqual({
			version: "1.5.6",
			buildSha: null,
			buildTag: "legacy-build-tag",
		});
		expect(parseBuildIdentity(`veyyon/1.5.6 (build SHA ${buildSha})`)).toEqual({
			version: "1.5.6",
			buildSha,
			buildTag: null,
		});
	});

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
		const loaded = getLoadedBuildIdentity();
		expect(owner).toMatchObject({
			version: 2,
			loadedVersion: loaded.version,
			loadedBuildSha: loaded.buildSha,
			capabilities: expect.arrayContaining(["session-notices"]),
		});

		const result = await makeTool().execute("send-supported", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "Build-aware notice",
		});

		expect(result.isError).not.toBe(true);
		expect(claimSessionNotices(targetSessionId, root).map(notice => notice.body)).toEqual(["Build-aware notice"]);
	});

	it("refuses a known receiver without notice support and explains loaded versus installed builds", async () => {
		writeLiveOwner(targetSessionId, {
			loadedVersion: "1.5.6",
			loadedBuildSha: "a".repeat(40),
			capabilities: ["deliver-ack"],
		});
		const queue = path.join(root, "run", "notices", targetSessionId);
		fs.mkdirSync(queue, { recursive: true });

		const result = await makeTool().execute("send-unsupported", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "Must not be silently queued",
		});
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");

		expect(result.isError).toBe(true);
		expect(text).toContain(`session:${targetSessionId}`);
		expect(text).toContain("Loaded sender:");
		expect(text).toContain("Loaded receiver: 1.5.6");
		expect(text).toContain("Installed executable: 1.5.6");
		expect(text).toContain("Main only");
		expect(text).toContain("not its lanes");
		expect(text).toContain("does not guarantee acceptance");
		expect(text).toContain("No terminal-control fallback was sent");
		expect(text).not.toContain("irc list");
		expect(claimSessionNotices(targetSessionId, root)).toEqual([]);
	});

	it("fails closed when a legacy live owner cannot prove its loaded build or notice capability", async () => {
		writeLiveOwner(targetSessionId);
		fs.mkdirSync(path.join(root, "run", "notices", targetSessionId), { recursive: true });

		const result = await makeTool().execute("send-legacy", {
			op: "send",
			to: `session:${targetSessionId}`,
			message: "Must not be accepted without capability evidence",
		});
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");

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
		const text = result.content.map(part => part.type === "text" ? part.text : "").join("\n");

		expect(result.isError).toBe(true);
		expect(text).toBe(`Unknown session ${targetSessionId}: no live terminal and no notice queue`);
		expect(text).not.toContain("irc list");
	});
});
