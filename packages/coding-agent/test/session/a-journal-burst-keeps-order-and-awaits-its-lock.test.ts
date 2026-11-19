// Replays the lock-owner flush in the UI append path and shutdown during an
// async hold. The call count measures JS filesystem calls, not disk latency.
import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExitRecord } from "@veyyon/coding-agent/session/runtime/exit-record";
import { SESSION_EXIT_CUSTOM_TYPE } from "@veyyon/kernel/session/exit-diagnostics";
import { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { useTempDirs } from "../helpers/temp-dirs";

const temp = useTempDirs();

it("acquires one journal lock for a synchronous burst and still syncs the journal on request", async () => {
	const journal = path.join(temp("journal-batch-"), "session.jsonl");
	const storage = new FileSessionStorage();
	const writer = storage.openWriter(journal);
	const sync = spyOn(fs, "fsyncSync");
	try {
		const lines = [
			JSON.stringify({ type: "session", id: "test-session" }),
			...Array.from({ length: 32 }, (_, i) => JSON.stringify({ type: "custom", id: String(i) })),
		];
		const pending = lines.map(line => writer.append(`${line}\n`));
		expect(fs.readFileSync(journal, "utf8")).toBe(`${lines.join("\n")}\n`);
		await Promise.all(pending);
		expect(sync.mock.calls).toHaveLength(1);
		await writer.sync();
		expect(sync.mock.calls).toHaveLength(2);
		expect(fs.existsSync(`${journal}.lock`)).toBe(false);
		await writer.append('{"type":"custom","id":"next-burst"}\n');
		expect(sync.mock.calls).toHaveLength(3);
		expect(fs.existsSync(`${journal}.lock`)).toBe(false);
	} finally {
		sync.mockRestore();
		await writer.close();
	}
});

it.each(["append", "rewrite"])("releases the first path before a synchronous %s on a second path", async operation => {
	const dir = temp("journal-handoff-");
	const first = path.join(dir, "first.jsonl");
	const second = path.join(dir, "second.jsonl");
	const storage = new FileSessionStorage();
	const writer = storage.openWriter(first);
	const line = '{"type":"session","id":"handoff"}\n';
	try {
		const initial = writer.append(line);
		let next: Promise<void> | undefined;
		if (operation === "append") {
			const other = storage.openWriter(second);
			next = other.append(line).finally(() => other.close());
		} else {
			storage.withJournalLockSync(second, () => {
				expect(fs.existsSync(`${first}.lock`)).toBe(false);
				storage.writeTextSync(second, line);
			});
		}
		expect(fs.existsSync(`${first}.lock`)).toBe(false);
		await initial;
		await next;
		expect(fs.readFileSync(first, "utf8")).toBe(line);
		expect(fs.readFileSync(second, "utf8")).toBe(line);
	} finally {
		await writer.close();
	}
});

it("waits for an async journal hold before reporting dispose complete", async () => {
	const cwd = temp("journal-exit-");
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	manager.appendMessage(createAssistantMessage("before shutdown"));
	await manager.flush();
	const journal = manager.getSessionFile()!;
	const errors: string[] = [];
	manager.setOperatorNotices(
		new OperatorNotices(notice => {
			if (notice.severity === "error") errors.push(notice.text);
		}),
	);
	const record = new ExitRecord({ sessionStore: manager, redact: text => text });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holder = new FileSessionStorage().withJournalLock(journal, async () => {
		entered.resolve();
		await release.promise;
	});
	try {
		await Promise.race([entered.promise, holder]);
		const rewrite = manager.rewriteEntries();
		await new Promise<void>(resolve => setImmediate(resolve));
		let closed = false;
		const close = Promise.resolve(record.close("dispose")).then(() => {
			closed = true;
		});
		try {
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(closed).toBe(false);
		} finally {
			release.resolve();
			await holder;
			await rewrite;
			await close;
		}
		expect(fs.readFileSync(journal, "utf8")).toContain(`"customType":"${SESSION_EXIT_CUSTOM_TYPE}"`);
		expect(errors).toEqual([]);
	} finally {
		release.resolve();
		await holder;
		await manager.close();
	}
});
