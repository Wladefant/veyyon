/** WHY: IRC wake turns bypass the initial executor result. A second yield disappeared behind immutable A.
 * This exercises the real durable outbox and session store. It does not prove provider behavior or model instruction compliance. */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { IrcContinuationOutbox } from "../src/session/runtime/irc-inbox";

const resources: TempDir[] = [];
afterEach(() => { for (const resource of resources.splice(0)) resource.removeSync(); });
function store(): SessionManager {
	const temp = TempDir.createSync("native-continuation-");
	resources.push(temp);
	return SessionManager.create(temp.path(), temp.path());
}

describe("retained agent result delivery", () => {
	it("keeps A immutable and gives B a separate replay-stable handle", async () => {
		const session = store();
		const dir = session.getArtifactsDir()!;
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "worker.md"), "A");
		const outbox = new IrcContinuationOutbox(session);
		expect(outbox.begin("resume-1")).toBe(true);
		expect(outbox.begin("resume-1")).toBe(false);
		const [result, raced] = await Promise.all([
			outbox.complete("worker", "owner", "resume-1", "B"),
			outbox.complete("worker", "owner", "resume-1", "B"),
		]);
		expect(raced).toEqual(result);
		expect(session.getEntries().filter(entry => entry.type === "custom" && entry.customType === "irc:continuation-result")).toHaveLength(1);
		expect(result.handle).not.toBe("agent://worker");
		expect(await fs.readFile(path.join(dir, "worker.md"), "utf8")).toBe("A");
		expect(await fs.readFile(path.join(dir, `${result.handle.slice("agent://".length)}.md`), "utf8")).toBe("B");
		await session.flush();
		const reopened = await SessionManager.open(session.getSessionFile()!);
		const replay = new IrcContinuationOutbox(reopened);
		expect(await replay.complete("worker", "owner", "resume-1", "B")).toEqual(result);
		await replay.flush(async () => true);
		expect(await replay.complete("worker", "owner", "resume-1", "ignored duplicate output")).toEqual(result);
		expect(reopened.getEntries().filter(entry => entry.type === "custom" && entry.customType === "irc:continuation-result")).toHaveLength(1);
	});
	it("confines unsafe task names to portable continuation artifacts without changing replay identity", async () => {
		const session = store();
		const dir = session.getArtifactsDir()!;
		const outbox = new IrcContinuationOutbox(session);
		const cases = ["../outside", String.raw`..\\outside`, "CON", "com1", "invalid:name", "🔒worker", "a".repeat(100)];
		for (const [index, agentId] of cases.entries()) {
			const phaseId = `unsafe-phase-${index}`;
			const output = `result-${index}`;
			const result = await outbox.complete(agentId, "owner", phaseId, output);
			const stem = result.handle.slice("agent://".length);
			expect(stem).toMatch(/^agent-[a-f0-9]{64}\.phase-[a-f0-9]{64}$/);
			expect(path.basename(`${stem}.md`)).toBe(`${stem}.md`);
			expect(path.dirname(path.join(dir, `${stem}.md`))).toBe(dir);
			expect(await fs.readFile(path.join(dir, `${stem}.md`), "utf8")).toBe(output);
			expect(result.agentId).toBe(agentId);
			if (index === 0) {
				// With a raw "../outside" stem the original writer created this file
				// outside the artifacts directory.
				const escaped = path.resolve(dir, "..", `outside.phase-${result.id}.md`);
				await expect(fs.access(escaped)).rejects.toThrow();
			}
		}
		await session.flush();
		const reopened = await SessionManager.open(session.getSessionFile()!);
		const replay = new IrcContinuationOutbox(reopened);
		const original = outbox.pending()[0]!;
		expect(await replay.complete("../outside", "owner", "unsafe-phase-0", "changed retry text")).toEqual(original);
		expect(await fs.readFile(path.join(dir, `${original.handle.slice("agent://".length)}.md`), "utf8")).toBe("result-0");
	});

	it("serializes concurrent delivery and attempts each failed result once per flush", async () => {
		const session = store();
		const outbox = new IrcContinuationOutbox(session);
		const first = await outbox.complete("worker", "owner", "resume-1", "B");
		let failures = 0;
		await outbox.flush(async completion => {
			expect(completion.id).toBe(first.id);
			failures++;
			return false;
		});
		expect(failures).toBe(1);
		await session.flush();
		const reopened = await SessionManager.open(session.getSessionFile()!);
		const replay = new IrcContinuationOutbox(reopened);
		const gate = Promise.withResolvers<boolean>();
		let calls = 0;
		const deliver = async () => { calls++; return await gate.promise; };
		const one = replay.flush(deliver);
		const two = replay.flush(deliver);
		expect(calls).toBe(1);
		gate.resolve(true);
		await Promise.all([one, two]);
		await reopened.flush();
		const acknowledged = await SessionManager.open(reopened.getSessionFile()!);
		expect(new IrcContinuationOutbox(acknowledged).pending()).toEqual([]);
		await replay.flush(deliver);
		expect(calls).toBe(1);
	});
	it("delivers a phase saved while another delivery is awaiting its durable receipt", async () => {
		const session = store();
		const outbox = new IrcContinuationOutbox(session);
		const first = await outbox.complete("worker", "owner", "resume-1", "B");
		const gate = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const active = outbox.flush(async completion => {
			delivered.push(completion.id);
			if (completion.id === first.id) await gate.promise;
			return true;
		});
		const second = await outbox.complete("worker", "owner", "resume-2", "C");
		const raced = outbox.flush(async () => { throw new Error("Concurrent flush must join the active delivery"); });
		gate.resolve();
		await Promise.all([active, raced]);
		expect(delivered).toEqual([first.id, second.id]);
		expect(outbox.pending()).toEqual([]);
	});
	it("recovers only versioned native phase input after reopening the actual journal", async () => {
		const session = store();
		const record = {
			role: "custom" as const, customType: "irc:incoming", content: "Resume phase B",
			display: true, timestamp: 1, attribution: "agent" as const,
			details: { id: "resume-1", from: "owner", source: "agent", relation: "parent" },
		};
		const outbox = new IrcContinuationOutbox(session);
		outbox.begin("resume-1", record);
		session.appendCustomEntry("irc:continuation-phase", { version: 0, phaseId: "legacy", record });
		session.appendCustomEntry("irc:continuation-result", {
			version: 0, id: "legacy", agentId: "worker", parentId: "owner", phaseId: "legacy",
			handle: "agent://legacy", output: "must not be served",
		});
		session.flushSync();
		await session.ensureOnDisk();
		await session.flush();
		const restored = new IrcContinuationOutbox(await SessionManager.open(session.getSessionFile()!));
		expect(restored.unfinished()).toEqual([record]);
		expect(restored.pending()).toEqual([]);
	});
});
