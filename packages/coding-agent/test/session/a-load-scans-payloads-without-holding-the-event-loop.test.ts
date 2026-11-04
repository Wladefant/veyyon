import { afterEach, describe, expect, it, vi } from "bun:test";
import { BlobStore, externalizeTextSync } from "@veyyon/kernel/session/blob-store";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { resolveBlobRefsInEntries } from "@veyyon/kernel/session/session-loader";
import { TempDir, TIME_SLICE_MS } from "@veyyon/utils";

/**
 * Restoring a loaded session's payloads lets the event loop run between slices of its scan of the
 * entries, and restores the same payloads whatever the slicing.
 *
 * WHY. The scan that collects every externalized reference and pools every parsed string walked all
 * entries of the session in one synchronous pass. Resuming a 76,597-entry session held the event
 * loop for 58-61 ms in that pass and the commit after it, so no key was read and no frame drawn. The
 * class is an O(entries) pass in the load's preparation that never yields. The scan now yields once
 * a `TimeSlice` is due, between two entries.
 *
 * Covered: with every clock check due, no event-loop turn scans more than one entry, every entry is
 * scanned, and references on both sides of a yield are restored or counted lost as an unsliced
 * scan restores and counts them.
 *
 * Does not catch: the tool-result restore pass after the blob reads, and the manager's commit of
 * the loaded entries (`#applyEntries`, the cooling of unreachable payloads), which stay synchronous;
 * a cold entry's resident walk is reached through the same loop but is not constructed here.
 */

afterEach(() => {
	vi.restoreAllMocks();
});

/** Every read of the clock advances it by a whole slice, so each check of the scan finds its slice due. */
function everyCheckIsDue(): void {
	let clock = 0;
	vi.spyOn(performance, "now").mockImplementation(() => {
		clock += TIME_SLICE_MS;
		return clock;
	});
}

/** Numbers the event-loop turns with a check-phase callback that requeues itself until stopped. */
function turns(): { current: () => number; stop: () => void } {
	let turn = 0;
	let running = true;
	const tick = () => {
		turn += 1;
		if (running) setImmediate(tick);
	};
	setImmediate(tick);
	return {
		current: () => turn,
		stop: () => {
			running = false;
		},
	};
}

/** A message entry whose `id` records, in `scanned`, the turn of each walk that reads it. */
function observedEntry(index: number, turn: () => number, scanned: Map<number, Set<number>>): FileEntry {
	const entry: Record<string, unknown> = {
		type: "message",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", timestamp: 0, content: [{ type: "text", text: `entry ${index}` }] },
	};
	let id = `e${index}`;
	Object.defineProperty(entry, "id", {
		enumerable: true,
		get() {
			const at = turn();
			const entries = scanned.get(at) ?? new Set<number>();
			entries.add(index);
			scanned.set(at, entries);
			return id;
		},
		set(value: string) {
			id = value;
		},
	});
	return entry as unknown as FileEntry;
}

function textEntry(id: string, text: string): FileEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", timestamp: 0, content: [{ type: "text", text }] },
	} as unknown as FileEntry;
}

function textOf(entry: FileEntry): string {
	return (entry as unknown as { message: { content: [{ text: string }] } }).message.content[0].text;
}

async function withStore<T>(run: (store: BlobStore) => Promise<T>): Promise<T> {
	const dir = TempDir.createSync("@pi-blob-slices-");
	try {
		return await run(new BlobStore(dir.path()));
	} finally {
		await dir.remove();
	}
}

describe("restoring a loaded session's payloads", () => {
	it("scans at most one entry per event-loop turn when every slice is due, and scans every entry", async () => {
		await withStore(async store => {
			const clock = turns();
			const scanned = new Map<number, Set<number>>();
			const entries = Array.from({ length: 40 }, (_, index) => observedEntry(index, clock.current, scanned));
			everyCheckIsDue();
			try {
				await resolveBlobRefsInEntries(entries, store);
			} finally {
				clock.stop();
			}
			const perTurn = [...scanned.values()].map(indexes => indexes.size);
			expect(Math.max(...perTurn)).toBe(1);
			expect(new Set([...scanned.values()].flatMap(indexes => [...indexes])).size).toBe(entries.length);
		});
	});

	it("restores and counts lost the references on both sides of a yield as one pass does", async () => {
		await withStore(async store => {
			const kept = externalizeTextSync(store, "a payload the store holds");
			const missing = `blobtext:sha256:${"d".repeat(64)}`;
			const texts = Array.from({ length: 24 }, (_, index) =>
				index % 8 === 0 ? kept : index % 8 === 5 ? missing : `plain ${index}`,
			);
			const expected = texts.map(text => (text === kept ? "a payload the store holds" : text));
			const lost = new Map<string, number>();
			for (const sliced of [false, true]) {
				const entries = texts.map((text, index) => textEntry(`e${index}`, text));
				if (sliced) everyCheckIsDue();
				lost.set(sliced ? "sliced" : "one pass", await resolveBlobRefsInEntries(entries, store));
				vi.restoreAllMocks();
				expect(entries.map(textOf)).toEqual(expected);
			}
			expect(Object.fromEntries(lost)).toEqual({ "one pass": 3, sliced: 3 });
		});
	});
});
