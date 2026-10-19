import { describe, expect, it } from "bun:test";
import { REMOTE_COMPACTION_PRESERVE_KEY } from "@veyyon/agent-core/compaction/remote-compaction-entry";
import { ColdEntryPayloads, coldFieldsOf, MIN_COLD_STRING_LENGTH } from "@veyyon/kernel/session/session-cold-payloads";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { isRecord } from "@veyyon/utils/type-guards";

/**
 * WHY: cooling an entry replaces each large field with an accessor and records which fields it
 * replaced, as a key list every entry with the same cooled fields shares. The list is found by
 * walking a trie of field names as the entry's keys are read, and the keys are read with `for...in`
 * filtered by `Object.hasOwn`. A walk that confuses two orders of the same fields, returns the list
 * of a longer path for its prefix, drops a field, or takes an enumerable prototype property for an
 * own field records the wrong fields: a read-back restores fields the entry never had, or leaves a
 * moved field behind an accessor that nothing restores, and the entry serializes differently from
 * its line.
 *
 * The class this closes: over generated entries, message, compaction and other, with fields in
 * random order and each value small, long, an object or null, the cooled fields are exactly the own
 * large fields in key order, each held behind an accessor and every other field held as a value, a
 * message's `usage` stays a value whatever its size, a compaction moves only the large members of
 * its server-side window record and keeps every other field, entries with the same cooled fields
 * share one list and no list is shared between a message and a window, the entry, its stand-in and
 * each copy on the way to it keep their key order, the objects the entry held before it cooled are
 * never altered, and every entry serializes back to its line. Fields an entry inherits are neither
 * moved nor copied onto the stand-in. An assignment anywhere on the way to a stand-in reads the
 * entry back first.
 *
 * What it does NOT catch: blob references, which the generator never writes, and the read-back of a
 * line whose bytes changed under the handle; the session manager suites cover both.
 */

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

const FIELD_NAMES = ["alpha", "beta", "gamma", "delta", "epsilon"];
const MESSAGE_FIELD_NAMES = [...FIELD_NAMES, "usage"];
const WINDOW_FIELD_NAMES = [...FIELD_NAMES, "window"];
const LONG = "x".repeat(MIN_COLD_STRING_LENGTH);
const ENTRY_RESIDENT = new Set(["type", "id", "parentId", "timestamp"]);
const MESSAGE_ENTRY_RESIDENT = new Set([...ENTRY_RESIDENT, "message"]);
/** A message's fields its stand-in keeps as values whatever their size. */
const MESSAGE_RESIDENT = new Set(["usage"]);
const WINDOW_PATH = ["preserveData", REMOTE_COMPACTION_PRESERVE_KEY] as const;

function isLargeValue(value: unknown): boolean {
	return typeof value === "string"
		? value.length >= MIN_COLD_STRING_LENGTH
		: typeof value === "object" && value !== null;
}

/** The own fields of `record` outside `resident` that cooling moves, in key order. */
function expectedLarge(record: Record<string, unknown>, resident: ReadonlySet<string>): string[] {
	return Object.keys(record).filter(key => !resident.has(key) && isLargeValue(record[key]));
}

/** The own keys of `target` held behind an accessor rather than as a value, in key order. */
function accessorKeys(target: Record<string, unknown>): string[] {
	return Object.keys(target).filter(key => Object.getOwnPropertyDescriptor(target, key)!.get !== undefined);
}

/** A random subset of `fieldNames` in random order, each with a small, long, object or null value. */
function randomFields(random: () => number, target: Record<string, unknown>, fieldNames = FIELD_NAMES): void {
	const names = [...fieldNames];
	for (let i = names.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[names[i], names[j]] = [names[j]!, names[i]!];
	}
	const count = Math.floor(random() * (names.length + 1));
	for (const name of names.slice(0, count)) {
		const roll = random();
		target[name] =
			roll < 0.3
				? "small"
				: roll < 0.55
					? `${LONG}${name}`
					: roll < 0.8
						? { nested: [name, 1] }
						: roll < 0.9
							? null
							: 7;
	}
}

/** `record` with `key` set to `value`, before or after the fields `fill` adds, at random. */
function withField(
	random: () => number,
	record: Record<string, unknown>,
	key: string,
	value: unknown,
	fill: () => void,
) {
	if (random() < 0.5) {
		record[key] = value;
		fill();
	} else {
		fill();
		record[key] = value;
	}
}

function generate(seed: number, count: number): Record<string, unknown>[] {
	const random = mulberry32(seed);
	const records: Record<string, unknown>[] = [];
	for (let i = 0; i < count; i++) {
		const base: Record<string, unknown> = {
			id: `s${seed}-${i}`,
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const roll = random();
		if (roll < 0.4) {
			const message: Record<string, unknown> = { role: "toolResult" };
			randomFields(random, message, MESSAGE_FIELD_NAMES);
			const entry: Record<string, unknown> = { type: "message", ...base, message };
			if (random() < 0.3) randomFields(random, entry);
			records.push(entry);
		} else if (roll < 0.75) {
			const entry: Record<string, unknown> = { type: "compaction", ...base };
			const kind = random();
			// A window record, a window record that is not an object, a preserveData that is not an
			// object, or no preserveData.
			if (kind < 0.7) {
				const remote: Record<string, unknown> = { provider: "p", api: "a" };
				randomFields(random, remote, WINDOW_FIELD_NAMES);
				const preserveData: Record<string, unknown> = {};
				withField(random, preserveData, REMOTE_COMPACTION_PRESERVE_KEY, remote, () =>
					randomFields(random, preserveData),
				);
				withField(random, entry, "preserveData", preserveData, () => randomFields(random, entry));
			} else if (kind < 0.8) {
				withField(random, entry, "preserveData", { [REMOTE_COMPACTION_PRESERVE_KEY]: LONG }, () =>
					randomFields(random, entry),
				);
			} else if (kind < 0.9) {
				withField(random, entry, "preserveData", LONG, () => randomFields(random, entry));
			} else randomFields(random, entry);
			records.push(entry);
		} else {
			const entry: Record<string, unknown> = { type: "custom", ...base };
			randomFields(random, entry);
			records.push(entry);
		}
	}
	return records;
}

/** The object at `path` below `record`, when each step is an object. */
function objectAt(record: Record<string, unknown>, path: readonly string[]): Record<string, unknown> | undefined {
	let node = record;
	for (const key of path) {
		const next = node[key];
		if (!isRecord(next)) return undefined;
		node = next;
	}
	return node;
}

/** Payloads pinned on a reader that returns the line recorded at each offset, a line's index. */
function pinnedPayloads(lines: readonly string[]): ColdEntryPayloads {
	const payloads = new ColdEntryPayloads();
	const reader = {
		identity: "test:1",
		read: (offset: number) => lines[offset]!,
		scanLines: (from: number, headBytes: number, visit: (head: string, offset: number, length: number) => void) => {
			for (let index = from; index < lines.length; index++) visit(lines[index]!.slice(0, headBytes), index, 1);
			return lines.length;
		},
		close: () => {},
	};
	const pinned = payloads.pin(
		"test:1",
		() => reader,
		line => JSON.parse(line) as SessionEntry,
	);
	expect(pinned).toBe(true);
	return payloads;
}

describe("a cold entry lists its own large fields in key order", () => {
	for (const seed of [1, 2, 3, 4]) {
		it(`moves exactly the own large fields, shares each list, and serializes back to its line (seed ${seed})`, () => {
			const records = generate(seed, 600);
			const lines = records.map(record => JSON.stringify(record));
			const entries = lines.map(line => JSON.parse(line) as Record<string, unknown>);
			const payloads = pinnedPayloads(lines);
			const shared = new Map<string, readonly string[]>();
			const listsOf = { message: new Set<readonly string[]>(), window: new Set<readonly string[]>() };
			const cooledBy = { message: 0, window: 0 };
			// The copies on the way to each stand-in, for the checks after every entry reads back.
			const standIns: {
				entry: Record<string, unknown>;
				path: readonly string[];
				copies: Record<string, unknown>[];
			}[] = [];
			for (let i = 0; i < entries.length; i++) {
				const entry = entries[i]!;
				const original = records[i]!;
				const compaction = original.type === "compaction";
				const path: readonly string[] = original.type === "message" ? ["message"] : compaction ? WINDOW_PATH : [];
				const nested = path.length === 0 ? undefined : objectAt(original, path);
				const standInKeys =
					nested === undefined ? [] : expectedLarge(nested, compaction ? new Set() : MESSAGE_RESIDENT);
				const entryKeys = compaction
					? []
					: expectedLarge(original, nested === undefined ? ENTRY_RESIDENT : MESSAGE_ENTRY_RESIDENT);
				// The objects the entry holds before it cools, which a caller may hold too.
				const held = path.map((_, depth) => objectAt(entry, path.slice(0, depth + 1)));
				const heldLines = held.map(object => JSON.stringify(object));
				const cooled = payloads.cool(entry as unknown as SessionEntry, i, 2048);
				expect(cooled).toBe(entryKeys.length > 0 || standInKeys.length > 0);
				for (let depth = 0; depth < held.length; depth++) {
					const object = held[depth];
					if (object === undefined) continue;
					expect(accessorKeys(object)).toEqual([]);
					expect(coldFieldsOf(object)).toBeUndefined();
					expect(JSON.stringify(object)).toBe(heldLines[depth]!);
				}
				if (!cooled) {
					expect(coldFieldsOf(entry)).toBeUndefined();
					continue;
				}
				const listed = coldFieldsOf(entry)!;
				expect([...listed]).toEqual(entryKeys);
				const known = shared.get(`e:${entryKeys.join(",")}`) ?? listed;
				expect(listed).toBe(known);
				shared.set(`e:${entryKeys.join(",")}`, listed);
				expect(Object.keys(entry)).toEqual(Object.keys(original));
				const standsIn = standInKeys.length > 0;
				expect(accessorKeys(entry)).toEqual(
					Object.keys(original).filter(key => entryKeys.includes(key) || (standsIn && key === path[0])),
				);
				if (!standsIn) continue;
				// Each object on the way down is a copy with the original's keys in its order.
				const copies: Record<string, unknown>[] = [];
				let node: Record<string, unknown> = entry;
				for (let depth = 0; depth < path.length; depth++) {
					const below = node[path[depth]!] as Record<string, unknown>;
					expect(below).not.toBe(held[depth]);
					expect(Object.keys(below)).toEqual(Object.keys(objectAt(original, path.slice(0, depth + 1))!));
					copies.push(below);
					node = below;
				}
				for (let depth = 0; depth + 1 < copies.length; depth++) {
					expect(coldFieldsOf(copies[depth]!)).toEqual([]);
					expect(accessorKeys(copies[depth]!)).toEqual([path[depth + 1]!]);
				}
				const standIn = copies.at(-1)!;
				const rule = compaction ? "window" : "message";
				const listedStandIn = coldFieldsOf(standIn)!;
				expect([...listedStandIn]).toEqual(standInKeys);
				const knownStandIn = shared.get(`${rule}:${standInKeys.join(",")}`) ?? listedStandIn;
				expect(listedStandIn).toBe(knownStandIn);
				shared.set(`${rule}:${standInKeys.join(",")}`, listedStandIn);
				listsOf[rule].add(listedStandIn);
				expect(accessorKeys(standIn)).toEqual(standInKeys);
				// Walking down to the stand-in read nothing back.
				expect(coldFieldsOf(entry)).toBe(listed);
				cooledBy[rule] += 1;
				standIns.push({ entry, path, copies });
			}
			expect(cooledBy.message).toBeGreaterThan(0);
			expect(cooledBy.window).toBeGreaterThan(0);
			// A list of a window's fields is never the list of a message's same fields: the list states
			// which path the entry's stand-in sits at.
			const sameNames = [...listsOf.window].flatMap(list =>
				[...listsOf.message].filter(other => other.join(",") === list.join(",")).map(other => [list, other]),
			);
			expect(sameNames.length).toBeGreaterThan(0);
			for (const [list, other] of sameNames) expect(list).not.toBe(other);
			for (let i = 0; i < entries.length; i++) {
				expect(JSON.stringify(entries[i])).toBe(lines[i]!);
				expect(coldFieldsOf(entries[i]!)).toBeUndefined();
			}
			// A read-back leaves each copy in place as a plain object.
			for (const { entry, path, copies } of standIns) {
				let node: Record<string, unknown> = entry;
				for (let depth = 0; depth < path.length; depth++) {
					const below = node[path[depth]!] as Record<string, unknown>;
					expect(below).toBe(copies[depth]!);
					expect(accessorKeys(below)).toEqual([]);
					expect(coldFieldsOf(below)).toBeUndefined();
					node = below;
				}
			}
		});
	}

	it("returns a prefix's own list, not the list of a longer path through it", () => {
		const records = [
			{ type: "custom", id: "long", parentId: null, timestamp: "t", alpha: LONG, beta: LONG },
			{ type: "custom", id: "prefix", parentId: null, timestamp: "t", alpha: LONG, beta: "small" },
			{ type: "custom", id: "swapped", parentId: null, timestamp: "t", beta: LONG, alpha: LONG },
		];
		const lines = records.map(record => JSON.stringify(record));
		const entries = lines.map(line => JSON.parse(line) as SessionEntry);
		const payloads = pinnedPayloads(lines);
		for (let i = 0; i < entries.length; i++) expect(payloads.cool(entries[i]!, i, 2048)).toBe(true);
		expect(entries.map(entry => [...coldFieldsOf(entry)!])).toEqual([
			["alpha", "beta"],
			["alpha"],
			["beta", "alpha"],
		]);
	});

	it("reads a cold compaction back before an assignment on the way to its window, not beside it", () => {
		const record = {
			type: "compaction",
			id: "c",
			parentId: null,
			timestamp: "t",
			summary: LONG,
			preserveData: {
				notes: LONG,
				[REMOTE_COMPACTION_PRESERVE_KEY]: { provider: "p", api: "a", window: [{ text: LONG }], model: "m" },
			},
		};
		const line = JSON.stringify(record);
		// An assignment that replaces the window or an object holding it reads the entry back first; one
		// that replaces a resident value beside the window leaves the window on disk.
		for (const [path, readsBack] of [
			[WINDOW_PATH.slice(0, 1), true],
			[WINDOW_PATH, true],
			[[...WINDOW_PATH, "window"], true],
			[[...WINDOW_PATH, "model"], false],
		] as const) {
			const entry = JSON.parse(line) as Record<string, unknown>;
			expect(pinnedPayloads([line]).cool(entry as unknown as SessionEntry, 0, 2048)).toBe(true);
			objectAt(entry, path.slice(0, -1))![path.at(-1)!] = "replaced";
			expect({ path, cold: coldFieldsOf(entry) !== undefined }).toEqual({ path, cold: !readsBack });
			const expected = JSON.parse(line) as Record<string, unknown>;
			objectAt(expected, path.slice(0, -1))![path.at(-1)!] = "replaced";
			expect(JSON.stringify(entry)).toBe(JSON.stringify(expected));
		}
	});

	it("neither moves nor copies a field the entry or its message inherits", () => {
		const inherited = { inheritedPayload: LONG };
		const message = Object.assign(Object.create(inherited) as Record<string, unknown>, {
			role: "toolResult",
			content: [{ type: "text", text: LONG }],
		});
		const entry = Object.assign(Object.create(inherited) as Record<string, unknown>, {
			type: "message",
			id: "own",
			parentId: null,
			timestamp: "t",
			message,
			extra: LONG,
		});
		const line = JSON.stringify(entry);
		const payloads = pinnedPayloads([line]);
		expect(payloads.cool(entry as unknown as SessionEntry, 0, 2048)).toBe(true);
		expect([...coldFieldsOf(entry)!]).toEqual(["extra"]);
		const standIn = entry.message as Record<string, unknown>;
		expect([...coldFieldsOf(standIn)!]).toEqual(["content"]);
		expect(Object.keys(standIn)).toEqual(["role", "content"]);
		expect(Object.hasOwn(entry, "inheritedPayload")).toBe(false);
		expect(JSON.stringify(entry)).toBe(line);
	});
});
