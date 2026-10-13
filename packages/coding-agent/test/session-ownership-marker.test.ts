import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeSessionOwnershipClaim, readSessionOwnershipMarker } from "../src/checkpoints/session-ownership-marker";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("restored transfer marker activates once and fails closed when marker data disappears", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-marker-"));
	roots.push(root);
	const sessions = join(root, "sessions");
	await mkdir(sessions);
	const sessionFile = join(sessions, "session.jsonl");
	await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "transfer" })}\n`);
	await writeFile(join(root, "recovery.json"), JSON.stringify({ sessionId: "transfer", checkpointTransfer: true }));
	const markerPath = join(sessions, "checkpoint-ownership.json");
	const marker = { version: 1 as const, sessionId: "transfer", targetNode: "laptop-b", claimToken: "one-use", epoch: 7 };
	await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });

	const pending = await readSessionOwnershipMarker(sessionFile, "transfer");
	expect(pending?.marker).toEqual(marker);
	await consumeSessionOwnershipClaim(markerPath, marker);
	const consumed = await readSessionOwnershipMarker(sessionFile, "transfer");
	expect(consumed?.marker.claimToken).toBeUndefined();
	expect(JSON.parse(await readFile(markerPath, "utf8"))).not.toHaveProperty("claimToken");

	await rm(markerPath);
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/marker is missing/i);
	await rm(join(root, "recovery.json"));
	await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/recovery metadata is missing/i);
});
