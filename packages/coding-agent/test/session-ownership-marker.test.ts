import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistSessionResumeCapability, readSessionOwnershipMarker } from "../src/checkpoints/session-ownership-marker";

const roots: string[] = [];
const identity = { version: 1 as const, targetNode: "laptop-b", transferId: "transfer-uuid", transferEpoch: 7 };
const marker = {
	sessionId: "transfer",
	...identity,
	claimToken: "a-claim-capability-long-enough",
	epoch: 7,
};
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("native handoff identity fails closed without matching recovery marker and rotates its capability", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-marker-"));
	roots.push(root);
	const sessions = join(root, "sessions");
	await mkdir(sessions);
	const sessionFile = join(sessions, "session.jsonl");
	await writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "transfer", cwd: root, checkpointHandoff: identity })}\n`);
	await writeFile(join(root, "recovery.json"), JSON.stringify({ sessionId: "transfer", checkpointTransfer: true }));
	const markerPath = join(sessions, "checkpoint-ownership.json");
	await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });

	const pending = await readSessionOwnershipMarker(sessionFile, "transfer");
	expect(pending?.marker).toEqual(marker);
	await persistSessionResumeCapability(markerPath, marker, "a-resume-capability-long-enough", 8);
	const consumed = await readSessionOwnershipMarker(sessionFile, "transfer");
	expect(consumed?.marker.claimToken).toBeUndefined();
	expect(consumed?.marker.resumeToken).toBe("a-resume-capability-long-enough");
	expect(consumed?.marker.epoch).toBe(8);
	expect(JSON.parse(await readFile(markerPath, "utf8"))).not.toHaveProperty("claimToken");

	await rm(markerPath);
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/marker is missing/i);
	await rm(join(root, "recovery.json"));
	await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/recovery metadata/i);
});

test("a copied native journal without sidecars never resumes as an ordinary checkpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-copy-"));
	roots.push(root);
	const file = join(root, "copied.jsonl");
	await writeFile(file, `${JSON.stringify({ type: "session", id: "transfer", cwd: root, checkpointHandoff: identity })}\n`);
	await expect(readSessionOwnershipMarker(file, "transfer")).rejects.toThrow(/marker is missing/i);
});

// WHY: a lazily created session has no file before its first persisted entry; the marker read raised ENOENT and blocked the
// first prompt (#716). Gap: this drives the reader, not the whole prompt path; the admission test covers that path eagerly.
test("a session whose file does not exist yet has no ownership marker", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-lazy-"));
	roots.push(root);
	await expect(readSessionOwnershipMarker(join(root, "not-yet-created.jsonl"), "lazy")).resolves.toBeNull();
});

test("a session file that cannot be read for any other reason still fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-unreadable-"));
	roots.push(root);
	const directoryInPlaceOfFile = join(root, "session.jsonl");
	await mkdir(directoryInPlaceOfFile);
	await expect(readSessionOwnershipMarker(directoryInPlaceOfFile, "lazy")).rejects.toThrow();
});
