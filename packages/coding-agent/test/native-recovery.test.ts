import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeTitleSlot } from "../../../kernel/src/session/session-title-slot";
import {
	captureNativeCheckpoint,
	forkNativeCheckpoint,
	restoreNativeCheckpoint,
} from "../src/checkpoints/native-recovery";

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
});
