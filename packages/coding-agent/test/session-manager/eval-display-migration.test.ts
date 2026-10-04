import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { migrateSessionEntries, migrateToCurrentVersion } from "@veyyon/kernel/session/session-migrations";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import { sessionFileStem } from "@veyyon/utils/session-file";
import { EVAL_DISPLAY_VERSION } from "../../src/tools/shell/eval-display";
import { evalResultCodec } from "../../src/tools/shell/eval-result-codec";

registerToolResultCodecs([evalResultCodec]);

function entriesFor(cwd: string, values: unknown[], displayVersion?: number): FileEntry[] {
	return [
		{ type: "session", version: 3, id: "legacy", timestamp: "2026-10-03T00:00:00Z", cwd },
		{
			type: "message",
			id: "result",
			parentId: null,
			timestamp: "2026-10-03T00:00:01Z",
			message: {
				role: "toolResult",
				toolName: "eval",
				toolCallId: "call",
				content: [{ type: "text", text: "display" }],
				isError: false,
				timestamp: 1,
				details: { jsonOutputs: values, ...(displayVersion === undefined ? {} : { displayVersion }) },
			},
		},
	] as FileEntry[];
}

function detailsOf(entry: FileEntry | undefined): { displayVersion?: number; jsonOutputs: unknown[] } {
	if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Expected eval result");
	return entry.message.details as { displayVersion?: number; jsonOutputs: unknown[] };
}

describe("registered eval display persistence migration", () => {
	let root: string;
	let file: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "eval-display-migration-"));
		file = path.join(root, "legacy.jsonl");
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function persist(values: unknown[], displayVersion?: number): Promise<string> {
		const text = `${entriesFor(root, values, displayVersion)
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`;
		await fs.writeFile(file, text);
		return text;
	}

	it("migrates oversized values on writable flush and preserves small values", async () => {
		const large = { payload: "x".repeat(100000) };
		const small = { ok: true };
		await persist([large, small]);
		const session = await SessionManager.open(file, root);
		expect(detailsOf(session.getEntries()[0]).jsonOutputs).toEqual([large, small]);
		await session.flush();
		const details = detailsOf(session.getEntries()[0]);
		expect(details.displayVersion).toBe(EVAL_DISPLAY_VERSION);
		expect(details.jsonOutputs[1]).toEqual(small);
		const preview = details.jsonOutputs[0] as { artifactId: string; version: number };
		expect(preview.version).toBe(1);
		expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThan(10000);
		const recovery = await session.getArtifactPath(preview.artifactId);
		if (!recovery) throw new Error("Expected complete artifact");
		expect(await fs.readFile(recovery, "utf8")).toBe(JSON.stringify(large, null, 2));
		const header = (await loadEntriesFromFile(file))[0];
		if (header?.type !== "session") throw new Error("Expected header");
		expect(header.version).toBe(4);
	});

	it("does not duplicate artifacts after resume and flush", async () => {
		await persist([{ payload: "x".repeat(12000) }]);
		const session = await SessionManager.open(file, root);
		await session.flush();
		const first = await fs.readdir(sessionFileStem(file));
		const reopened = await SessionManager.open(file, root);
		await reopened.flush();
		expect(await fs.readdir(sessionFileStem(file))).toEqual(first);
	});

	it("leaves the file intact when writable migration cannot save an artifact", async () => {
		const original = await persist([{ payload: "x".repeat(12000) }]);
		await fs.writeFile(sessionFileStem(file), "blocking file");
		const session = await SessionManager.open(file, root);
		await expect(session.flush()).rejects.toThrow();
		expect(await fs.readFile(file, "utf8")).toBe(original);
		expect(detailsOf(session.getEntries()[0]).displayVersion).toBeUndefined();
	});

	it("rejects unsupported future display versions on writable flush", async () => {
		await persist([{ ok: true }], 99);
		const session = await SessionManager.open(file, root);
		await expect(session.flush()).rejects.toThrow("Unsupported eval display version: 99");
	});

	it("versions legacy bounded previews without fabricating complete artifacts", async () => {
		const old = { preview: "hello\n[…100ch elided…]", truncated: true, totalBytes: 12000 };
		await persist([old]);
		const session = await SessionManager.open(file, root);
		await session.flush();
		expect(detailsOf(session.getEntries()[0]).jsonOutputs[0]).toEqual({
			...old,
			version: 1,
			recoveryUnavailable: true,
		});
		await expect(fs.stat(sessionFileStem(file))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves complete values resembling legacy previews on flush and reopen", async () => {
		const smallComplete = {
			preview: "hello\n[…100ch elided…]",
			truncated: true,
			totalBytes: 12000,
			extraPayload: "secret-complete-data",
		};
		const largeSecret = "LARGE-SECRET-PAYLOAD-".repeat(1000);
		const misleadingArtifactId = "dangling-artifact-id-9999";
		const largeComplete = {
			preview: "hello\n[…100ch elided…]",
			truncated: true,
			totalBytes: 12000,
			extraPayload: largeSecret,
			artifactId: misleadingArtifactId,
		};

		await persist([smallComplete, largeComplete]);
		const session = await SessionManager.open(file, root);
		expect(detailsOf(session.getEntries()[0]).jsonOutputs).toEqual([smallComplete, largeComplete]);

		await session.flush();

		const flushedDetails = detailsOf(session.getEntries()[0]);
		expect(flushedDetails.displayVersion).toBe(EVAL_DISPLAY_VERSION);
		expect(flushedDetails.jsonOutputs[0]).toEqual(smallComplete);

		const largeMigrated = flushedDetails.jsonOutputs[1] as {
			version: number;
			preview: string;
			truncated: boolean;
			totalBytes: number;
			artifactId: string;
		};
		expect(largeMigrated.version).toBe(EVAL_DISPLAY_VERSION);
		expect(largeMigrated.truncated).toBe(true);
		expect(largeMigrated.artifactId).not.toBe(misleadingArtifactId);

		const artifactPath = await session.getArtifactPath(largeMigrated.artifactId);
		if (!artifactPath) throw new Error("Expected complete artifact for large value");
		const artifactJson = await fs.readFile(artifactPath, "utf8");
		expect(artifactJson).toBe(JSON.stringify(largeComplete, null, 2));
		expect(JSON.parse(artifactJson)).toEqual(largeComplete);

		const reopened = await SessionManager.open(file, root);
		const reopenedDetails = detailsOf(reopened.getEntries()[0]);
		expect(reopenedDetails.displayVersion).toBe(EVAL_DISPLAY_VERSION);
		expect(reopenedDetails.jsonOutputs[0]).toEqual(smallComplete);
		expect(reopenedDetails.jsonOutputs[1]).toEqual(largeMigrated);

		const reopenedArtifactPath = await reopened.getArtifactPath(largeMigrated.artifactId);
		if (!reopenedArtifactPath) throw new Error("Expected complete artifact on reopen");
		expect(await fs.readFile(reopenedArtifactPath, "utf8")).toBe(JSON.stringify(largeComplete, null, 2));

		const stemDir = sessionFileStem(file);
		const artifactsBefore = await fs.readdir(stemDir);
		const diskTextBefore = await fs.readFile(file, "utf8");

		await reopened.flush();

		expect(await fs.readdir(stemDir)).toEqual(artifactsBefore);
		expect(await fs.readFile(file, "utf8")).toBe(diskTextBefore);
		expect(detailsOf(reopened.getEntries()[0]).jsonOutputs[0]).toEqual(smallComplete);
		expect(detailsOf(reopened.getEntries()[0]).jsonOutputs[1]).toEqual(largeMigrated);
	});

	it("keeps recovery complete and details bounded after a second reopen", async () => {
		const large = { payload: "recovery-".repeat(2000) };
		await persist([large]);
		const session = await SessionManager.open(file, root);
		await session.flush();
		const reopened = await SessionManager.open(file, root);
		const details = detailsOf(reopened.getEntries()[0]);
		expect(Buffer.byteLength(JSON.stringify(details))).toBeLessThan(10000);
		const output = details.jsonOutputs[0] as { artifactId: string };
		const recovery = await reopened.getArtifactPath(output.artifactId);
		if (!recovery) throw new Error("Expected recovery artifact");
		expect(await fs.readFile(recovery, "utf8")).toBe(JSON.stringify(large, null, 2));
		await reopened.flush();
	});

	it("counts elided astral characters by code point", async () => {
		const large = { payload: "😀".repeat(3000) };
		await persist([large]);
		const session = await SessionManager.open(file, root);
		await session.flush();
		const output = detailsOf(session.getEntries()[0]).jsonOutputs[0] as { preview: string };
		const marker = output.preview.match(/\n\[…(\d+)ch elided…\]$/);
		if (!marker || marker.index === undefined) throw new Error("Expected elision marker");
		const omitted = JSON.stringify(large, null, 2).slice(marker.index);
		expect(Number(marker[1])).toBe([...omitted].length);
	});

	it("synchronous structural migration defers domain payloads without loss", () => {
		const entries = entriesFor(root, [{ payload: "x".repeat(12000) }]);
		const original = structuredClone(entries);
		migrateSessionEntries(entries);
		expect(entries).toEqual(original);
	});

	it("retries an asynchronous registered saver after rejection", async () => {
		const entries = entriesFor(root, [{ payload: "x".repeat(12000) }]);
		const original = structuredClone(entries);
		await expect(
			migrateToCurrentVersion(entries, {
				saveArtifact: async () => {
					throw new Error("denied");
				},
			}),
		).rejects.toThrow("denied");
		expect(entries).toEqual(original);
		await migrateToCurrentVersion(entries, { saveArtifact: async () => "recovered" });
		expect((detailsOf(entries[1]).jsonOutputs[0] as { artifactId: string }).artifactId).toBe("recovered");
	});

	it("never downgrades a future session version without a saver", async () => {
		const entries = entriesFor(root, [{ ok: true }], EVAL_DISPLAY_VERSION);
		const header = entries[0];
		if (header?.type !== "session") throw new Error("Expected header");
		header.version = 5;
		const original = structuredClone(entries);
		expect(await migrateToCurrentVersion(entries)).toBe(false);
		expect(entries).toEqual(original);
	});

	it("never downgrades or rewrites a future session version with a saver", async () => {
		const entries = entriesFor(root, [{ payload: "x".repeat(12000) }]);
		const header = entries[0];
		if (header?.type !== "session") throw new Error("Expected header");
		header.version = 5;
		const original = structuredClone(entries);
		let saves = 0;
		const migrated = await migrateToCurrentVersion(entries, {
			saveArtifact: async () => {
				saves++;
				return "unexpected";
			},
		});
		expect(migrated).toBe(false);
		expect(saves).toBe(0);
		expect(entries).toEqual(original);
	});

	it("keeps a future version header at v5 on disk after open, append and flush", async () => {
		const text = (await persist([{ ok: true }])).replace('"version":3', '"version":5');
		await fs.writeFile(file, text);
		const session = await SessionManager.open(file, root);
		session.appendCustomEntry("note", { n: 1 });
		await session.flush();
		const header = (await loadEntriesFromFile(file))[0];
		if (header?.type !== "session") throw new Error("Expected header");
		expect(header.version).toBe(5);
	});

	it("still migrates pending eval payloads in a current-version file", async () => {
		const entries = entriesFor(root, [{ payload: "x".repeat(12000) }]);
		const header = entries[0];
		if (header?.type !== "session") throw new Error("Expected header");
		header.version = 4;
		expect(await migrateToCurrentVersion(entries, { saveArtifact: async () => "saved" })).toBe(true);
		expect((detailsOf(entries[1]).jsonOutputs[0] as { artifactId: string }).artifactId).toBe("saved");
		expect(header.version).toBe(4);
	});
});
