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
import { BuildStore } from "@veyyon/utils/build-store";
import { getToolWireSchemaCachePath } from "@veyyon/utils/dirs";
import { isRecord } from "@veyyon/utils/type-guards";
import type { TSchema } from "../../types";
import { parametersWireSchema } from "./wire";

type WireSchema = Record<string, unknown>;

/** The wire forms one build computed, persisted in one JSON file; see {@link BuildStore}. */
export type ToolWireSchemaStore = BuildStore<WireSchema>;

/**
 * The wire-schema store of `build`, kept in `filePath`. Its version is bumped whenever what a stored wire
 * form means changes.
 */
export function createToolWireSchemaStore(build: string | undefined, filePath: () => string): ToolWireSchemaStore {
	return new BuildStore({ build, filePath, version: 2, isValue: isRecord });
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
const buildStore = createToolWireSchemaStore(process.env.VEYYON_BUILD_ID, getToolWireSchemaCachePath);

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
