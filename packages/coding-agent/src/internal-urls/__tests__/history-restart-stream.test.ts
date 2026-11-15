import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { BlobStore, blobsDirForSessionDir } from "@veyyon/kernel/session/blob-store";
import { TempDir } from "@veyyon/utils";
import { AgentRegistry } from "../../registry/agent-registry";
import { HistoryProtocolHandler } from "../history-protocol";
import { parseInternalUrl } from "../parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
	scanSessionFilesFromDisk,
} from "../registry-helpers";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

it("streams a stored prefix without opening payloads from later messages", async () => {
	using dir = TempDir.createSync("history-restart-stream-");
	const store = new BlobStore(blobsDirForSessionDir(dir.path()));
	const first = store.putSync(Buffer.from("first\nsecond\nthird\nfourth\nfifth"));
	const tail = store.putSync(Buffer.from("tail payload that this prefix does not need"));
	const file = dir.join("OldAgent.jsonl");
	await fs.writeFile(
		file,
		[
			{ type: "session", version: 4, id: "stored", cwd: dir.path(), timestamp: "2026-11-15T00:00:00.000Z" },
			{
				type: "message",
				id: "first",
				parentId: null,
				timestamp: "2026-11-15T00:00:01.000Z",
				message: { role: "user", content: `blobtext:sha256:${first.hash}`, timestamp: 1 },
			},
			{
				type: "message",
				id: "tail",
				parentId: "first",
				timestamp: "2026-11-15T00:00:02.000Z",
				message: { role: "user", content: `blobtext:sha256:${tail.hash}`, timestamp: 2 },
			},
		]
			.map(value => JSON.stringify(value))
			.join("\n") + "\n",
	);
	registerArtifactsDir(dir.path());
	const get = BlobStore.prototype.get;
	const payloadRead = spyOn(BlobStore.prototype, "get").mockImplementation(function (this: BlobStore, hash, options) {
		if (hash === tail.hash) throw new Error("unrequested tail payload opened");
		return get.call(this, hash, options);
	});
	const readFile = fs.readFile;
	const transcriptRead = spyOn(fs, "readFile").mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
		if (String(args[0]) === file) throw new Error("whole transcript read");
		return readFile(...args);
	}) as typeof fs.readFile);
	try {
		const result = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://OldAgent"), {
			historyMaxLines: 7,
		});
		expect(result.content).toBe("# OldAgent (on disk)\n\n## user\n\nfirst\nsecond\nthird\n");
		expect(result.contentIncomplete).toBe(true);
	} finally {
		payloadRead.mockRestore();
		transcriptRead.mockRestore();
	}
});

it("reuses a disk index after registry reset and invalidates a newly ambiguous identity", async () => {
	using dir = TempDir.createSync("history-restart-index-");
	await fs.mkdir(dir.join("nested"));
	await fs.writeFile(dir.join("nested", "OldAgent.jsonl"), "not needed for lookup");
	registerArtifactsDir(dir.path());
	expect((await scanSessionFilesFromDisk()).files.get("OldAgent")).toBe(dir.join("nested", "OldAgent.jsonl"));
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	registerArtifactsDir(dir.path());
	const readdir = fs.readdir;
	const listing = spyOn(fs, "readdir").mockImplementation(((...args: Parameters<typeof fs.readdir>) => {
		if (String(args[0]) === dir.join("nested")) throw new Error("indexed directory enumerated again");
		return readdir(...args);
	}) as typeof fs.readdir);
	try {
		expect((await scanSessionFilesFromDisk()).files.get("OldAgent")).toBe(dir.join("nested", "OldAgent.jsonl"));
	} finally {
		listing.mockRestore();
	}
	await fs.writeFile(dir.join("oldagent.jsonl"), "another conversation identity");
	const collided = await scanSessionFilesFromDisk();
	expect([...collided.files.keys()]).not.toContain("OldAgent");
	expect([...collided.ambiguous].map(id => id.toLowerCase())).toContain("oldagent");
});

it("keeps branch selection and restored tool-result lookahead in stored prefixes", async () => {
	using dir = TempDir.createSync("history-restart-branch-");
	const store = new BlobStore(blobsDirForSessionDir(dir.path()));
	const result = store.putSync(Buffer.from("line A\nline B"));
	const records = [
		{ type: "session", version: 4, id: "stored", cwd: dir.path(), timestamp: "2026-11-15T00:00:00.000Z" },
		{ type: "message", id: "root", parentId: null, message: { role: "user", content: "start", timestamp: 1 } },
		{
			type: "message",
			id: "call",
			parentId: "root",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "read-call", name: "read", arguments: { path: "example.ts" } }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "result",
			parentId: "call",
			message: {
				role: "toolResult",
				toolCallId: "read-call",
				toolName: "read",
				content: [{ type: "text", text: `blobtext:sha256:${result.hash}` }],
				isError: false,
				timestamp: 3,
			},
		},
		{
			type: "message",
			id: "abandoned",
			parentId: "root",
			message: { role: "user", content: "wrong branch", timestamp: 4 },
		},
		{ type: "message", id: "selected", parentId: "result", message: { role: "user", content: "kept", timestamp: 5 } },
	];
	await fs.writeFile(
		dir.join("OldAgent.jsonl"),
		records.map(record => JSON.stringify({ timestamp: "2026-11-15T00:00:00.000Z", ...record })).join("\n") + "\n",
	);
	registerArtifactsDir(dir.path());
	const view = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://OldAgent"), {
		historyMaxLines: 13,
	});
	expect(view.content).toBe(
		"# OldAgent (on disk)\n\n## user\n\nstart\n\n## assistant\n\n→ read(example.ts) ⇒ ok · 2 lines\n\n## user\n\nkept\n",
	);
});

it("restores the selected compaction summary without reviving discarded messages", async () => {
	using dir = TempDir.createSync("history-restart-compaction-");
	const store = new BlobStore(blobsDirForSessionDir(dir.path()));
	const summary = store.putSync(Buffer.from("restored summary"));
	const records = [
		{ type: "session", version: 4, id: "stored", cwd: dir.path() },
		{ type: "message", id: "discard", parentId: null, message: { role: "user", content: "discarded", timestamp: 1 } },
		{
			type: "message",
			id: "keep",
			parentId: "discard",
			message: { role: "user", content: "retained", timestamp: 2 },
		},
		{
			type: "compaction",
			id: "compact",
			parentId: "keep",
			firstKeptEntryId: "keep",
			summary: `blobtext:sha256:${summary.hash}`,
			tokensBefore: 100,
		},
		{
			type: "message",
			id: "latest",
			parentId: "compact",
			message: { role: "user", content: "latest", timestamp: 3 },
		},
	];
	await fs.writeFile(
		dir.join("OldAgent.jsonl"),
		records.map(record => JSON.stringify({ timestamp: "2026-11-15T00:00:00.000Z", ...record })).join("\n") + "\n",
	);
	registerArtifactsDir(dir.path());
	const view = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://OldAgent"), {
		historyMaxLines: 20,
	});
	expect(view.content).toContain("[compaction] restored summary");
	expect(view.content).toContain("retained");
	expect(view.content).toContain("latest");
	expect(view.content).not.toContain("discarded");
});
