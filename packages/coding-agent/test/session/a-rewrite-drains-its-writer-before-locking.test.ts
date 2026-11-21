// A rewrite that queues on the journal lock while the manager's own appends wait behind an
// earlier holder must not wait for those appends while it holds its place in the queue.
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { useTempDirs } from "../helpers/temp-dirs";

const temp = useTempDirs();
const STALLED = Symbol("stalled");
const WATCHDOG_MS = 2000;

// Exception to the no-test-timers rule: a stalled promise emits no event to await and no fake clock
// can advance to it. The watchdog fires only when the deadlock is present; success clears it.
function bounded<T>(work: Promise<T>): Promise<T | typeof STALLED> {
	const watchdog = Promise.withResolvers<typeof STALLED>();
	const timer = setTimeout(() => watchdog.resolve(STALLED), WATCHDOG_MS);
	return Promise.race([work, watchdog.promise]).finally(() => clearTimeout(timer));
}

it("drains the manager's writer before a rewrite queues on the journal lock", async () => {
	const cwd = temp("rewrite-drain-");
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	manager.appendMessage(createAssistantMessage("before-drain"));
	await manager.flush();
	const journal = manager.getSessionFile()!;

	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const holder = new FileSessionStorage().withJournalLock(journal, async () => {
		entered.resolve();
		await release.promise;
	});
	try {
		await Promise.race([entered.promise, holder]);
		// Both appends go through the manager-owned writer and queue behind the external holder.
		manager.appendMessage(createAssistantMessage("queued-one"));
		manager.appendMessage(createAssistantMessage("queued-two"));
		// The rewrite is requested while those appends are still pending.
		const rewrite = manager.rewriteEntries();
		release.resolve();
		await holder;

		const outcome = await bounded(rewrite);
		expect(outcome).not.toBe(STALLED);

		const body = fs.readFileSync(journal, "utf8");
		const positions = ["before-drain", "queued-one", "queued-two"].map(text => {
			expect(body.split(text).length - 1).toBe(1);
			return body.indexOf(text);
		});
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);

		const reacquired = await bounded(new FileSessionStorage().withJournalLock(journal, async () => "held"));
		expect(reacquired).toBe("held");
	} finally {
		release.resolve();
		await holder;
		await bounded(manager.close());
	}
});
