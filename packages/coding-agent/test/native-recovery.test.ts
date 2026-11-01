import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeTitleSlot } from "../../../kernel/src/session/session-title-slot";
import {
	captureNativeCheckpoint,
	forkNativeCheckpoint,
	persistNativeHandoffIdentity,
	restoreNativeCheckpoint,
} from "../src/checkpoints/native-recovery";
import { readSessionOwnershipMarker } from "../src/checkpoints/session-ownership-marker";

const roots: string[] = [];
async function scratch(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "native-checkpoint-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("native recovery", () => {
	test("captures blobs referenced only by a child lane journal", async () => {
		const root = await scratch();
		await mkdir(join(root, "sessions"));
		await mkdir(join(root, "blobs"));
		const file = join(root, "sessions/session.jsonl");
		const artifacts = join(root, "sessions/session");
		await mkdir(artifacts);
		await writeFile(file, `${JSON.stringify({ type: "session", id: "parent", cwd: root })}\n`);
		const bytes = Buffer.from("child tool output");
		const hash = new Bun.SHA256().update(bytes).digest("hex");
		await writeFile(join(root, "blobs", hash), bytes);
		await writeFile(
			join(artifacts, "child.jsonl"),
			`${JSON.stringify({ type: "message", data: `blobtext:sha256:${hash}` })}\n`,
		);
		const bundle = await captureNativeCheckpoint(file, []);
		expect(Buffer.from(bundle.blobs[hash] ?? "", "base64")).toEqual(bytes);
	});
	test("rejects an oversized journal before decoding or allocating its body", async () => {
		const root = await scratch();
		const file = join(root, "oversized.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", id: "oversized", cwd: root })}\n`);
		// Sparse fixture: cross the raw-byte cap without a huge JS allocation.
		await truncate(file, 48 * 1024 * 1024 + 1);
		await expect(captureNativeCheckpoint(file, [])).rejects.toThrow(/capture exceeds raw-byte budget/);
	});
	test("rejects oversized artifact and approved dirty inputs against the aggregate cap", async () => {
		const root = await scratch();
		const file = join(root, "session.jsonl");
		await writeFile(file, `${JSON.stringify({ type: "session", id: "bounded", cwd: root })}\n`);
		const artifacts = join(root, "session");
		await mkdir(artifacts);
		const large = join(artifacts, "large.bin");
		await writeFile(large, "");
		// Each file equals the per-file cap, but the journal already spent bytes.
		await truncate(large, 48 * 1024 * 1024);
		await expect(captureNativeCheckpoint(file, [])).rejects.toThrow(/capture exceeds raw-byte budget/);
		await rm(large);
		const dirty = join(root, "approved.txt");
		await writeFile(dirty, "");
		await truncate(dirty, 48 * 1024 * 1024);
		await expect(captureNativeCheckpoint(file, [dirty])).rejects.toThrow(/capture exceeds raw-byte budget/);
	});
	test("preserves the native first-line title slot and forks the second-line header", async () => {
		const root = await scratch();
		const file = join(root, "session.jsonl");
		const title = serializeTitleSlot({ title: "canary", updatedAt: new Date().toISOString() });
		const journal = `${title + JSON.stringify({ type: "session", version: 3, id: "native", cwd: root })}\n`;
		await writeFile(file, journal);
		const bundle = await captureNativeCheckpoint(file, []);
		expect(Buffer.from(bundle.journal.bytes, "base64").toString()).toBe(journal);
		const fork = await forkNativeCheckpoint(bundle);
		roots.push(fork.directory);
		const restored = await readFile(join(fork.directory, "sessions", "session.jsonl"), "utf8");
		expect(restored.startsWith(title)).toBe(true);
		expect(JSON.parse(restored.split("\n")[1]!).id).toBe(fork.sessionId);
	});
	test("captures exact journal and nested artifact bytes, then restores without rewriting entries", async () => {
		const root = await scratch();
		const session = join(root, "session.jsonl");
		const artifacts = join(root, "session");
		await mkdir(artifacts);
		const journal = Buffer.from(
			'{"type":"session","version":3,"id":"s1","cwd":"/repo"}\r\n{"type":"message","id":"x"}\n',
		);
		const blob = Buffer.from([0, 255, 1, 2]);
		await writeFile(session, journal);
		await writeFile(join(artifacts, "blob.bin"), blob);
		const bundle = await captureNativeCheckpoint(session, []);
		expect(Buffer.from(bundle.journal.bytes, "base64")).toEqual(journal);
		expect(Buffer.from(bundle.artifacts["blob.bin"]!, "base64")).toEqual(blob);
		const target = join(root, "restored");
		await restoreNativeCheckpoint(bundle, target);
		expect(await readFile(join(target, "sessions", "session.jsonl"))).toEqual(journal);
		expect(await readFile(join(target, "sessions", "session", "blob.bin"))).toEqual(blob);
	});
	test("includes explicitly approved dirty files and rejects excluded and symlink paths", async () => {
		const root = await scratch();
		const session = join(root, "session.jsonl");
		await writeFile(session, `${JSON.stringify({ type: "session", id: "s", cwd: root })}\n`);
		const source = join(root, "src");
		await mkdir(source);
		const code = join(source, "dirty.ts");
		await writeFile(code, "dirty");
		const bundle = await captureNativeCheckpoint(session, [code]);
		expect(bundle.workspace.dirty).toEqual(["src/dirty.ts"]);
		const secret = join(root, ".env");
		await writeFile(secret, "secret");
		await expect(captureNativeCheckpoint(session, [secret])).rejects.toThrow(/unsafe|excluded/i);
		const link = join(root, "linked");
		await symlink(code, link);
		await expect(captureNativeCheckpoint(session, [link])).rejects.toThrow(/symbolic/i);
		await expect(captureNativeCheckpoint(session, ["../outside.ts"])).rejects.toThrow(/unsafe/i);
		const outside = await scratch();
		const outsideFile = join(outside, "public.txt");
		await writeFile(outsideFile, "outside");
		const escape = join(root, "escape");
		await symlink(outside, escape, process.platform === "win32" ? "junction" : "dir");
		await expect(captureNativeCheckpoint(session, [join(escape, "public.txt")])).rejects.toThrow(/symbolic|escapes/i);
	});
	test("restore refuses overwrite and explicit fork writes a different native session id", async () => {
		const root = await scratch();
		const session = join(root, "session.jsonl");
		await writeFile(session, `${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: root })}\n`);
		const bundle = await captureNativeCheckpoint(session, []);
		const target = join(root, "restore");
		await restoreNativeCheckpoint(bundle, target);
		await expect(restoreNativeCheckpoint(bundle, target)).rejects.toThrow(/already exists/i);
		const fork = await forkNativeCheckpoint(bundle);
		roots.push(fork.directory);
		expect(fork.sessionId).not.toBe("parent");
		const forkHeader = JSON.parse(
			(await readFile(join(fork.directory, "sessions", "session.jsonl"), "utf8")).split("\n", 1)[0]!,
		);
		expect(forkHeader.id).toBe(fork.sessionId);
		expect(forkHeader.parentSessionId).toBe("parent");
	});
	test("transferred native journals fence the source, restore identity, and clear it only on an explicit fork", async () => {
		const root = await scratch();
		const file = join(root, "session.jsonl");
		const original = `${JSON.stringify({ type: "session", id: "native-transfer", cwd: root })}\n`;
		await writeFile(file, original);
		const identity = { version: 1 as const, targetNode: "laptop-b", transferId: "transfer-1", transferEpoch: 9 };
		await persistNativeHandoffIdentity(file, identity);
		const source = await readFile(file, "utf8");
		const sourceHeader = JSON.parse(source.split("\n")[0]!) as Record<string, unknown>;
		expect(sourceHeader.checkpointHandoff).toEqual(identity);
		expect(source.split("\n").slice(1).join("\n")).toBe(original.split("\n").slice(1).join("\n"));

		await expect(readSessionOwnershipMarker(file, "native-transfer")).rejects.toThrow(/marker is missing/i);
		const bundle = await captureNativeCheckpoint(file, []);
		bundle.handoff = {
			targetNode: "laptop-b",
			transferId: "transfer-1",
			claimToken: "one-use-claim-capability-long",
			epoch: 9,
		};
		const restoredDirectory = join(root, "restored");
		await restoreNativeCheckpoint(bundle, restoredDirectory);
		roots.push(restoredDirectory);
		const restoredHeader = JSON.parse(
			(await readFile(join(restoredDirectory, "sessions", "session.jsonl"), "utf8")).split("\n")[0]!,
		) as Record<string, unknown>;
		expect(restoredHeader.checkpointHandoff).toEqual(identity);
		const restoredMarker = JSON.parse(
			await readFile(join(restoredDirectory, "sessions", "checkpoint-ownership.json"), "utf8"),
		) as { transferId: string; claimToken: string };
		expect(restoredMarker.transferId).toBe(identity.transferId);
		expect(restoredMarker.claimToken).toBe(bundle.handoff.claimToken);

		const fork = await forkNativeCheckpoint(bundle);
		roots.push(fork.directory);
		const forkHeader = JSON.parse(
			(await readFile(join(fork.directory, "sessions", "session.jsonl"), "utf8")).split("\n")[0]!,
		) as Record<string, unknown>;
		expect(forkHeader.id).toBe(fork.sessionId);
		expect(forkHeader).not.toHaveProperty("checkpointHandoff");
		expect(await readFile(file, "utf8")).toBe(source);
	});
});
