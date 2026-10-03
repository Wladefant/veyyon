import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry, SessionHeader, SessionMessageEntry } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { EVAL_DISPLAY_VERSION, migrateSessionEntries } from "@veyyon/kernel/session/session-migrations";
import { setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";
import { sessionFileStem } from "@veyyon/utils/session-file";

describe("SessionManager eval display migration (v3 -> v4)", () => {
	let testAgentDir: string;
	let tempDir: string;
	const dirOverrides = captureDirOverrides();

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-eval-migration-agent-"));
		setAgentDir(testAgentDir);
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-eval-migration-"));
	});

	afterEach(async () => {
		restoreDirOverrides(dirOverrides);
		await fsp.rm(testAgentDir, { recursive: true, force: true });
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("migrates a v3 session with oversized eval jsonOutputs to versioned bounded preview with durable artifact", async () => {
		const sessionFile = path.join(tempDir, "session-v3.jsonl");
		const largePayload = {
			key: "large_data_block",
			items: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item_${i}`, data: "x".repeat(50) })),
		};
		const smallPayload = { ok: true, count: 42 };

		const headerEntry: SessionHeader = {
			type: "session",
			id: "test-v3-session",
			version: 3,
			timestamp: "2026-10-01T00:00:00.000Z",
			cwd: tempDir,
		};
		const userMsg: SessionMessageEntry = {
			type: "message",
			id: "msg-user-1",
			parentId: null,
			timestamp: "2026-10-01T00:00:01.000Z",
			message: {
				role: "user",
				content: "run eval",
				timestamp: Date.now(),
			},
		};
		const evalResultMsg: SessionMessageEntry = {
			type: "message",
			id: "msg-eval-1",
			parentId: "msg-user-1",
			timestamp: "2026-10-01T00:00:02.000Z",
			message: {
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "eval",
				content: [{ type: "text", text: "result text" }],
				isError: false,
				details: {
					jsonOutputs: [largePayload, smallPayload],
				},
				timestamp: Date.now(),
			},
		};

		await fsp.writeFile(
			sessionFile,
			`${[JSON.stringify(headerEntry), JSON.stringify(userMsg), JSON.stringify(evalResultMsg)].join("\n")}\n`,
			"utf-8",
		);

		// Resume the session using SessionManager
		const session = await SessionManager.open(sessionFile, tempDir);
		await session.flush();

		// Check in-memory state
		const entries = session.getEntries();
		const toolEntry = entries.find(e => e.id === "msg-eval-1");
		if (!toolEntry || toolEntry.type !== "message") throw new Error("Expected message entry");
		const toolMsg = toolEntry.message;
		if (toolMsg.role !== "toolResult") throw new Error("Expected toolResult message");

		const details = toolMsg.details as Record<string, unknown>;
		expect(details.displayVersion).toBe(EVAL_DISPLAY_VERSION);

		const outputs = details.jsonOutputs as Array<Record<string, unknown>>;
		expect(outputs).toBeDefined();
		expect(outputs.length).toBe(2);

		// First output was oversized -> versioned, bounded, durable artifact reference
		const firstOutput = outputs[0];
		expect(firstOutput).toBeDefined();
		if (!firstOutput) throw new Error("Expected first output");
		expect(firstOutput.version).toBe(EVAL_DISPLAY_VERSION);
		expect(firstOutput.truncated).toBe(true);
		expect(typeof firstOutput.totalBytes).toBe("number");
		expect(firstOutput.totalBytes).toBeGreaterThan(8000);
		expect(typeof firstOutput.preview).toBe("string");
		expect(firstOutput.preview).toContain("…");
		expect(firstOutput.preview).toContain("ch elided…");
		expect(typeof firstOutput.artifactId).toBe("string");

		// Second output was small -> untouched
		expect(outputs[1]).toEqual(smallPayload);

		// Verify artifact is durable on disk and full payload is recoverable
		const artifactId = firstOutput.artifactId as string;
		const artifactPath = await session.getArtifactPath(artifactId);
		expect(artifactPath).not.toBeNull();
		if (!artifactPath) throw new Error("Expected artifact path");
		expect(fs.existsSync(artifactPath)).toBe(true);

		const artifactContent = await fsp.readFile(artifactPath, "utf-8");
		expect(artifactContent).toBe(JSON.stringify(largePayload, null, 2));

		// Verify disk file after flush is upgraded to version 4 with bounded preview
		const persistedEntries = await loadEntriesFromFile(sessionFile);
		const persistedHeader = persistedEntries[0];
		if (!persistedHeader || persistedHeader.type !== "session") throw new Error("Expected persisted session header");
		expect(persistedHeader.version).toBe(4);

		// Artifact directory should match sessionFileStem
		const expectedArtifactDir = sessionFileStem(sessionFile);
		expect(path.dirname(artifactPath)).toBe(expectedArtifactDir);
	});

	it("preserves bounded shape without duplicating artifacts on subsequent resume and flush", async () => {
		const sessionFile = path.join(tempDir, "session-idempotent.jsonl");
		const largePayload = { data: "y".repeat(12000) };

		const rawContent = `${[
			JSON.stringify({ type: "session", id: "s-idemp", version: 3, timestamp: "t0", cwd: tempDir }),
			JSON.stringify({
				type: "message",
				id: "m-eval",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "eval",
					content: [{ type: "text", text: "out" }],
					details: { jsonOutputs: [largePayload] },
					timestamp: 1,
				},
			}),
		].join("\n")}\n`;

		await fsp.writeFile(sessionFile, rawContent, "utf-8");

		// First open & flush migrates to v4
		const session1 = await SessionManager.open(sessionFile, tempDir);
		await session1.flush();

		const artifactManager = session1.getArtifactManager();
		const filesAfterFirst = await artifactManager?.listFiles();
		expect(filesAfterFirst?.length).toBe(1);

		// Second open & flush on already migrated v4 session
		const session2 = await SessionManager.open(sessionFile, tempDir);
		await session2.flush();

		const filesAfterSecond = await session2.getArtifactManager()?.listFiles();
		// Artifact count must remain exactly 1, no duplicate artifacts created
		expect(filesAfterSecond?.length).toBe(1);

		const entries = session2.getEntries();
		const toolEntry = entries[0];
		if (!toolEntry || toolEntry.type !== "message") throw new Error("Expected message");
		const toolMsg = toolEntry.message;
		if (toolMsg.role !== "toolResult") throw new Error("Expected toolResult");
		const details = toolMsg.details as Record<string, unknown>;
		expect(details.displayVersion).toBe(EVAL_DISPLAY_VERSION);
		const outputs = details.jsonOutputs as Array<Record<string, unknown>>;
		const firstOutput = outputs[0];
		if (!firstOutput) throw new Error("Expected first output");
		expect(firstOutput.version).toBe(EVAL_DISPLAY_VERSION);
		expect(firstOutput.truncated).toBe(true);
	});

	it("fails closed on artifact directory write failure without lossy silent no-op", async () => {
		const sessionFile = path.join(tempDir, "session-fail-closed.jsonl");
		const largePayload = { data: "z".repeat(15000) };

		const rawContent = `${[
			JSON.stringify({ type: "session", id: "s-fail", version: 3, timestamp: "t0", cwd: tempDir }),
			JSON.stringify({
				type: "message",
				id: "m-eval-fail",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "eval",
					content: [{ type: "text", text: "out" }],
					details: { jsonOutputs: [largePayload] },
					timestamp: 1,
				},
			}),
		].join("\n")}\n`;

		await fsp.writeFile(sessionFile, rawContent, "utf-8");

		// Block artifact directory creation by creating a regular file at the artifact dir path
		const artifactDirPath = sessionFileStem(sessionFile);
		await fsp.writeFile(artifactDirPath, "blocking file", "utf-8");

		// SessionManager.open must fail because artifact save fails, protecting against silent data loss
		let failed = false;
		try {
			await SessionManager.open(sessionFile, tempDir);
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);

		// Verify session file on disk remains completely intact and unmodified
		const fileOnDisk = await fsp.readFile(sessionFile, "utf-8");
		expect(fileOnDisk).toBe(rawContent);
	});

	it("rejects unsupported future display versions during migration", async () => {
		const sessionFile = path.join(tempDir, "session-future-version.jsonl");
		const rawContent = `${[
			JSON.stringify({ type: "session", id: "s-future", version: 3, timestamp: "t0", cwd: tempDir }),
			JSON.stringify({
				type: "message",
				id: "m-eval-future",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "eval",
					content: [{ type: "text", text: "out" }],
					details: { jsonOutputs: [{ some: "data" }], displayVersion: 99 },
					timestamp: 1,
				},
			}),
		].join("\n")}\n`;

		await fsp.writeFile(sessionFile, rawContent, "utf-8");

		let error: Error | undefined;
		try {
			await SessionManager.open(sessionFile, tempDir);
		} catch (err) {
			error = err as Error;
		}
		expect(error).toBeDefined();
		expect(error?.message).toContain("Unsupported eval display version: 99");
	});

	it("upgrades legacy bounded preview shape cleanly to versioned shape without fabricating artifacts", async () => {
		const sessionFile = path.join(tempDir, "session-legacy-preview.jsonl");
		const legacyPreviewNoArtifact = {
			preview: '{"truncated": true}\n[…500ch elided…]',
			truncated: true,
			totalBytes: 15000,
		};
		const legacyPreviewWithArtifact = {
			preview: '{"truncated": true}\n[…200ch elided…]',
			truncated: true,
			totalBytes: 8500,
			artifactId: "legacy-art-ref-1",
		};

		const rawContent = `${[
			JSON.stringify({ type: "session", id: "s-legacy-prev", version: 3, timestamp: "t0", cwd: tempDir }),
			JSON.stringify({
				type: "message",
				id: "m-eval-legacy",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "eval",
					content: [{ type: "text", text: "out" }],
					details: { jsonOutputs: [legacyPreviewNoArtifact, legacyPreviewWithArtifact] },
					timestamp: 1,
				},
			}),
		].join("\n")}\n`;

		await fsp.writeFile(sessionFile, rawContent, "utf-8");

		const session = await SessionManager.open(sessionFile, tempDir);
		await session.flush();

		const entries = session.getEntries();
		const toolEntry = entries[0];
		if (!toolEntry || toolEntry.type !== "message") throw new Error("Expected message");
		const toolMsg = toolEntry.message;
		if (toolMsg.role !== "toolResult") throw new Error("Expected toolResult");
		const details = toolMsg.details as Record<string, unknown>;
		expect(details.displayVersion).toBe(EVAL_DISPLAY_VERSION);

		const outputs = details.jsonOutputs as Array<Record<string, unknown>>;
		const output0 = outputs[0];
		if (!output0) throw new Error("Expected output 0");
		expect(output0.version).toBe(EVAL_DISPLAY_VERSION);
		expect(output0.truncated).toBe(true);
		expect(output0.preview).toBe(legacyPreviewNoArtifact.preview);
		expect(output0.totalBytes).toBe(15000);
		expect(output0.artifactId).toBeUndefined();
		expect(output0.recoveryUnavailable).toBe(true);

		const output1 = outputs[1];
		if (!output1) throw new Error("Expected output 1");
		expect(output1.version).toBe(EVAL_DISPLAY_VERSION);
		expect(output1.truncated).toBe(true);
		expect(output1.preview).toBe(legacyPreviewWithArtifact.preview);
		expect(output1.totalBytes).toBe(8500);
		expect(output1.artifactId).toBe("legacy-art-ref-1");
		expect(output1.recoveryUnavailable).toBeUndefined();

		// Legacy bounded previews must NOT create artifacts of previews
		const artifactFiles = await session.getArtifactManager()?.listFiles();
		expect(artifactFiles).toEqual([]);
	});

	it("asserts loaded details bounded bytes and recovery after a second reopen", async () => {
		const sessionFile = path.join(tempDir, "session-reopen-recovery.jsonl");
		const largePayload = { data: "z".repeat(35000), numbers: Array.from({ length: 500 }, (_, i) => i) };
		const fullSerialized = JSON.stringify(largePayload, null, 2);
		const expectedBytes = Buffer.byteLength(fullSerialized, "utf-8");

		const rawContent = `${[
			JSON.stringify({ type: "session", id: "s-reopen", version: 3, timestamp: "t0", cwd: tempDir }),
			JSON.stringify({
				type: "message",
				id: "m-eval-reopen",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c-reopen-1",
					toolName: "eval",
					content: [{ type: "text", text: "result" }],
					details: { jsonOutputs: [largePayload] },
					timestamp: 1,
				},
			}),
		].join("\n")}\n`;

		await fsp.writeFile(sessionFile, rawContent, "utf-8");

		// First open & flush - migrates from v3 to v4
		const session1 = await SessionManager.open(sessionFile, tempDir);
		await session1.flush();

		const entries1 = session1.getEntries();
		const toolMsg1 = entries1[0]?.type === "message" ? entries1[0].message : null;
		if (!toolMsg1 || toolMsg1.role !== "toolResult") throw new Error("Expected toolResult");
		const details1 = toolMsg1.details as Record<string, unknown>;
		expect(details1.displayVersion).toBe(EVAL_DISPLAY_VERSION);

		const outputs1 = details1.jsonOutputs as Array<Record<string, unknown>>;
		const firstOutput1 = outputs1[0];
		if (!firstOutput1) throw new Error("Expected first output on first open");
		expect(firstOutput1.version).toBe(EVAL_DISPLAY_VERSION);
		expect(firstOutput1.truncated).toBe(true);
		expect(firstOutput1.totalBytes).toBe(expectedBytes);
		const previewBytes1 = Buffer.byteLength(String(firstOutput1.preview), "utf-8");
		expect(previewBytes1).toBeLessThanOrEqual(8000);
		expect(typeof firstOutput1.artifactId).toBe("string");

		const artifactId1 = String(firstOutput1.artifactId);
		const artifactPath1 = await session1.getArtifactPath(artifactId1);
		expect(artifactPath1).not.toBeNull();
		if (!artifactPath1) throw new Error("Expected artifact path 1");
		expect(fs.existsSync(artifactPath1)).toBe(true);
		const recovered1 = JSON.parse(await fsp.readFile(artifactPath1, "utf-8"));
		expect(recovered1).toEqual(largePayload);

		// Second open - verify loaded details remain bounded and full recovery works
		const session2 = await SessionManager.open(sessionFile, tempDir);
		const entries2 = session2.getEntries();
		const toolMsg2 = entries2[0]?.type === "message" ? entries2[0].message : null;
		if (!toolMsg2 || toolMsg2.role !== "toolResult") throw new Error("Expected toolResult");
		const details2 = toolMsg2.details as Record<string, unknown>;
		expect(details2.displayVersion).toBe(EVAL_DISPLAY_VERSION);

		// Assert loaded details byte size remains bounded (original was ~35KB+)
		const detailsBytes2 = Buffer.byteLength(JSON.stringify(details2), "utf-8");
		expect(detailsBytes2).toBeLessThan(10000);

		const outputs2 = details2.jsonOutputs as Array<Record<string, unknown>>;
		const firstOutput2 = outputs2[0];
		if (!firstOutput2) throw new Error("Expected first output on second open");
		expect(firstOutput2.version).toBe(EVAL_DISPLAY_VERSION);
		expect(firstOutput2.truncated).toBe(true);
		expect(firstOutput2.totalBytes).toBe(expectedBytes);
		const previewBytes2 = Buffer.byteLength(String(firstOutput2.preview), "utf-8");
		expect(previewBytes2).toBeLessThanOrEqual(8000);
		expect(firstOutput2.artifactId).toBe(artifactId1);
		const artifactPath2 = await session2.getArtifactPath(String(firstOutput2.artifactId));
		expect(artifactPath2).not.toBeNull();
		if (!artifactPath2) throw new Error("Expected artifact path 2");
		expect(fs.existsSync(artifactPath2)).toBe(true);
		const recovered2 = JSON.parse(await fsp.readFile(artifactPath2, "utf-8"));
		expect(recovered2).toEqual(largePayload);
	});

	it("preserves astral codepoints and computes codepoint marker correctly in preview", async () => {
		const sessionFile = path.join(tempDir, "session-astral.jsonl");
		// Create a string with many 4-byte emojis
		const emojiString = "🚀".repeat(3000); // 3000 codepoints, 6000 code units, 12000 UTF-8 bytes
		const rawContent = `${[
			JSON.stringify({ type: "session", id: "s-astral", version: 3, timestamp: "t0", cwd: tempDir }),
			JSON.stringify({
				type: "message",
				id: "m-eval-astral",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "eval",
					content: [{ type: "text", text: "out" }],
					details: { jsonOutputs: [emojiString] },
					timestamp: 1,
				},
			}),
		].join("\n")}\n`;

		await fsp.writeFile(sessionFile, rawContent, "utf-8");

		const session = await SessionManager.open(sessionFile, tempDir);
		await session.flush();

		const entries = session.getEntries();
		const toolEntry = entries[0];
		if (!toolEntry || toolEntry.type !== "message") throw new Error("Expected message");
		const toolMsg = toolEntry.message;
		if (toolMsg.role !== "toolResult") throw new Error("Expected toolResult");
		const details = toolMsg.details as Record<string, unknown>;
		const outputs = details.jsonOutputs as Array<Record<string, unknown>>;
		const preview = outputs[0]?.preview as string;

		expect(preview).toBeDefined();
		// Marker should be present with elided count in code points
		expect(preview).toMatch(/\[…\d+ch elided…\]/);
		// Astral characters must not have lone surrogates
		for (let i = 0; i < preview.length; i++) {
			const code = preview.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = preview.charCodeAt(i + 1);
				expect(next).toBeGreaterThanOrEqual(0xdc00);
				expect(next).toBeLessThanOrEqual(0xdfff);
				i++;
			} else {
				expect(code < 0xdc00 || code > 0xdfff).toBe(true);
			}
		}
	});

	it("migrates synchronously using migrateSessionEntries with synchronous artifact saver", () => {
		const largePayload = { data: "sync-data-".repeat(1500) };
		const fullSerialized = JSON.stringify(largePayload, null, 2);
		const expectedBytes = Buffer.byteLength(fullSerialized, "utf-8");

		const entries = [
			{ type: "session", id: "s-sync", version: 3, timestamp: "t0", cwd: "/tmp" },
			{
				type: "message",
				id: "m-sync",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c-sync",
					toolName: "eval",
					content: [{ type: "text", text: "res" }],
					details: { jsonOutputs: [largePayload, { small: true }] },
					timestamp: 1,
				},
			},
		] as unknown as FileEntry[];

		const saved: Record<string, string> = {};
		migrateSessionEntries(entries, {
			saveArtifact: content => {
				saved["art-sync-1"] = content;
				return "art-sync-1";
			},
		});

		const header = entries[0];
		if (!header || header.type !== "session") throw new Error("Expected session header");
		expect(header.version).toBe(4);
		const msgEntry = entries[1];
		if (!msgEntry || msgEntry.type !== "message") throw new Error("Expected message entry");
		const toolMsg = msgEntry.message;
		if (toolMsg.role !== "toolResult") throw new Error("Expected toolResult message");
		const details = toolMsg.details as Record<string, unknown>;
		expect(details.displayVersion).toBe(EVAL_DISPLAY_VERSION);
		const outputs = details.jsonOutputs as Array<Record<string, unknown>>;
		expect(outputs[0]?.version).toBe(EVAL_DISPLAY_VERSION);
		expect(outputs[0]?.truncated).toBe(true);
		expect(outputs[0]?.totalBytes).toBe(expectedBytes);
		expect(outputs[0]?.artifactId).toBe("art-sync-1");
		expect(saved["art-sync-1"]).toBe(fullSerialized);
		expect(outputs[1]).toEqual({ small: true });
	});

	it("fails synchronously when saveArtifact returns a Promise", () => {
		const entries = [
			{ type: "session", id: "s-sync-prom", version: 3, timestamp: "t0", cwd: "/tmp" },
			{
				type: "message",
				id: "m-sync-prom",
				parentId: null,
				timestamp: "t1",
				message: {
					role: "toolResult",
					toolCallId: "c-sync-prom",
					toolName: "eval",
					content: [{ type: "text", text: "res" }],
					details: { jsonOutputs: [{ oversized: "a".repeat(10000) }] },
					timestamp: 1,
				},
			},
		] as unknown as FileEntry[];

		expect(() => {
			migrateSessionEntries(entries, {
				saveArtifact: () => Promise.resolve("async-id"),
			});
		}).toThrow("Cannot migrate oversized eval display synchronously: saveArtifact returned a Promise");
	});
});
