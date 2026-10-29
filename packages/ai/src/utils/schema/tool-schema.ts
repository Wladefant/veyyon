/**
 * A tool's parameter schema held two ways: the value the agent validates a call against, built on
 * the first read of `value`, and the JSON Schema a request carries, `wire`.
 *
 * A request needs only the JSON Schema, and computing it from an arktype value evaluates arktype and
 * constructs the type: 28 ms of a compiled print launch across the default tool set, all of it before
 * the first request leaves. A compiled build stores each wire form it computes in the profile's
 * wire-schema cache under the build's id, and a later launch of the same build reads it from there, so
 * a launch whose turns call no tool never evaluates arktype, and one that calls a tool builds only that
 * tool's validator. A run from source has no build id and computes every wire form it reads.
 *
 * `id` names one schema for the life of a build. A schema built from runtime inputs carries every input
 * in its id. Two declarations of one id with different builders throw at the second one.
 */
import * as fs from "node:fs";
import { atomicWriteFileSync } from "@veyyon/utils/atomic-write";
import { getToolWireSchemaCachePath } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import type { TSchema } from "../../types";
import { parametersWireSchema } from "./wire";

/** Bumped whenever the file's shape, or what a stored wire form means, changes. */
const STORE_VERSION = 1;

type WireSchema = Record<string, unknown>;

/**
 * The wire forms one build computed, persisted in one JSON file. Entries stored by another build, or
 * under another {@link STORE_VERSION}, are not read: the file is replaced by the next write.
 */
export class ToolWireSchemaStore {
	readonly #build: string | undefined;
	readonly #filePath: () => string;
	#entries: Map<string, WireSchema> | undefined;
	#unsaved = false;

	/** `build` undefined or empty stores nothing; `filePath` is resolved on the first read. */
	constructor(build: string | undefined, filePath: () => string) {
		this.#build = build || undefined;
		this.#filePath = filePath;
	}

	/** The wire form stored under `id` by an earlier launch of this build. */
	get(id: string): WireSchema | undefined {
		if (this.#build === undefined) return undefined;
		return this.#load().get(id);
	}

	/** Store `wire` under `id`. The file is written once the current task ends, with every entry put in it. */
	put(id: string, wire: WireSchema): void {
		if (this.#build === undefined) return;
		this.#load().set(id, wire);
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
		for (const [id, wire] of this.#load()) merged.set(id, wire);
		const body = JSON.stringify({ version: STORE_VERSION, build: this.#build, schemas: Object.fromEntries(merged) });
		try {
			// A cache: a torn file fails to parse and is recomputed, so the write skips the fsync.
			atomicWriteFileSync(file, body, { fsync: false });
		} catch (error) {
			logger.debug("tool wire-schema cache not written", { file, error: String(error) });
		}
	}

	#load(): Map<string, WireSchema> {
		this.#entries ??= this.#read(this.#filePath());
		return this.#entries;
	}

	#read(file: string): Map<string, WireSchema> {
		const entries = new Map<string, WireSchema>();
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {
			return entries;
		}
		if (!isRecord(parsed) || parsed.version !== STORE_VERSION || parsed.build !== this.#build) return entries;
		if (!isRecord(parsed.schemas)) return entries;
		for (const [id, wire] of Object.entries(parsed.schemas)) {
			if (isRecord(wire)) entries.set(id, wire);
		}
		return entries;
	}
}

/** A tool parameter schema with its wire form; see the module documentation. */
export interface ToolSchema<T extends TSchema> {
	readonly id: string;
	/** The schema, built on the first read. A build that throws builds again on the next read. */
	readonly value: T;
	/** The JSON Schema `toolWireSchema` computes from {@link value}, read from `store` when it holds one. */
	readonly wire: WireSchema;
}

class StoredToolSchema<T extends TSchema> implements ToolSchema<T> {
	readonly id: string;
	readonly #store: ToolWireSchemaStore;
	#build: (() => T) | undefined;
	#value: T | undefined;
	#wire: WireSchema | undefined;

	constructor(store: ToolWireSchemaStore, id: string, build: () => T) {
		this.id = id;
		this.#store = store;
		this.#build = build;
	}

	get value(): T {
		if (this.#build !== undefined) {
			this.#value = this.#build();
			this.#build = undefined;
		}
		return this.#value as T;
	}

	get wire(): WireSchema {
		if (this.#wire === undefined) {
			const stored = this.#store.get(this.id);
			if (stored !== undefined) {
				this.#wire = stored;
			} else {
				this.#wire = parametersWireSchema(this.value);
				this.#store.put(this.id, this.#wire);
			}
		}
		return this.#wire;
	}
}

/** A {@link ToolSchema} whose wire form is read from and stored in `store`. */
export function createToolSchema<T extends TSchema>(
	store: ToolWireSchemaStore,
	id: string,
	build: () => T,
): ToolSchema<T> {
	return new StoredToolSchema(store, id, build);
}

/**
 * The store of the running build. The binary build defines `process.env.VEYYON_BUILD_ID` as an id
 * unique to that build; a run from source leaves it unset and stores nothing.
 */
const buildStore = new ToolWireSchemaStore(process.env.VEYYON_BUILD_ID, getToolWireSchemaCachePath);

/** The builder source each declared id was declared with, to reject a second schema under one id. */
const declaredBuilders = new Map<string, string>();

/**
 * Declare the parameter schema of a tool under `id`, its wire form stored per build.
 *
 * Declaring an id again with the same builder source returns a new holder for the same schema, which is
 * what a module evaluated twice does. A different builder under a declared id throws: the store would
 * serve one schema's wire form for the other.
 */
export function toolSchema<T extends TSchema>(id: string, build: () => T): ToolSchema<T> {
	const source = build.toString();
	const declared = declaredBuilders.get(id);
	if (declared === undefined) declaredBuilders.set(id, source);
	else if (declared !== source) {
		throw new Error(`Tool schema id "${id}" is already declared by another builder; give each schema its own id.`);
	}
	return createToolSchema(buildStore, id, build);
}
