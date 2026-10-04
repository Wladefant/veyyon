import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactManager } from "@veyyon/kernel/session/artifacts";
import { BlobStore, externalizeTextSync } from "@veyyon/kernel/session/blob-store";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadSessionMessagesReadOnly } from "@veyyon/kernel/session/session-loader";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { migrateSessionEntries, migrateToCurrentVersion } from "@veyyon/kernel/session/session-migrations";
import { registerToolResultCodecs } from "@veyyon/kernel/session/tool-result-codecs";
import { sessionFileStem } from "@veyyon/utils/session-file";
import { evalResultCodec } from "../../src/tools/shell/eval-result-codec";

registerToolResultCodecs([evalResultCodec]);

function legacyEntries(cwd: string, values: unknown[]): FileEntry[] {
	return [
		{ type: "session", version: 3, id: "legacy", timestamp: "2026-10-03T00:00:00Z", cwd },
		...values.map((value, index) => ({
			type: "message",
			id: `result-${index}`,
			parentId: index === 0 ? null : `result-${index - 1}`,
			timestamp: "2026-10-03T00:00:01Z",
			message: {
				role: "toolResult",
				toolName: "eval",
				toolCallId: `call-${index}`,
				content: [{ type: "text", text: "display" }],
				isError: false,
				details: { jsonOutputs: [value] },
				timestamp: 1,
			},
		})),
	] as FileEntry[];
}

function outputOf(entry: FileEntry | undefined): Record<string, unknown> {
	if (entry?.type !== "message" || entry.message.role !== "toolResult") throw new Error("Expected eval result");
	const details = entry.message.details as { jsonOutputs: Record<string, unknown>[] };
	const output = details.jsonOutputs[0];
	if (!output) throw new Error("Expected display preview");
	return output;
}

for (const nested of [false, true]) {
	it(`restores ${nested ? "nested" : "direct"} blob-backed display text before resume and read-only migration`, async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "eval-blob-migration-"));
		try {
			const sessionDir = path.join(root, "sessions", "project");
			await fs.mkdir(sessionDir, { recursive: true });
			const value = "😀".repeat(160000);
			const store = new BlobStore(path.join(root, "blobs"));
			const reference = externalizeTextSync(store, value);
			expect(reference).toStartWith("blobtext:sha256:");
			const rawValue = nested ? { payload: reference, filler: "x".repeat(9000) } : reference;
			const fullValue = nested ? { payload: value, filler: "x".repeat(9000) } : value;
			const sessionFile = path.join(sessionDir, "legacy.jsonl");
			await fs.writeFile(
				sessionFile,
				`${legacyEntries(root, [rawValue])
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`,
			);

			const original = await fs.readFile(sessionFile, "utf8");
			const originalStat = await fs.stat(sessionFile);
			await loadSessionMessagesReadOnly(sessionFile);
			const artifacts = new ArtifactManager(sessionFileStem(sessionFile));
			expect(await artifacts.listFiles()).toEqual([]);
			expect(await fs.readFile(sessionFile, "utf8")).toBe(original);
			expect((await fs.stat(sessionFile)).mtimeMs).toBe(originalStat.mtimeMs);
			await expect(fs.stat(sessionFileStem(sessionFile))).rejects.toMatchObject({ code: "ENOENT" });

			const manager = await SessionManager.open(sessionFile, root);
			await manager.flush();
			const output = outputOf(manager.getEntries()[0]);
			expect(output.version).toBe(1);
			expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(10000);
			const artifact = await manager.getArtifactPath(output.artifactId as string);
			if (!artifact) throw new Error("Expected recovery artifact");
			expect(await fs.readFile(artifact, "utf8")).toBe(JSON.stringify(fullValue, null, 2));
			await manager.flush();
			const reopened = await SessionManager.open(sessionFile, root);
			expect(outputOf(reopened.getEntries()[0])).toEqual(output);
			await reopened.flush();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
}

it("fresh artifact managers cannot overwrite each other's concurrent or synchronous allocations", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-manager-collision-"));
	try {
		const managers = Array.from({ length: 12 }, () => new ArtifactManager(root));
		const payloads = managers.map((_, index) => `complete payload ${index}`);
		const ids = await Promise.all(managers.map((manager, index) => manager.save(payloads[index]!, "eval-display")));
		expect(new Set(ids).size).toBe(managers.length);
		for (let index = 0; index < ids.length; index++) {
			const artifact = await managers[index]!.getPath(ids[index]!);
			if (!artifact) throw new Error("Expected concurrent artifact");
			expect(await fs.readFile(artifact, "utf8")).toBe(payloads[index]);
		}
		const first = new ArtifactManager(root);
		const second = new ArtifactManager(root);
		const pending = first.allocatePath("eval-display");
		const sync = second.allocatePathSync("bash");
		const asyncAllocation = await pending;
		expect(asyncAllocation.id).not.toBe(sync.id);
		await fs.writeFile(sync.path, "sync payload");
		await fs.writeFile(asyncAllocation.path, "async payload");
		expect(await fs.readFile(sync.path, "utf8")).toBe("sync payload");
		expect(await fs.readFile(asyncAllocation.path, "utf8")).toBe("async payload");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("reserves sequential IDs across migrators with different scan times", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-interleaving-"));
	try {
		const first = new ArtifactManager(root);
		const firstX = await first.save("X", "eval-display");
		const second = new ArtifactManager(root);
		const secondX = await second.save("X", "eval-display");
		const secondY = await second.save("Y", "eval-display");
		const firstY = await first.save("Y", "eval-display");
		expect(new Set([firstX, secondX, secondY, firstY]).size).toBe(4);
		const recovery = await second.getPath(secondX);
		if (!recovery) throw new Error("Expected second migrator's X artifact");
		expect(await fs.readFile(recovery, "utf8")).toBe("X");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("consecutive synchronous allocations reserve distinct paths before either is written", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-sync-reservation-"));
	try {
		const manager = new ArtifactManager(root);
		const first = manager.allocatePathSync("eval-display");
		const second = manager.allocatePathSync("eval-display");
		expect(first.id).not.toBe(second.id);
		expect(first.path).not.toBe(second.path);
		await fs.writeFile(first.path, "first payload");
		await fs.writeFile(second.path, "second payload");
		expect(await fs.readFile(first.path, "utf8")).toBe("first payload");
		expect(await fs.readFile(second.path, "utf8")).toBe("second payload");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

it("a read-only reader and a session migrator preserve both complete recovery values", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "eval-reader-migrator-"));
	try {
		const sessionFile = path.join(root, "legacy.jsonl");
		const values = [{ payload: "X".repeat(12000) }, { payload: "Y".repeat(12000) }];
		await fs.writeFile(
			sessionFile,
			`${legacyEntries(root, values)
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const [, manager] = await Promise.all([
			loadSessionMessagesReadOnly(sessionFile),
			SessionManager.open(sessionFile, root),
		]);
		await manager.flush();
		const entries = manager.getEntries();
		for (let index = 0; index < values.length; index++) {
			const output = outputOf(entries[index]);
			const recovery = await manager.getArtifactPath(output.artifactId as string);
			if (!recovery) throw new Error("Expected complete recovery artifact");
			expect(await fs.readFile(recovery, "utf8")).toBe(JSON.stringify(values[index], null, 2));
		}
		await manager.flush();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

for (const synchronous of [false, true]) {
	it(`${synchronous ? "structural-first" : "direct"} registered migration stays retryable when a later artifact save fails`, async () => {
		const entries = legacyEntries("/tmp", [{ first: "x".repeat(12000) }, { second: "y".repeat(12000) }]);
		const original = structuredClone(entries);
		let saves = 0;
		const failSecond = (content: string): string => {
			expect(content.length).toBeGreaterThan(8000);
			if (++saves === 2) throw new Error("artifact write denied");
			return `saved-${saves}`;
		};
		if (synchronous) migrateSessionEntries(entries);
		await expect(migrateToCurrentVersion(entries, { saveArtifact: failSecond })).rejects.toThrow(
			"artifact write denied",
		);
		expect(entries).toEqual(original);
		saves = 0;
		const succeed = (): string => `recovered-${++saves}`;
		await migrateToCurrentVersion(entries, { saveArtifact: succeed });
		expect(saves).toBe(2);
		const header = entries[0];
		if (header?.type !== "session") throw new Error("Expected session header");
		expect(header.version).toBe(4);
		expect(outputOf(entries[1]).artifactId).toBe("recovered-1");
		expect(outputOf(entries[2]).artifactId).toBe("recovered-2");
	});
}
