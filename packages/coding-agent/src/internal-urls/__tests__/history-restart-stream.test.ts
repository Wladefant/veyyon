import { afterEach, expect, it, spyOn } from "bun:test";
import type { Dirent } from "node:fs";
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

it("persists the disk index when ignored artifact reservations exceed its entry cap", async () => {
	using dir = TempDir.createSync("history-restart-reservations-");
	const sessionFile = dir.join("OldAgent.jsonl");
	await fs.writeFile(sessionFile, "not needed for lookup");
	const readdir = fs.readdir;
	const rootEntries = [
		{
			name: "OldAgent.jsonl",
			isDirectory: () => false,
			isFile: () => true,
			isSymbolicLink: () => false,
		},
		...Array.from({ length: 100_001 }, (_, index) => ({
			name: `.artifact-id-${index + 1}`,
			isDirectory: () => true,
			isFile: () => false,
		})),
	] as unknown as Dirent[];
	const initialListing = spyOn(fs, "readdir").mockImplementation(((...args: Parameters<typeof fs.readdir>) => {
		if (String(args[0]) === dir.path()) return Promise.resolve(rootEntries);
		return readdir(...args);
	}) as typeof fs.readdir);
	try {
		registerArtifactsDir(dir.path());
		expect((await scanSessionFilesFromDisk()).files.get("OldAgent")).toBe(sessionFile);
	} finally {
		initialListing.mockRestore();
	}

	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
	registerArtifactsDir(dir.path());
	const cachedListing = spyOn(fs, "readdir").mockImplementation(((...args: Parameters<typeof fs.readdir>) => {
		if (String(args[0]) === dir.path()) throw new Error("indexed root enumerated again");
		return readdir(...args);
	}) as typeof fs.readdir);
	try {
		expect((await scanSessionFilesFromDisk()).files.get("OldAgent")).toBe(sessionFile);
	} finally {
		cachedListing.mockRestore();
	}
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

it("discovers transcripts under a symlinked registered root while skipping untrusted descendant symlinks", async () => {
	using target = TempDir.createSync("history-symlink-target-");
	using linkParent = TempDir.createSync("history-symlink-root-");
	using untrustedTarget = TempDir.createSync("history-symlink-untrusted-");
	const rootLink = `${linkParent.path()}/artifacts-root`;
	await fs.writeFile(
		target.join("OldAgent.jsonl"),
		JSON.stringify({ type: "session", version: 4, id: "sym", cwd: target.path(), timestamp: "2026-11-15T00:00:00.000Z" }) +
			"\n" +
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-11-15T00:00:01.000Z",
				message: { role: "user", content: "from symlink root", timestamp: 1 },
			}) +
			"\n",
	);
	await fs.writeFile(
		untrustedTarget.join("UntrustedChild.jsonl"),
		JSON.stringify({ type: "session", version: 4, id: "untrusted", cwd: untrustedTarget.path(), timestamp: "2026-11-15T00:00:00.000Z" }) + "\n",
	);
	const linkType = process.platform === "win32" ? "junction" : "dir";
	await fs.symlink(target.path(), rootLink, linkType);
	await fs.symlink(untrustedTarget.path(), target.join("untrusted-sub"), linkType);
	registerArtifactsDir(rootLink);
	const scan = await scanSessionFilesFromDisk();
	expect(scan.files.has("OldAgent")).toBe(true);
	expect(scan.files.has("UntrustedChild")).toBe(false);
	const view = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://OldAgent"), {
		historyMaxLines: 10,
	});
	expect(view.content).toContain("from symlink root");
});

it("renders a bounded prefix when the first user message or tool result references a >8 MiB text blob", async () => {
	using dir = TempDir.createSync("history-large-blob-");
	const store = new BlobStore(blobsDirForSessionDir(dir.path()));
	const hugeUser = store.putSync(Buffer.from(`line-1\nline-2\n${"x".repeat(9 * 1024 * 1024)}`));
	const hugeTool = store.putSync(Buffer.from(`tool-summary-line\n${"y".repeat(9 * 1024 * 1024)}`));
	await fs.writeFile(
		dir.join("BigAgent.jsonl"),
		[
			{ type: "session", version: 4, id: "big", cwd: dir.path(), timestamp: "2026-11-15T00:00:00.000Z" },
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-11-15T00:00:01.000Z",
				message: { role: "user", content: `blobtext:sha256:${hugeUser.hash}`, timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-11-15T00:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "foo.ts" } }],
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "t1",
				parentId: "a1",
				timestamp: "2026-11-15T00:00:03.000Z",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: `blobtext:sha256:${hugeTool.hash}` }],
					isError: false,
					timestamp: 3,
				},
			},
		]
			.map(record => JSON.stringify(record))
			.join("\n") + "\n",
	);
	registerArtifactsDir(dir.path());
	const view = await new HistoryProtocolHandler().resolve(parseInternalUrl("history://BigAgent"), {
		historyMaxLines: 12,
	});
	expect(view.content).toContain("line-1");
	expect(view.content).toContain("line-2");
});
