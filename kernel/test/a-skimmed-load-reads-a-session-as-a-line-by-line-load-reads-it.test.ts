import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { KEEP_NOTHING_ENTRY_ID } from "@veyyon/agent-core/compaction/entries";
import { coldFieldsOf, coldToolCallCount } from "@veyyon/kernel/session/session-cold-payloads";
import { CURRENT_SESSION_VERSION, type FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFileStream, type ParsedSessionContent } from "@veyyon/kernel/session/session-loader";
import { serializeTitleSlot } from "@veyyon/kernel/session/session-title-slot";
import * as natives from "@veyyon/natives";
import { TempDir } from "@veyyon/utils";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";

/**
 * WHY: a streamed load that moves compacted history to disk parses the skim of each line
 * (`skimSessionFile`) instead of the line: the skim copies an entry's small values and puts an empty
 * placeholder where each value the load moves sits, with masks naming the moved members, the
 * `toolCall` count of moved assistant content, and the usage of a `task` result's moved details. The
 * load makes the entry cold from that record, re-reads every projected entry that stayed in memory,
 * parses itself every line the skim hands back, and skims again from where each skim ends. A record
 * kept from a skim that disagrees with the line puts a wrong value in the session with no error: a
 * placeholder in an entry that stayed in memory, a moved field listed under the wrong object, a
 * usage total missing a subagent's spend, an entry the line-by-line load drops for its shape, a line
 * skipped past the skim's end, or a line skipped or repeated where one skim ends and the next starts.
 *
 * The class this closes: over generated sessions holding every entry kind the load treats apart
 * (message roles, task results with and without usage, record-only and branch-settings entries,
 * compactions, strings around the move threshold in every UTF-16 width, escapes, blob references,
 * lines the skim hands back, malformed and wrong-shape lines, a blank line, an unterminated last
 * line, an older header, a title slot), the skimmed load holds the same cold layouts, resident
 * values, tool-call counts, usage totals, title slot and record layout as the line-by-line load, and
 * every entry reads back to the same value, whether one skim covers the file or one skim each block
 * of it. A skim whose output disagrees with the file, or that fails, falls back to the line-by-line
 * load and says so.
 *
 * What it does NOT catch: a skim whose resident values differ from the line's while the lengths
 * and masks agree; the load trusts the skim's copies, and the skim crate's own suite pins them. It
 * bounds the bytes the load reads from the file in one turn of the event loop, not the time a turn
 * takes or the memory the load holds.
 */

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** The skim as the addon exports it, for a test that alters what it reports. */
const realSkim = natives.skimSessionFile;

/** `readSync` as `node:fs` exports it, for a test that counts what the load reads. */
const realReadSync = fs.readSync;

/** Messages a fallback logs, by the load that skimmed. */
const SKIM_FALLBACKS = [
	"Session skim failed; parsing every line",
	"Session skim output did not parse; parsing every line",
	"Session skim reported no line; parsing every line",
	"Session skim ended off its last line; parsing every line",
	"A session line disagreed with its skim; parsing every line",
];

afterEach(() => {
	vi.restoreAllMocks();
});

/** A deterministic generator, so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Characters of every UTF-8 width and UTF-16 length, and each a JSON writer escapes. */
const CHARACTERS = ["x", "y", "é", "€", "😀", "\n", '"', "\\", "\u0001", "\u2028", "\ud800", "/", " "];

/**
 * Text near the move threshold, short of it, past it, or past the 64 KiB a read of a line the
 * load parses itself asks for, in UTF-16 code units.
 */
function text(random: () => number, label: string): string {
	const roll = random();
	const units =
		roll < 0.3
			? 250 + Math.floor(random() * 12)
			: roll < 0.5
				? Math.floor(random() * 40)
				: roll < 0.99
					? 400 + Math.floor(random() * 2400)
					: 70_000 + Math.floor(random() * 10_000);
	let out = label;
	while (out.length < units) out += CHARACTERS[Math.floor(random() * CHARACTERS.length)]!;
	return out;
}

function usage(random: () => number): Record<string, unknown> {
	const input = Math.floor(random() * 5000);
	const output = Math.floor(random() * 900);
	const cacheRead = Math.floor(random() * 3000);
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: input / 1e6, output: output / 1e6, cacheRead: 0, cacheWrite: 0, total: (input + output) / 1e6 },
	};
}

function blobRef(random: () => number): string {
	const prefix = random() < 0.5 ? "blob:sha256:" : "blobtext:sha256:";
	return `${prefix}${Math.floor(random() * 1e9)
		.toString(16)
		.padStart(64, "0")}`;
}

function assistantContent(random: () => number, id: string): unknown[] {
	const blocks: unknown[] = [];
	const count = Math.floor(random() * 4);
	for (let i = 0; i < count; i++) {
		const roll = random();
		if (roll < 0.4)
			blocks.push({ type: "toolCall", id: `${id}-c${i}`, name: "read", arguments: { path: text(random, "p") } });
		else if (roll < 0.7) blocks.push({ type: "text", text: text(random, "t") });
		else blocks.push({ type: "thinking", thinking: text(random, "k"), thinkingSignature: "sig" });
	}
	return blocks;
}

function taskDetails(random: () => number): unknown {
	const roll = random();
	if (roll < 0.4) return { agents: [text(random, "agent")], usage: usage(random) };
	if (roll < 0.55) return { agents: [text(random, "agent")], usage: null };
	if (roll < 0.65) return { agents: [text(random, "agent")] };
	if (roll < 0.75) return [text(random, "detail")];
	return { usage: usage(random) };
}

/**
 * The line of one record, written the way a session writer writes it or by hand. A `damaged`
 * session also holds a record of the wrong shape.
 */
function record(
	random: () => number,
	id: string,
	parentId: string | null,
	ids: readonly string[],
	damaged: boolean,
): string {
	const base = { id, parentId, timestamp: TIMESTAMP };
	const roll = random();
	if (roll < 0.22) {
		const content =
			random() < 0.7 ? text(random, "u") : [{ type: "image", data: blobRef(random), mimeType: "image/png" }];
		return JSON.stringify({ type: "message", ...base, message: { role: "user", content, timestamp: 1 } });
	}
	if (roll < 0.45) {
		return JSON.stringify({
			type: "message",
			...base,
			message: {
				role: "assistant",
				content: assistantContent(random, id),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "m",
				usage: usage(random),
				stopReason: random() < 0.5 ? "stop" : text(random, "s"),
				timestamp: 2,
			},
		});
	}
	if (roll < 0.65) {
		const toolName = random() < 0.6 ? "task" : "read";
		return JSON.stringify({
			type: "message",
			...base,
			message: {
				role: "toolResult",
				toolCallId: `${id}-r`,
				toolName,
				content: [{ type: "text", text: text(random, "out") }],
				details: toolName === "task" ? taskDetails(random) : { path: text(random, "d") },
				isError: false,
				timestamp: 3,
			},
		});
	}
	if (roll < 0.72) {
		return JSON.stringify({
			type: "custom",
			...base,
			customType: "note",
			data: { a: text(random, "c"), n: [1, { b: 2 }] },
		});
	}
	if (roll < 0.76) {
		return JSON.stringify({
			type: "session_init",
			...base,
			systemPrompt: text(random, "sys"),
			task: blobRef(random),
			tools: ["read"],
		});
	}
	if (roll < 0.8) {
		return JSON.stringify({ type: "model_change", ...base, model: "anthropic/m", note: text(random, "why") });
	}
	if (roll < 0.86) {
		// Written with spaces between tokens: strict JSON the skim reads past.
		return JSON.stringify(
			{ type: "custom", ...base, customType: "spaced", data: { a: text(random, "sp") } },
			null,
			1,
		).replace(/\n */g, " ");
	}
	const big = "z".repeat(1200);
	const parent = JSON.stringify(parentId);
	const hand = [
		// An escaped key, a repeated key and an integer-like key: the skim hands each line back.
		`{"type":"custom","id":"${id}","parentId":${parent},"timestamp":"${TIMESTAMP}","d\\u0061ta":{"a":"${big}"}}`,
		`{"type":"custom","id":"${id}","parentId":${parent},"timestamp":"${TIMESTAMP}","data":{"a":1},"data":"${big}"}`,
		`{"type":"custom","id":"${id}","parentId":${parent},"timestamp":"${TIMESTAMP}","data":"${big}","7":{"a":1}}`,
		// A type that only starts with a kept-whole one.
		`{"type":"compactionx","id":"${id}","parentId":${parent},"timestamp":"${TIMESTAMP}","data":"${big}"}`,
		// A compaction with its type escaped.
		`{"type":"compacti\\u006fn","id":"${id}","parentId":${parent},"timestamp":"${TIMESTAMP}","summary":"${big}","firstKeptEntryId":${JSON.stringify(ids[0] ?? KEEP_NOTHING_ENTRY_ID)},"tokensBefore":1}`,
	];
	if (damaged) {
		// An assistant message with no usage: the shape check drops it, from its skim or its line.
		hand.push(
			`{"type":"message","id":"${id}","parentId":${parent},"timestamp":"${TIMESTAMP}","message":{"role":"assistant","content":[{"type":"text","text":"${big}"}]}}`,
		);
	}
	return hand[Math.floor(random() * hand.length)]!;
}

interface Generated {
	text: string;
	/** Whether the file starts with a title slot. */
	titled: boolean;
	/** Whether the header names the current version, so the load moves history. */
	current: boolean;
	/** Whether the file holds lines the load drops. */
	damaged: boolean;
}

/**
 * A session file of `count` records off `seed`, compactions among them. One in ten files an older
 * version wrote, unless `current`.
 */
function generate(seed: number, count: number, cwd: string, current = false): Generated {
	const random = mulberry32(seed);
	const titled = random() < 0.5;
	const damaged = random() < 0.5;
	const version = !current && random() < 0.1 ? CURRENT_SESSION_VERSION - 1 : CURRENT_SESSION_VERSION;
	const lines: string[] = [JSON.stringify({ type: "session", version, id: `s${seed}`, timestamp: TIMESTAMP, cwd })];
	const ids: string[] = [];
	const parentOf = new Map<string, string | null>();
	for (let i = 0; i < count; i++) {
		const id = `s${seed}-r${i}`;
		const parentId =
			ids.length === 0 ? null : random() < 0.75 ? ids.at(-1)! : ids[Math.floor(random() * ids.length)]!;
		const roll = random();
		if (roll < 0.03 && damaged) {
			lines.push(`{"type":"message","id":"${id}","message":{"role":`);
			continue;
		}
		if (roll < 0.05) {
			lines.push("");
			continue;
		}
		parentOf.set(id, parentId);
		ids.push(id);
		if (roll < 0.17 && ids.length > 3) {
			const branch: string[] = [];
			for (let at = parentId; at !== null; at = parentOf.get(at) ?? null) branch.push(at);
			const firstKeptEntryId =
				random() < 0.25 ? KEEP_NOTHING_ENTRY_ID : branch[Math.floor(random() * branch.length)];
			const compaction: Record<string, unknown> = {
				type: "compaction",
				id,
				parentId,
				timestamp: TIMESTAMP,
				summary: text(random, "summary"),
				firstKeptEntryId,
				tokensBefore: 1,
			};
			if (random() < 0.5) compaction.preserveData = { notes: text(random, "keep") };
			lines.push(JSON.stringify(compaction));
			continue;
		}
		lines.push(record(random, id, parentId, ids, damaged));
	}
	let body = lines.join("\n");
	// A last line with no line feed, which the load reads past the skim's end.
	if (random() >= 0.3) body += "\n";
	const slot = titled ? serializeTitleSlot({ title: `title ${seed}`, updatedAt: TIMESTAMP }) : "";
	return { text: slot + body, titled, current: version === CURRENT_SESSION_VERSION, damaged };
}

/** The resident fields of `target`, skipping the ones a cold entry keeps behind accessors. */
function residentView(target: Record<string, unknown>, cold: readonly string[] | undefined): Record<string, unknown> {
	const view: Record<string, unknown> = {};
	for (const key of Object.keys(target)) if (cold === undefined || !cold.includes(key)) view[key] = target[key];
	return view;
}

/**
 * What the load holds for each entry before any is read back: the moved fields of the entry and
 * of its message, the moved content's tool calls, and every resident value in key order.
 */
function heldBeforeReadBack(entries: readonly FileEntry[]): string[] {
	return entries.map(entry => {
		const record = entry as unknown as Record<string, unknown>;
		const cold = coldFieldsOf(record);
		const resident = residentView(record, cold);
		let messageCold: readonly string[] | undefined;
		// A cold entry's message getter returns the stand-in without reading the line.
		if (cold !== undefined && isRecord(resident.message)) {
			messageCold = coldFieldsOf(resident.message);
			resident.message = residentView(resident.message, messageCold);
		}
		const toolCalls = entry.type === "session" ? undefined : coldToolCallCount(entry);
		return JSON.stringify({ cold, messageCold, toolCalls, resident });
	});
}

interface Observed {
	held: string[];
	readBack: string[];
	usage: unknown;
	titleSlot: unknown;
	layout: unknown;
	moved: number;
	fallbacks: string[];
}

/** Load `file` moving compacted history, and read every entry back. */
async function observe(file: string): Promise<Observed> {
	const warn = spyOn(logger, "warn");
	let loaded: ParsedSessionContent;
	let fallbacks: string[];
	try {
		loaded = await loadEntriesFromFileStream(file, { coolCompactedHistory: true });
	} finally {
		// Restoring the spy clears its calls.
		fallbacks = warn.mock.calls.map(call => call[0]).filter(message => SKIM_FALLBACKS.includes(message));
		warn.mockRestore();
	}
	const held = heldBeforeReadBack(loaded.entries);
	const moved = loaded.entries.filter(entry => coldFieldsOf(entry) !== undefined).length;
	return {
		held,
		readBack: loaded.entries.map(entry => JSON.stringify(entry)),
		usage: loaded.cold?.usage,
		titleSlot: loaded.titleSlot,
		layout: loaded.layout,
		moved,
		fallbacks,
	};
}

/**
 * {@link observe} with the skim failing, so the load parses every line. The skim throws before it
 * returns a promise, as the addon does on an argument it rejects or a descriptor it cannot duplicate.
 */
async function observeLineByLine(file: string): Promise<Observed> {
	const skim = spyOn(natives, "skimSessionFile").mockImplementation(() => {
		throw new Error("skim disabled for the line-by-line arm");
	});
	let observed: Observed;
	try {
		observed = await observe(file);
	} finally {
		skim.mockRestore();
	}
	expect(observed.fallbacks).toEqual(["Session skim failed; parsing every line"]);
	return observed;
}

/** What the two loads must agree on. */
function comparable(observed: Observed): Omit<Observed, "fallbacks"> {
	const { fallbacks: _fallbacks, ...rest } = observed;
	return rest;
}

/** A `read` result line holding `text`. */
function resultLine(id: string, parentId: string | null, text: string): string {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: TIMESTAMP,
		message: {
			role: "toolResult",
			toolCallId: `c${id}`,
			toolName: "read",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		},
	});
}

/** A current session header line. */
function headerLine(cwd: string): string {
	return JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "s", timestamp: TIMESTAMP, cwd });
}

/**
 * The most bytes a load of `file` that moves compacted history reads with `readSync` in one turn of
 * the event loop, the bytes it reads in all, and the skim fallbacks it logs.
 */
async function readsPerTurn(file: string): Promise<{ largest: number; total: number; fallbacks: string[] }> {
	let sinceTurn = 0;
	let largest = 0;
	let total = 0;
	const read = spyOn(fs, "readSync").mockImplementation(((...args: unknown[]) => {
		const bytes = Reflect.apply(realReadSync, fs, args) as number;
		sinceTurn += bytes;
		total += bytes;
		largest = Math.max(largest, sinceTurn);
		return bytes;
	}) as typeof fs.readSync);
	let loading = true;
	const turn = () => {
		sinceTurn = 0;
		if (loading) setImmediate(turn);
	};
	setImmediate(turn);
	const warn = spyOn(logger, "warn");
	let fallbacks: string[];
	try {
		await loadEntriesFromFileStream(file, { coolCompactedHistory: true });
	} finally {
		loading = false;
		read.mockRestore();
		fallbacks = warn.mock.calls.map(call => call[0]).filter(message => SKIM_FALLBACKS.includes(message));
		warn.mockRestore();
	}
	return { largest, total, fallbacks };
}

/** Sessions whose skimmed load reads megabytes from the file, by what it reads. */
const READ_HEAVY: { reads: string; lines: (cwd: string) => string[] }[] = [
	{
		reads: "compactions the skim hands back",
		lines: cwd => {
			const lines = [headerLine(cwd)];
			let parentId: string | null = null;
			for (let i = 0; i < 10; i++) {
				lines.push(resultLine(`r${i}`, parentId, "r".repeat(2000)));
				lines.push(
					JSON.stringify({
						type: "compaction",
						id: `k${i}`,
						parentId: `r${i}`,
						timestamp: TIMESTAMP,
						summary: "s".repeat(600_000),
						firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
						tokensBefore: 1,
					}),
				);
				parentId = `k${i}`;
			}
			return lines;
		},
	},
	{
		reads: "projected results that stay in memory",
		lines: cwd => [
			headerLine(cwd),
			...Array.from({ length: 50 }, (_, i) =>
				resultLine(`r${i}`, i === 0 ? null : `r${i - 1}`, "r".repeat(100_000)),
			),
		],
	},
];

describe.skipIf(process.platform === "win32")("a skimmed load reads a session as a line-by-line load reads it", () => {
	it("holds and reads back the same entries over generated sessions", async () => {
		using temp = TempDir.createSync("@kernel-skimmed-load-");
		let moved = 0;
		let laidOut = 0;
		let aged = 0;
		for (let seed = 1; seed <= 40; seed++) {
			const generated = generate(seed, 70, temp.path());
			const file = path.join(temp.path(), `s${seed}.jsonl`);
			fs.writeFileSync(file, generated.text);

			const lineByLine = await observeLineByLine(file);
			const skimmed = await observe(file);
			expect({ seed, fallbacks: skimmed.fallbacks }).toEqual({ seed, fallbacks: [] });
			expect({ seed, ...comparable(skimmed) }).toEqual({ seed, ...comparable(lineByLine) });
			// A file behind a title slot that lost no record keeps its layout.
			if (generated.titled && !generated.damaged) {
				expect({ seed, laidOut: skimmed.layout !== undefined }).toEqual({ seed, laidOut: true });
				laidOut += 1;
			}
			if (!generated.current) aged += 1;
			moved += skimmed.moved;
		}
		// The sweep moves history, keeps layouts, and reads a file an older version wrote.
		expect(moved).toBeGreaterThan(40 * 5);
		expect(laidOut).toBeGreaterThan(5);
		expect(aged).toBeGreaterThan(0);
	});

	it("totals the usage of a task result whose details moved from the skim", async () => {
		using temp = TempDir.createSync("@kernel-skimmed-task-usage-");
		const file = path.join(temp.path(), "task.jsonl");
		const random = mulberry32(7);
		const childUsage = usage(random);
		const lines = [
			headerLine(temp.path()),
			JSON.stringify({
				type: "message",
				id: "a",
				parentId: null,
				timestamp: TIMESTAMP,
				message: {
					role: "toolResult",
					toolCallId: "c",
					toolName: "task",
					content: [{ type: "text", text: "r".repeat(2000) }],
					details: { agents: ["x".repeat(600)], usage: childUsage },
					isError: false,
					timestamp: 1,
				},
			}),
			JSON.stringify({
				type: "compaction",
				id: "b",
				parentId: "a",
				timestamp: TIMESTAMP,
				summary: "summary",
				firstKeptEntryId: KEEP_NOTHING_ENTRY_ID,
				tokensBefore: 1,
			}),
		];
		fs.writeFileSync(file, `${lines.join("\n")}\n`);
		const lineByLine = await observeLineByLine(file);
		const skimmed = await observe(file);
		expect(skimmed.fallbacks).toEqual([]);
		// The result moved with its details, and the totals still hold the child's spend.
		expect(skimmed.moved).toBe(1);
		expect(skimmed.usage).toMatchObject({ input: childUsage.input, output: childUsage.output });
		expect(comparable(skimmed)).toEqual(comparable(lineByLine));
	});

	it.each(READ_HEAVY)("yields a turn of the event loop per mebibyte it reads of $reads", async heavy => {
		using temp = TempDir.createSync("@kernel-skimmed-yields-");
		const file = path.join(temp.path(), "heavy.jsonl");
		fs.writeFileSync(file, `${heavy.lines(temp.path()).join("\n")}\n`);
		const reads = await readsPerTurn(file);
		expect(reads.fallbacks).toEqual([]);
		// The load reads megabytes, and no turn reads more than a mebibyte and the line that crosses it.
		expect(reads.total).toBeGreaterThan(3 << 20);
		expect(reads.largest).toBeLessThanOrEqual(2 << 20);
	});

	it.each(READ_HEAVY)("reads $reads skimmed a block at a time as the line-by-line load reads them", async heavy => {
		using temp = TempDir.createSync("@kernel-skimmed-blocks-");
		const file = path.join(temp.path(), "heavy.jsonl");
		fs.writeFileSync(file, `${heavy.lines(temp.path()).join("\n")}\n`);
		const lineByLine = await observeLineByLine(file);
		let skims = 0;
		const skim = spyOn(natives, "skimSessionFile").mockImplementation(async (fd, start, rules) => {
			skims += 1;
			return realSkim(fd, start, { ...rules, outputBytes: 0 });
		});
		let blockwise: Observed;
		try {
			blockwise = await observe(file);
		} finally {
			skim.mockRestore();
		}
		expect(blockwise.fallbacks).toEqual([]);
		// A skim per block of the file, and a last that reports no line.
		expect(skims).toBeGreaterThan(2);
		expect(comparable(blockwise)).toEqual(comparable(lineByLine));
	});

	/** Ways a skim can disagree with the file it read, each with the fallback it must take. */
	const DISAGREEMENTS: {
		name: string;
		alter: (lines: Buffer, end: number) => { lines: Buffer; end: number };
		fallback: string;
	}[] = [
		{
			name: "an end past its last line",
			alter: (lines, end) => ({ lines, end: end + 1 }),
			fallback: "Session skim ended off its last line; parsing every line",
		},
		{
			name: "a last line missing",
			alter: (lines, end) => ({ lines: lines.subarray(0, lines.lastIndexOf(0x0a, lines.length - 2) + 1), end }),
			fallback: "Session skim ended off its last line; parsing every line",
		},
		{
			name: "output that is not JSON",
			alter: (lines, end) => ({ lines: Buffer.concat([lines.subarray(0, 40), Buffer.from("{\n")]), end }),
			fallback: "Session skim output did not parse; parsing every line",
		},
		{
			name: "a value that reports no line",
			alter: (lines, end) => ({ lines: Buffer.concat([Buffer.from('"x"\n'), lines]), end }),
			fallback: "Session skim reported no line; parsing every line",
		},
	];

	it.each(DISAGREEMENTS)("falls back to the line-by-line load on a skim with $name", async disagreement => {
		using temp = TempDir.createSync("@kernel-skimmed-disagreement-");
		for (let seed = 101; seed <= 106; seed++) {
			const generated = generate(seed, 50, temp.path(), true);
			const file = path.join(temp.path(), `s${seed}.jsonl`);
			fs.writeFileSync(file, generated.text);
			const lineByLine = await observeLineByLine(file);
			const skim = spyOn(natives, "skimSessionFile").mockImplementation(async (fd, start, rules) => {
				const real = await realSkim(fd, start, rules);
				return disagreement.alter(real.lines, real.end);
			});
			let altered: Observed;
			try {
				altered = await observe(file);
			} finally {
				skim.mockRestore();
			}
			expect({ seed, fallbacks: altered.fallbacks }).toEqual({ seed, fallbacks: [disagreement.fallback] });
			expect({ seed, ...comparable(altered) }).toEqual({ seed, ...comparable(lineByLine) });
		}
	});
});
