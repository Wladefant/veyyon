/**
 * Payloads of session entries the live context cannot reach, held on disk instead of in memory.
 *
 * A resumed 402 MiB session held 501 MiB of heap, and 438 MiB of it belonged to entries before the
 * latest compaction boundary: tool results, assistant turns and their details, which no request
 * sends again and no default view draws. A cold entry keeps the fields the index and the path walk
 * read (`type`, `id`, `parentId`, `timestamp`, and every small value); each large field is replaced
 * by an accessor that reads the entry's line back from the session file on first use and restores
 * it through the same pipeline a load runs. A cold message entry keeps a message object holding the
 * message's small values (`role`, `toolName`, `toolCallId`, `isError`, `stopReason`, `provider`,
 * `model`), so a scan that picks entries by them reads none of them back; the message's large
 * fields are accessors on that object. A read-back entry stays in memory until the next pass cools
 * it again.
 *
 * The line is read through a {@link PinnedSessionReader}, a handle on the file object the offsets
 * were recorded against. A republish by this process or another one, a relocation, or an unlink
 * leaves that object readable behind the handle, so a recorded offset stays correct for as long as
 * any entry needs it. The handle closes when its last cold entry is read back, or when the
 * entries holding it are collected.
 * A publish serializes a cold entry through its accessors, so the entry reads its line back from
 * the pinned object before the new file replaces the path.
 *
 * A cold entry reads back as a resume of the session would load it: a field persistence truncates
 * or externalizes comes back truncated or restored from the blob store, and a replayed reasoning
 * signature persistence drops does not come back.
 */
import { errorMessage, isRecord } from "@veyyon/utils";
import type { SessionEntry } from "./session-entries";
import type { PinnedSessionReader } from "./session-storage";

/**
 * Lines shorter than this stay in memory. A cold entry costs a stub and the handle that reads it,
 * about a hundred bytes; below a kilobyte the saving does not cover a read-back's parse.
 */
export const MIN_COLD_LINE_BYTES = 1024;

/** A string field shorter than this stays in memory beside the entry's structural fields. */
export const MIN_COLD_STRING_LENGTH = 256;

/** Fields every entry keeps: what the id index, the tree and the branch walk read. */
const RESIDENT_KEYS: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp"]);

/** A message entry's resident fields: its message is replaced by a stand-in rather than an accessor. */
const MESSAGE_ENTRY_RESIDENT_KEYS: ReadonlySet<string> = new Set([...RESIDENT_KEYS, "message"]);

const NO_KEYS: ReadonlySet<string> = new Set();

const NO_FIELDS: readonly string[] = [];

/**
 * Entry kinds a session writes for replay and study and never reads while it runs: the prompt and
 * tools a session started with, the effective settings it ran under, and the index of the agents it
 * spawned. Their payloads go to disk wherever they sit on the branch; a spawned agent's
 * `session_init` holds its whole joined system prompt.
 */
export const RECORD_ONLY_ENTRY_TYPES: ReadonlySet<SessionEntry["type"]> = new Set<SessionEntry["type"]>([
	"session_init",
	"settings_snapshot",
	"subagent_spawn",
]);

/** One file object cold entries read back from, and how many entries still read from it. */
interface ColdFile {
	readonly reader: PinnedSessionReader;
	/** Parses and restores a line of this object, against the blob store of the session it belongs to. */
	readonly restore: ColdLineRestore;
	cold: number;
}

/** Where one cold entry's line is, and which of its fields were moved out. */
interface ColdStub {
	file: ColdFile;
	readonly offset: number;
	readonly length: number;
	readonly entry: SessionEntry;
	/** The entry's fields replaced by accessors. */
	readonly keys: readonly string[];
	/**
	 * A message entry's stand-in for its message: the message's small values, and an accessor for
	 * each field in `messageKeys`. `entry.message` returns it without reading the line back.
	 */
	readonly message: Record<string, unknown> | undefined;
	readonly messageKeys: readonly string[];
}

/** Parse one session line and restore what persistence moved out of it. */
export type ColdLineRestore = (line: string) => SessionEntry;

/** The fields of `record` outside `resident` whose values are objects or long strings. */
function largeKeys(record: Record<string, unknown>, resident: ReadonlySet<string>): string[] {
	const keys: string[] = [];
	for (const key of Object.keys(record)) {
		if (resident.has(key)) continue;
		const value = record[key];
		if (
			typeof value === "string"
				? value.length >= MIN_COLD_STRING_LENGTH
				: typeof value === "object" && value !== null
		) {
			keys.push(key);
		}
	}
	return keys;
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A base whose constructor returns its argument, so a subclass installs its fields on that object. */
class ReturnsTarget {
	constructor(target: object) {
		// biome-ignore lint/correctness/noConstructorReturn: `new ColdSlot(entry)` installs `#stub` on the entry itself.
		return target;
	}
}

/**
 * The stub of a cold entry or message stand-in, held in a private field installed on that object.
 * A private field is invisible to `Object.keys`, `Reflect.ownKeys`, `JSON.stringify`,
 * `structuredClone` and every descriptor walk, and costs one property slot, where a `WeakMap`
 * keyed by every cold object costs a table entry per key: 4 MiB for the 69,498 cold objects of a
 * resumed session.
 */
class ColdSlot extends ReturnsTarget {
	#stub: ColdStub | undefined;

	static get(target: object): ColdStub | undefined {
		return #stub in target ? (target as ColdSlot).#stub : undefined;
	}

	static set(target: object, stub: ColdStub | undefined): void {
		if (#stub in target) (target as ColdSlot).#stub = stub;
		else if (stub !== undefined) new ColdSlot(target).#stub = stub;
	}
}

export class ColdEntryPayloads {
	/** One accessor pair per field name, shared by every entry cooled on that field. */
	readonly #accessors = new Map<string, PropertyDescriptor>();
	/** Key lists shared by every entry with the same cooled fields. */
	readonly #keySets = new Map<string, readonly string[]>();
	/** The file object new cold entries are recorded against. */
	#current: ColdFile | undefined;
	/** The accessor pair every cold message entry's `message` is replaced by, built on first use. */
	#messageDescriptor: PropertyDescriptor | undefined;

	/** Identity of the file object new cold entries are recorded against, if one is open. */
	get pinnedIdentity(): string | undefined {
		return this.#current?.reader.identity;
	}

	/**
	 * Record new cold entries against the object with `identity`: keep the current handle when it
	 * reads that object, otherwise open one with `open`. Returns false, and pins nothing, when no
	 * handle on that object can be opened; the path may already name another object by then.
	 * `restore` reads a line of that object back.
	 */
	pin(identity: string, open: () => PinnedSessionReader | undefined, restore: ColdLineRestore): boolean {
		if (this.#current?.reader.identity === identity) return true;
		const reader = open();
		if (reader === undefined) return false;
		if (reader.identity !== identity) {
			reader.close();
			return false;
		}
		this.#replaceCurrent({ reader, restore, cold: 0 });
		return true;
	}

	/**
	 * Move every cold entry in `entries` read through the current handle onto a handle on the
	 * object with `identity`. The caller guarantees that object holds the same bytes at every cold
	 * entry's offset: it is a republish that kept the file's prefix. Entries outside `entries` keep
	 * the old handle. Returns false, and moves nothing, when no handle on that object can be opened.
	 */
	rebase(entries: readonly SessionEntry[], identity: string, open: () => PinnedSessionReader | undefined): boolean {
		const previous = this.#current;
		if (previous === undefined || previous.reader.identity === identity) return true;
		const reader = open();
		if (reader === undefined) return false;
		if (reader.identity !== identity) {
			reader.close();
			return false;
		}
		const next: ColdFile = { reader, restore: previous.restore, cold: 0 };
		for (const entry of entries) {
			const stub = ColdSlot.get(entry);
			if (stub?.file !== previous) continue;
			stub.file = next;
			previous.cold -= 1;
			next.cold += 1;
		}
		this.#replaceCurrent(next);
		return true;
	}

	/**
	 * Move `entry`'s large fields out of memory, to be read back from `length` bytes at `offset` of
	 * the pinned object. A message entry's message is replaced by a stand-in holding its small values
	 * and an accessor for each large field. Returns false when nothing is pinned, the entry is already
	 * cold, or no field is large enough to move.
	 */
	cool(entry: SessionEntry, offset: number, length: number): boolean {
		const file = this.#current;
		if (file === undefined || length < MIN_COLD_LINE_BYTES || ColdSlot.get(entry) !== undefined) return false;
		const record = entry as unknown as Record<string, unknown>;
		const original = entry.type === "message" ? record.message : undefined;
		const nested = isRecord(original) ? original : undefined;
		const keys = largeKeys(record, nested === undefined ? RESIDENT_KEYS : MESSAGE_ENTRY_RESIDENT_KEYS);
		const movedFromMessage = nested === undefined ? NO_FIELDS : largeKeys(nested, NO_KEYS);
		if (keys.length === 0 && movedFromMessage.length === 0) return false;
		let message: Record<string, unknown> | undefined;
		if (nested !== undefined && movedFromMessage.length > 0) {
			// Built in the original's key order, so the entry serializes as it did.
			message = {};
			for (const key of Object.keys(nested)) {
				if (movedFromMessage.includes(key)) Object.defineProperty(message, key, this.#accessor(key));
				else message[key] = nested[key];
			}
		}
		const shared = keys.length === 0 ? NO_FIELDS : this.#sharedKeys(keys);
		const messageKeys = message === undefined ? NO_FIELDS : this.#sharedKeys(movedFromMessage);
		for (const key of shared) Object.defineProperty(record, key, this.#accessor(key));
		const stub: ColdStub = { file, offset, length, entry, keys: shared, message, messageKeys };
		ColdSlot.set(entry, stub);
		if (message !== undefined) {
			Object.defineProperty(record, "message", this.#messageAccessor());
			ColdSlot.set(message, stub);
		}
		file.cold += 1;
		return true;
	}

	/**
	 * {@link cool} for an entry whose `line`, `length` bytes, was just appended at `offset`: the
	 * pinned object is read there first, and the entry is cooled only when it holds `line`. An
	 * append of another writer's that landed first, or a write that did not complete, leaves the
	 * entry in memory, and closes the handle when no cold entry reads through it.
	 */
	coolWritten(entry: SessionEntry, line: string, offset: number, length: number): boolean {
		const file = this.#current;
		if (file === undefined || length < MIN_COLD_LINE_BYTES || ColdSlot.get(entry) !== undefined) return false;
		let written: string | undefined;
		try {
			written = file.reader.read(offset, length);
		} catch {
			written = undefined;
		}
		if (written === line && this.cool(entry, offset, length)) return true;
		if (file.cold === 0) {
			this.#current = undefined;
			file.reader.close();
		}
		return false;
	}

	/**
	 * Read the large fields of the cold entry `receiver` is, or is the message stand-in of, back
	 * into memory. A warm entry is left as it is.
	 */
	warm(receiver: object): void {
		const stub = ColdSlot.get(receiver);
		if (stub === undefined) return;
		const { entry, message } = stub;
		const line = stub.file.reader.read(stub.offset, stub.length);
		let restored: Record<string, unknown>;
		try {
			restored = stub.file.restore(line) as unknown as Record<string, unknown>;
		} catch (err) {
			throw new Error(
				`Session entry ${entry.id} could not be read back from bytes ${stub.offset}-${stub.offset + stub.length} of session object ${stub.file.reader.identity}: ${errorMessage(err)}`,
			);
		}
		const restoredMessage = restored.message;
		if (
			restored.id !== entry.id ||
			restored.type !== entry.type ||
			(message !== undefined && !isRecord(restoredMessage))
		) {
			throw new Error(
				`Session entry ${entry.id} read back as ${String(restored.type)} ${String(restored.id)} from bytes ${stub.offset}-${stub.offset + stub.length} of session object ${stub.file.reader.identity}`,
			);
		}
		// Cleared first, so a throw above leaves the entry cold and readable again.
		ColdSlot.set(entry, undefined);
		const record = entry as unknown as Record<string, unknown>;
		for (const key of stub.keys) defineValue(record, key, restored[key]);
		if (message !== undefined) {
			ColdSlot.set(message, undefined);
			const from = restoredMessage as Record<string, unknown>;
			for (const key of stub.messageKeys) defineValue(message, key, from[key]);
			defineValue(record, "message", message);
		}
		this.#release(stub.file);
	}

	#replaceCurrent(next: ColdFile): void {
		const previous = this.#current;
		this.#current = next;
		if (previous !== undefined && previous.cold === 0) previous.reader.close();
	}

	#release(file: ColdFile): void {
		file.cold -= 1;
		if (file.cold > 0) return;
		if (file === this.#current) this.#current = undefined;
		file.reader.close();
	}

	#sharedKeys(keys: readonly string[]): readonly string[] {
		const name = keys.join("\0");
		const known = this.#keySets.get(name);
		if (known !== undefined) return known;
		this.#keySets.set(name, keys);
		return keys;
	}

	/**
	 * The accessor pair a cold field is replaced by. The receiver is the entry, so one pair serves
	 * every entry: a closure per entry per field cost more than the smaller cold entries free.
	 */
	#accessor(key: string): PropertyDescriptor {
		const known = this.#accessors.get(key);
		if (known !== undefined) return known;
		const payloads = this;
		const descriptor: PropertyDescriptor = {
			configurable: true,
			enumerable: true,
			get(this: SessionEntry): unknown {
				payloads.warm(this);
				return (this as unknown as Record<string, unknown>)[key];
			},
			set(this: SessionEntry, value: unknown): void {
				payloads.warm(this);
				(this as unknown as Record<string, unknown>)[key] = value;
			},
		};
		this.#accessors.set(key, descriptor);
		return descriptor;
	}

	/**
	 * The accessor pair a cold message entry's `message` is replaced by: the getter returns the
	 * stand-in without reading the line back, and the setter reads it back first, so an assignment
	 * leaves no stub behind it.
	 */
	#messageAccessor(): PropertyDescriptor {
		if (this.#messageDescriptor !== undefined) return this.#messageDescriptor;
		const payloads = this;
		this.#messageDescriptor = {
			configurable: true,
			enumerable: true,
			get(this: SessionEntry): unknown {
				const message = ColdSlot.get(this)?.message;
				if (message === undefined) throw new Error(`Cold session entry ${this.id} lost its message stand-in`);
				return message;
			},
			set(this: SessionEntry, value: unknown): void {
				payloads.warm(this);
				(this as unknown as Record<string, unknown>).message = value;
			},
		};
		return this.#messageDescriptor;
	}
}
