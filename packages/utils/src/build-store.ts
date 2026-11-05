/**
 * Values one build of the product computed, persisted in one JSON file per kind of value and read back
 * only by the build that stored them.
 *
 * A value computed from the build alone (its code and the data it embeds) is the same on every launch of
 * that build, so a later launch reads it instead of computing it again. The binary build defines
 * `process.env.VEYYON_BUILD_ID` as an id unique to that build; a run from source leaves it unset, and a
 * store without a build stores nothing.
 */
import * as fs from "node:fs";
import { atomicWriteFileSync } from "./atomic-write";
import * as logger from "./logger";
import { isRecord } from "./type-guards";

/** How a {@link BuildStore} is keyed, where it lives and what it holds. */
export interface BuildStoreOptions<V> {
	/** The build whose values the store holds; undefined or empty stores nothing. */
	readonly build: string | undefined;
	/** The file the store reads and writes, resolved on the first read. */
	readonly filePath: () => string;
	/** Bumped whenever the shape of a stored value, or what it means, changes. */
	readonly version: number;
	/** Whether a value read from the file is one this store holds; any other value is not served. */
	readonly isValue: (value: unknown) => value is V;
}

/**
 * Values keyed by string, persisted in one JSON file. Entries stored by another build, or under another
 * version, are not read: the file is replaced by the next write.
 */
export class BuildStore<V> {
	readonly #build: string | undefined;
	readonly #filePath: () => string;
	readonly #version: number;
	readonly #isValue: (value: unknown) => value is V;
	#entries: Map<string, V> | undefined;
	#unsaved = false;

	constructor(options: BuildStoreOptions<V>) {
		this.#build = options.build || undefined;
		this.#filePath = options.filePath;
		this.#version = options.version;
		this.#isValue = options.isValue;
	}

	/** The value stored under `key` by an earlier launch of this build. */
	get(key: string): V | undefined {
		if (this.#build === undefined) return undefined;
		return this.#load().get(key);
	}

	/** Store `value` under `key`. The file is written once the current task ends, with every entry put in it. */
	put(key: string, value: V): void {
		if (this.#build === undefined) return;
		this.#load().set(key, value);
		if (this.#unsaved) return;
		this.#unsaved = true;
		queueMicrotask(() => this.save());
	}

	/** Write the entries put since the last save, merged with those another process of this build wrote. */
	save(): void {
		if (!this.#unsaved || this.#build === undefined) return;
		this.#unsaved = false;
		const file = this.#filePath();
		const merged = this.#read(file);
		for (const [key, value] of this.#load()) merged.set(key, value);
		const body = JSON.stringify({ version: this.#version, build: this.#build, entries: Object.fromEntries(merged) });
		try {
			// A cache: a torn file fails to parse and is recomputed, so the write skips the fsync.
			atomicWriteFileSync(file, body, { fsync: false });
		} catch (error) {
			logger.debug("build store not written", { file, error: String(error) });
		}
	}

	#load(): Map<string, V> {
		this.#entries ??= this.#read(this.#filePath());
		return this.#entries;
	}

	#read(file: string): Map<string, V> {
		const entries = new Map<string, V>();
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			return entries;
		}
		if (!isRecord(parsed) || parsed.version !== this.#version || parsed.build !== this.#build) return entries;
		if (!isRecord(parsed.entries)) return entries;
		for (const [key, value] of Object.entries(parsed.entries)) {
			if (this.#isValue(value)) entries.set(key, value);
		}
		return entries;
	}
}
