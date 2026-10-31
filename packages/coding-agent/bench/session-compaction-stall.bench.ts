/**
 * Benchmark: how long a compaction holds the event loop on a long session.
 *
 * Replays what the compaction runtime does once a summary returns: append the compaction, rewrite
 * a kept tool result in place (the tail elision, which republishes the file), move the summarized
 * history out of memory, and build the context. Those steps run back to back with no timer turn
 * between them, as they do in the runtime, so a 1 ms interval timer's longest gap across the chain
 * is how long the terminal stops drawing and reading keys.
 *
 * The synthetic transcript has the shape of a long agent run: tool starts, tool results,
 * assistant turns and progress records in a 2:2:2:1 mix, with a compaction every 440 entries
 * keeping the last 20. The default size, 200,000 lines averaging 2.1 KiB, is that of a
 * 198,874-entry, 410 MiB session.
 *
 * Run: bun packages/coding-agent/bench/session-compaction-stall.bench.ts
 *   SESSION_ENTRIES=200000 ENTRY_BYTES=2860 ROUNDS=5 bun ... to size it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { emptyUsage } from "@veyyon/catalog/models";
import { CURRENT_SESSION_VERSION } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { serializeTitleSlot } from "@veyyon/kernel/session/session-title-slot";

const ENTRIES = Number(process.env.SESSION_ENTRIES ?? "200000");
const ENTRY_BYTES = Number(process.env.ENTRY_BYTES ?? "2860");
const ROUNDS = Number(process.env.ROUNDS ?? "5");
const COMPACTION_EVERY = 440;
const KEEP = 20;

const usage = { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 };

function entryLine(i: number, filler: string): string {
	const id = `e${String(i).padStart(7, "0")}`;
	const parentId = i === 0 ? null : `e${String(i - 1).padStart(7, "0")}`;
	const timestamp = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
	const text = `${id} ${filler}`;
	const base = { type: "", id, parentId, timestamp };
	if (i > KEEP && i % COMPACTION_EVERY === 0) {
		const firstKeptEntryId = `e${String(i - KEEP).padStart(7, "0")}`;
		return JSON.stringify({ ...base, type: "compaction", summary: text, firstKeptEntryId, tokensBefore: 100_000 });
	}
	const toolCallId = `call-${i - (i % 7)}`;
	switch (i % 7) {
		case 0:
		case 3:
			return JSON.stringify({
				...base,
				type: "custom",
				customType: "tool_execution_start",
				data: { toolCallId, toolName: "bash", args: { command: text.slice(0, 600) } },
			});
		case 1:
		case 4:
			return JSON.stringify({
				...base,
				type: "message",
				message: {
					role: "toolResult",
					toolCallId,
					toolName: "bash",
					content: [{ type: "text", text }],
					isError: false,
					timestamp: i,
				},
			});
		case 2:
		case 5:
			return JSON.stringify({
				...base,
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "bench",
					usage,
					stopReason: "stop",
					timestamp: i,
				},
			});
		default:
			return JSON.stringify({
				...base,
				type: "custom",
				customType: "goal_progress",
				data: { note: text.slice(0, 800) },
			});
	}
}

/** A session file laid out as the manager writes one: the title slot, the header, one line per entry. */
function writeSyntheticSession(dir: string): { file: string; bytes: number } {
	const file = path.join(dir, "compaction-stall.jsonl");
	const timestamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
	const filler = "x".repeat(ENTRY_BYTES);
	const fd = fs.openSync(file, "w");
	let bytes = 0;
	const write = (line: string): void => {
		fs.writeSync(fd, line);
		bytes += Buffer.byteLength(line);
	};
	write(serializeTitleSlot({ title: "compaction stall bench", source: "user", updatedAt: timestamp }));
	write(
		`${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "compactionstall00000000000000", timestamp, cwd: dir })}\n`,
	);
	for (let i = 0; i < ENTRIES; i++) write(`${entryLine(i, filler)}\n`);
	fs.closeSync(fd);
	return { file, bytes };
}

// Under the repo's gitignored scratch root, not the system temp dir: at the default size the
// transcript is 410 MiB, which a tmpfs /tmp would charge to memory.
const scratchRoot = path.join(import.meta.dirname, "..", "..", "..", ".scratch");
fs.mkdirSync(scratchRoot, { recursive: true });
const dir = fs.mkdtempSync(path.join(scratchRoot, "session-compaction-stall-"));
const { file, bytes } = writeSyntheticSession(dir);

let last = performance.now();
let longest = 0;
const monitor = setInterval(() => {
	const now = performance.now();
	longest = Math.max(longest, now - last);
	last = now;
}, 1);

const t0 = performance.now();
const manager = await SessionManager.open(file, undefined, undefined, { suppressBreadcrumb: true });
console.log(
	`synthetic session: ${(bytes / 1048576).toFixed(0)} MiB, ${manager.getEntries().length} entries, open ${(performance.now() - t0).toFixed(0)} ms`,
);
manager.buildSessionContext();

const stalls: number[] = [];
const walls: number[] = [];
for (let round = 0; round < ROUNDS; round++) {
	const tail = manager.getEntries().slice(-KEEP);
	const elided = tail.find(entry => entry.type === "message" && entry.message.role === "toolResult");
	if (elided?.type !== "message" || elided.message.role !== "toolResult") {
		throw new Error("the kept tail holds no tool result to elide");
	}
	await sleep(50);
	longest = 0;
	last = performance.now();
	const start = performance.now();
	manager.appendCompaction(`summary ${round} `.repeat(400), `short ${round}`, tail[0]!.id, 256_000, {
		readFiles: [],
		modifiedFiles: [],
	});
	elided.message = { ...elided.message, content: [{ type: "text", text: `[elided ${round}]` }] };
	await manager.rewriteEntries([elided]);
	manager.coolCompactedHistory();
	manager.buildSessionContext();
	const wall = performance.now() - start;
	await sleep(10);
	stalls.push(longest);
	walls.push(wall);
	console.log(
		`round ${round}: chain ${wall.toFixed(1).padStart(6)} ms, longest stall ${longest.toFixed(1).padStart(6)} ms`,
	);
	await manager.flush();
}
clearInterval(monitor);
await manager.close();

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
console.log(`median chain ${median(walls).toFixed(1)} ms, median longest stall ${median(stalls).toFixed(1)} ms`);
fs.rmSync(dir, { recursive: true, force: true });
