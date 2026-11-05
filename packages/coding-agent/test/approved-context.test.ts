import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveRecord, createDraft, validateRecord } from "../examples/extensions/team-context";
import { createGitContextProvider } from "../examples/extensions/team-context-git";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))));

async function repository() {
	const root = await mkdtemp(join(tmpdir(), "approved-context-"));
	dirs.push(root);
	const git = async (...args: string[]) => {
		const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "pipe" });
		const code = await child.exited;
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
	};
	await git("init", "--quiet");
	return { root, git };
}

const scope = { team: "team-stable", repository: "repo-stable" };
const access = { scope, actor: "alice", binding: "checkout:/trusted/repo", allowedPrivacy: ["repository", "team"] as Array<"repository" | "team"> };
function accessFor(root: string, actor = "alice", allowedPrivacy = access.allowedPrivacy) {
	return { ...access, binding: `git:${root}`, actor, allowedPrivacy };
}
function record(body = "approved text", privacy: "repository" | "team" = "team", actor = "alice") {
	const draft = createDraft({
		kind: "note", scope, source: { uri: "session://s/leaf", revision: "source-1", client: "veyyon", session: "s", leaf: "leaf" },
		revision: "r1", body, privacy, author: actor,
	});
	return approveRecord(draft, { ...access, actor }, true, "2026-01-01T00:00:00.000Z");
}

function provider(root: string, authorize: (cwd: string) => Promise<typeof access> = async () => accessFor(root)) {
	return createGitContextProvider({ path: root, authorize });
}

test("stores an approved record and allows a different authorized reader", async () => {
	const { root } = await repository();
	const writerAccess = accessFor(root);
	const readerAccess = accessFor(root, "bob");
	const writer = provider(root);
	const item = record();
	expect(await writer.read(root, writerAccess, "missing")).toBeUndefined();
	const receipt = await writer.publish(root, writerAccess, item);
	expect(receipt.status).toBe("stored");
	expect(receipt.provider.storage).toBe("local");
	expect(receipt.provider.git).toBe("trackable");
	expect(await writer.read(root, writerAccess, item.id)).toEqual(item);
	const readerProvider = provider(root, async () => readerAccess);
	expect(await readerProvider.read(root, readerAccess, item.id)).toEqual(item);
	expect((await readerProvider.list(root, readerAccess)).map(x => x.id)).toEqual([item.id]);
	expect((await readerProvider.search(root, readerAccess, "approved")).map(x => x.body)).toEqual(["approved text"]);
	expect(await readerProvider.read(root, readerAccess, "missing")).toBeUndefined();
	expect((await readerProvider.recentReferences(root, readerAccess)).map(x => x.text)).toEqual(["approved text"]);
	expect((await readerProvider.searchReferences(root, readerAccess, "approved")).map(x => x.text)).toEqual(["approved text"]);
});

test("canonical identity and approval validation ignore object property order", () => {
	const item = record();
	const reordered = {
		...item,
		scope: { repository: item.scope.repository, team: item.scope.team },
		source: {
			leaf: item.source.leaf,
			session: item.source.session,
			client: item.source.client,
			revision: item.source.revision,
			uri: item.source.uri,
		},
	};
	expect(validateRecord(reordered, access)).toEqual(item);
});

test("same-byte retries are duplicates; valid different bytes at one identity conflict", async () => {
	const { root } = await repository();
	const p = provider(root);
	const auth = accessFor(root);
	const first = record();
	expect((await p.publish(root, auth, first)).status).toBe("stored");
	expect((await p.publish(root, auth, first)).status).toBe("duplicate");
	await expect(p.publish(root, auth, record("different valid body"))).rejects.toThrow(/conflict/i);
});

test("rejects actor and scope mismatch, unconfirmed approval, and private approval", async () => {
	const { root } = await repository();
	const p = provider(root);
	const auth = accessFor(root);
	const item = record();
	const unapproved = createDraft({
		kind: "note", scope, source: { uri: "session://unapproved", revision: "s1", client: "veyyon" },
		revision: "r1", body: "must not be exposed", privacy: "team", author: "alice",
	});
	await expect(p.publish(root, auth, unapproved as never)).rejects.toThrow();
	await expect(p.publish(root, { ...auth, actor: "mallory" }, item)).rejects.toThrow();
	await expect(p.publish(root, { ...auth, scope: { ...scope, team: "other" } }, item)).rejects.toThrow();
	await expect(p.publish(root, auth, record("secret", "team", "mallory"))).rejects.toThrow();
	const draft = createDraft({
		kind: "note", scope, source: { uri: "session://private", revision: "s1", client: "veyyon" },
		revision: "r1", body: "private body", privacy: "private", author: "alice",
	});
	expect(() => approveRecord(draft, auth, false)).toThrow(/confirmed/i);
	expect(() => approveRecord(draft, auth, true)).toThrow(/privacy/i);
	expect(await p.list(root, auth)).toEqual([]);
});

test("does not read an approved record outside the reader privacy allowlist", async () => {
	const { root } = await repository();
	const writer = provider(root);
	const writerAccess = accessFor(root);
	const item = record("repository only", "repository");
	await writer.publish(root, writerAccess, item);
	const restricted = accessFor(root, "alice", ["team"]);
	const reader = provider(root, async () => restricted);
	await expect(reader.read(root, restricted, item.id)).rejects.toThrow(/privacy/i);
});

test("rechecks host authorization and rejects a changed binding", async () => {
	const { root } = await repository();
	let current = accessFor(root);
	const original = current;
	const p = provider(root, async () => current);
	const item = record();
	await p.publish(root, original, item);
	current = { ...original, binding: "git:/other/checkout" };
	await expect(p.read(root, original, item.id)).rejects.toThrow(/authorization|binding|changed/i);
});

test("resolve returns a detached immutable access snapshot", async () => {
	const { root } = await repository();
	const callbackAccess = accessFor(root);
	const p = provider(root, async () => callbackAccess);
	const resolved = await p.resolve(root);
	expect(Object.isFrozen(resolved)).toBe(true);
	expect(Object.isFrozen(resolved.scope)).toBe(true);
	expect(Object.isFrozen(resolved.allowedPrivacy)).toBe(true);
	await expect(p.read(root, resolved, "missing")).resolves.toBeUndefined();
	callbackAccess.actor = "mallory";
	await expect(p.read(root, resolved, "missing")).rejects.toThrow(/authorization/i);
});

test("rejects tampered body, approval, scope, and non-approved states before returning text", async () => {
	const { root } = await repository();
	const p = provider(root);
	const auth = accessFor(root);
	const item = record();
	await p.publish(root, auth, item);
	const path = join(root, ".veyyon", "approved-context");
	const [file] = await readdir(path);
	const recordPath = join(path, file);
	const original = await readFile(recordPath, "utf8");
	type StoredRecord = { body: string; approval: { digest: string; state: string }; scope: { team: string } };
	const mutate = [
		(value: StoredRecord) => (value.body = "leaked altered text"),
		(value: StoredRecord) => (value.approval.digest = "0".repeat(64)),
		(value: StoredRecord) => (value.scope.team = "other-team"),
		(value: StoredRecord) => (value.approval.state = "pending"),
		(value: StoredRecord) => (value.approval.state = "revoked"),
	];
	for (const change of mutate) {
		const changed = JSON.parse(original) as StoredRecord;
		change(changed);
		await writeFile(recordPath, JSON.stringify(changed));
		await expect(p.read(root, auth, item.id)).rejects.toThrow();
		await writeFile(recordPath, original);
	}
});

test("rejects symlink escapes and a symlinked duplicate destination", async () => {
	const { root } = await repository();
	const outside = await mkdtemp(join(tmpdir(), "approved-context-outside-"));
	dirs.push(outside);
	const p = provider(root);
	await symlink(outside, join(root, ".veyyon"));
	await expect(p.publish(root, accessFor(root), record())).rejects.toThrow();

	const { root: secondRoot } = await repository();
	const secondProvider = provider(secondRoot);
	const auth = accessFor(secondRoot);
	const item = record();
	await secondProvider.publish(secondRoot, auth, item);
	const directory = join(secondRoot, ".veyyon", "approved-context");
	const [filename] = await readdir(directory);
	const destination = join(directory, filename);
	const externalFile = join(outside, "external.json");
	await writeFile(externalFile, "not a record");
	await unlink(destination);
	await symlink(externalFile, destination);
	await expect(secondProvider.publish(secondRoot, auth, item)).rejects.toThrow(/destination/i);
});
