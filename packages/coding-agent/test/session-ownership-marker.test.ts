import { afterEach, expect, test } from "bun:test";
import { serializeTitleSlot } from "@veyyon/kernel/session/session-title-slot";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	persistSessionResumeCapability,
	readSessionOwnershipMarker,
} from "../src/checkpoints/session-ownership-marker";

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
	await writeFile(
		sessionFile,
		`${JSON.stringify({ type: "session", id: "transfer", cwd: root, checkpointHandoff: identity })}\n`,
	);
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
	expect((await readdir(sessions)).filter(name => name.endsWith(".tmp"))).toEqual([]);

	await rm(markerPath);
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/marker is missing/i);
	await rm(join(root, "recovery.json"));
	await writeFile(markerPath, JSON.stringify(marker), { mode: 0o600 });
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/recovery metadata/i);
});

// Refused replacement must not leave a temporary one-use capability behind.
test("a failed resume-marker rename removes the temporary capability", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-refused-rename-"));
	roots.push(root);
	const target = join(root, "checkpoint-ownership.json");
	await mkdir(target);
	await expect(persistSessionResumeCapability(target, marker, "a-resume-capability-long-enough", 8)).rejects.toThrow(
		/Could not persist the rotated session resume capability/,
	);
	expect(await readdir(root)).toEqual(["checkpoint-ownership.json"]);
});

test("ownership sidecars reject overlong capabilities and 64 KiB overflow before admission", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-bounded-sidecar-"));
	roots.push(root);
	const sessions = join(root, "sessions");
	await mkdir(sessions);
	const sessionFile = join(sessions, "session.jsonl");
	await writeFile(
		sessionFile,
		JSON.stringify({ type: "session", id: "transfer", cwd: root, checkpointHandoff: identity }) + "\n",
	);
	const recoveryPath = join(root, "recovery.json");
	await writeFile(recoveryPath, JSON.stringify({ sessionId: "transfer", checkpointTransfer: true }));
	const markerPath = join(sessions, "checkpoint-ownership.json");
	for (const invalid of [
		{ ...marker, claimToken: "x".repeat(129) },
		{ ...marker, claimToken: undefined, resumeToken: "x".repeat(129) },
	]) {
		await writeFile(markerPath, JSON.stringify(invalid));
		await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/marker is missing or invalid/);
	}
	await writeFile(markerPath, JSON.stringify(marker).padEnd(64 * 1024, " "));
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).resolves.toMatchObject({ marker });
	await writeFile(markerPath, JSON.stringify(marker).padEnd(64 * 1024 + 1, " "));
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/ownership marker is unreadable/);
	await writeFile(markerPath, JSON.stringify(marker));
	await writeFile(recoveryPath, JSON.stringify({ sessionId: "transfer", checkpointTransfer: true }).padEnd(64 * 1024 + 1, " "));
	await expect(readSessionOwnershipMarker(sessionFile, "transfer")).rejects.toThrow(/Cannot verify restored checkpoint ownership/);
});

test("a copied native journal without sidecars never resumes as an ordinary checkpoint", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-copy-"));
	roots.push(root);
	const file = join(root, "copied.jsonl");
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", id: "transfer", cwd: root, checkpointHandoff: identity })}\n`,
	);
	await expect(readSessionOwnershipMarker(file, "transfer")).rejects.toThrow(/marker is missing/i);
});

// WHY: a lazily created session has no file before its first persisted entry; the marker read raised ENOENT and blocked the
// first prompt (#716). Gap: the admission test below covers the real prompt path and ordinary ownership acquisition.
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

// WHY: native transfer journals do not have recovery sidecars on the source
// machine. A header longer than the bounded ownership read used to look like
// an ordinary, untransferred session and bypass the handoff admission fence.
test("an oversized native handoff header cannot masquerade as an ordinary session", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-large-header-"));
	roots.push(root);
	const transferredFile = join(root, "transferred.jsonl");
	await writeFile(
		transferredFile,
		JSON.stringify({
			type: "session",
			id: "transfer",
			cwd: root,
			padding: "x".repeat(70 * 1024),
			checkpointHandoff: identity,
		}) + "\n",
	);
	// There is deliberately no recovery.json or ownership sidecar: this is the
	// source journal whose transfer fence must live in its own header.
	await expect(readSessionOwnershipMarker(transferredFile, "transfer")).rejects.toThrow(
		/Native session header is missing or exceeds the ownership-read limit/,
	);

	const ordinaryFile = join(root, "ordinary.jsonl");
	await writeFile(ordinaryFile, JSON.stringify({ type: "session", id: "ordinary", cwd: root }) + "\n");
	await expect(readSessionOwnershipMarker(ordinaryFile, "ordinary")).resolves.toBeNull();
});

test("an existing malformed native journal never acquires ordinary ownership", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-invalid-header-"));
	roots.push(root);
	const file = join(root, "broken.jsonl");
	await writeFile(file, '{"type":"session","id":"broken","cwd":');
	await expect(readSessionOwnershipMarker(file, "broken")).rejects.toThrow(
		/Native session header is missing or exceeds the ownership-read limit/,
	);
});

// WHY: the first physical JSONL line alone defines the session's identity;
// a corrupt transfer header cannot be replaced by a later normal header.
test("a corrupt first native header cannot be replaced by a later ordinary header", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-first-header-"));
	roots.push(root);
	const file = join(root, "forged.jsonl");
	await writeFile(
		file,
		'{"type":"session","id":"transfer","checkpointHandoff":\n' +
			JSON.stringify({ type: "session", id: "transfer", cwd: "/scratch" }) + "\n",
	);
	await expect(readSessionOwnershipMarker(file, "transfer")).rejects.toThrow(
		/Native session header is missing or exceeds the ownership-read limit/,
	);

	const validFile = join(root, "valid.jsonl");
	await writeFile(
		validFile,
		JSON.stringify({ type: "session", id: "ordinary", cwd: root }) + "\n" +
			JSON.stringify({ type: "message", id: "entry-1", parentId: null }) + "\n",
	);
	await expect(readSessionOwnershipMarker(validFile, "ordinary")).resolves.toBeNull();
});



// WHY: a syntactically complete 64-KiB prefix is not proof the same physical
// journal header ends there; a trailing unchecked suffix must fail closed.
test("a native header whose valid prefix hides a longer physical line is rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-header-boundary-"));
	roots.push(root);
	const file = join(root, "oversized-trailing-header.jsonl");
	const prefix = JSON.stringify({ type: "session", id: "transfer", cwd: root });
	const malformed = prefix.padEnd(64 * 1024, " ") + ', "checkpointHandoff": ' + JSON.stringify(identity) + "\n";
	await writeFile(file, malformed);
	// The old 64-KiB read parsed a complete JSON prefix and ignored the suffix.
	await expect(readSessionOwnershipMarker(file, "transfer")).rejects.toThrow(
		/Native session header is missing or exceeds the ownership-read limit/,
	);

	const allowed = join(root, "max-size-ordinary.jsonl");
	const normal = JSON.stringify({ type: "session", id: "ordinary", cwd: root });
	await writeFile(allowed, normal.padEnd(64 * 1024, " ") + "\n");
	await expect(readSessionOwnershipMarker(allowed, "ordinary")).resolves.toBeNull();
});

test("canonical native title slots precede ordinary and transferred session identity headers", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-title-slot-"));
	roots.push(root);
	const sessions = join(root, "sessions");
	await mkdir(sessions);
	const titleSlot = serializeTitleSlot({ title: "Scoped scratch session", updatedAt: "2026-11-01T00:00:00.000Z" });

	const ordinary = join(sessions, "ordinary.jsonl");
	await writeFile(ordinary, titleSlot + JSON.stringify({ type: "session", id: "ordinary", cwd: root }) + "\n");
	await expect(readSessionOwnershipMarker(ordinary, "ordinary")).resolves.toBeNull();

	const transferred = join(sessions, "transfer.jsonl");
	await writeFile(
		transferred,
		titleSlot + JSON.stringify({ type: "session", id: "transfer", cwd: root, checkpointHandoff: identity }) + "\n",
	);
	await writeFile(join(root, "recovery.json"), JSON.stringify({ sessionId: "transfer", checkpointTransfer: true }));
	const markerPath = join(sessions, "checkpoint-ownership.json");
	await writeFile(markerPath, JSON.stringify(marker));
	await expect(readSessionOwnershipMarker(transferred, "transfer")).resolves.toEqual({ path: markerPath, marker });
});

test("title-prefixed native journals reject malformed slots and forged later headers", async () => {
	const root = await mkdtemp(join(tmpdir(), "session-ownership-title-invalid-"));
	roots.push(root);
	const titleSlot = serializeTitleSlot({ title: "Scratch", updatedAt: "2026-11-01T00:00:00.000Z" });
	const header = JSON.stringify({ type: "session", id: "ordinary", cwd: root }) + "\n";

	const malformed = join(root, "malformed-title.jsonl");
	const invalidSlot = JSON.stringify({ type: "title", v: 1, title: "Bad", updatedAt: "now", pad: 123 });
	await writeFile(malformed, invalidSlot.padEnd(255, " ") + "\n" + header);
	await expect(readSessionOwnershipMarker(malformed, "ordinary")).rejects.toThrow(/Native session header/);

	const repeated = join(root, "repeated-title.jsonl");
	await writeFile(repeated, titleSlot + titleSlot + header);
	await expect(readSessionOwnershipMarker(repeated, "ordinary")).rejects.toThrow(/Native session header/);

	const forged = join(root, "forged-title-follow-up.jsonl");
	await writeFile(forged, titleSlot + JSON.stringify({ type: "message", id: "fake" }) + "\n" + header);
	await expect(readSessionOwnershipMarker(forged, "ordinary")).rejects.toThrow(/Native session header/);

	const truncated = join(root, "truncated-title-header.jsonl");
	await writeFile(truncated, titleSlot + '{"type":"session","id":"ordinary","cwd":');
	await expect(readSessionOwnershipMarker(truncated, "ordinary")).rejects.toThrow(/Native session header/);
});
