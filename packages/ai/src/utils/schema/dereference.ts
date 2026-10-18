/**
 * Inline `$ref` / `$defs` in a JSON Schema so every consumer sees
 * the full definition without needing a resolver.
 *
 * Handles:
 * - Local `$ref` pointers (`#/$defs/Foo`, `#/definitions/Foo`)
 * - Nested `$defs` / `definitions` blocks
 * - Circular references (breaks the cycle by emitting `{}`)
 *
 * After dereferencing, `$defs` and `definitions` are stripped from the root.
 */
import { isJsonObject, type JsonObject } from "./types";

/**
 * Parse a local `$ref` URI fragment into decoded JSON Pointer tokens:
 * percent-decode the fragment, split on `/`, then unescape `~1`/`~0` per
 * token. Returns `[]` for the root ref `#`, and `undefined` for non-local
 * refs or fragments that do not percent-decode.
 */
export function parseLocalRefPointer(ref: string): string[] | undefined {
	if (!ref.startsWith("#")) return undefined;
	let pointer: string;
	try {
		pointer = decodeURIComponent(ref.slice(1));
	} catch {
		return undefined;
	}
	if (pointer.length > 0 && !pointer.startsWith("/")) return undefined;
	return pointer
		.split("/")
		.slice(1)
		.map(token => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Encode JSON Pointer tokens back into a local `$ref` URI fragment — the
 * inverse of {@link parseLocalRefPointer}.
 */
export function formatLocalRefPointer(tokens: readonly string[]): string {
	if (tokens.length === 0) return "#";
	// `$` and the other URI sub-delims `encodeURIComponent` escapes are legal
	// in fragments, so keep `$defs` readable; `%` stays encoded to round-trip.
	const encoded = tokens
		.map(token => encodeURIComponent(token.replace(/~/g, "~0").replace(/\//g, "~1")))
		.map(token => token.replace(/%24/g, "$"));
	return `#/${encoded.join("/")}`;
}


// Only schema-valued keywords may contain references; literal JSON is opaque.
const SCHEMA_MAP_KEYS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	dependencies: true,
	dependentSchemas: true,
};
const SCHEMA_ARRAY_KEYS: Record<string, true> = { anyOf: true, oneOf: true, allOf: true, prefixItems: true };
const SCHEMA_VALUE_KEYS: Record<string, true> = {
	items: true,
	additionalItems: true,
	contains: true,
	contentSchema: true,
	propertyNames: true,
	if: true,
	// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword
	then: true,
	else: true,
	not: true,
	additionalProperties: true,
	unevaluatedItems: true,
	unevaluatedProperties: true,
};

function dereferenceKeyword(key: string, value: unknown, root: JsonObject, visiting: Set<string>): unknown {
	if (Object.hasOwn(SCHEMA_MAP_KEYS, key) && isJsonObject(value)) {
		const result: JsonObject = {};
		for (const name in value) result[name] = dereferenceNode(value[name], root, visiting);
		return result;
	}
	if ((Object.hasOwn(SCHEMA_ARRAY_KEYS, key) || key === "items") && Array.isArray(value)) {
		return value.map(item => dereferenceNode(item, root, visiting));
	}
	if (Object.hasOwn(SCHEMA_VALUE_KEYS, key)) return dereferenceNode(value, root, visiting);
	return value;
}

/**
 * Resolve a JSON-pointer-style `$ref` against the root schema's `$defs`
 * or `definitions` block. Returns `undefined` for external or unresolvable refs.
 */
function resolveLocalRef(ref: string, root: JsonObject): JsonObject | undefined {
	// Only handle local refs: #/$defs/Name or #/definitions/Name
	const pointer = parseLocalRefPointer(ref);
	if (pointer === undefined || pointer.length !== 2) return undefined;
	const defsKey = pointer[0];
	if (defsKey !== "$defs" && defsKey !== "definitions") return undefined;
	const defs = root[defsKey];
	if (!isJsonObject(defs)) return undefined;
	const resolved = defs[pointer[1]!];
	return isJsonObject(resolved) ? resolved : undefined;
}

/**
 * Recursively dereference a JSON Schema node, inlining all local `$ref` pointers.
 */
function dereferenceNode(node: unknown, root: JsonObject, visiting: Set<string>): unknown {
	if (!isJsonObject(node)) return node;

	const ref = node.$ref;
	if (typeof ref === "string") {
		// Break circular references
		if (visiting.has(ref)) return {};
		const resolved = resolveLocalRef(ref, root);
		if (!resolved) return node; // External ref — leave as-is
		visiting.add(ref);
		const inlined = dereferenceNode(resolved, root, visiting);
		visiting.delete(ref);

		// Merge sibling keywords (e.g. description, default) from the
		// referencing node. In draft 2020-12 these are valid alongside $ref.
		let hasSiblings = false;
		for (const k in node) {
			if (k !== "$ref" && k !== "$defs" && k !== "definitions") {
				hasSiblings = true;
				break;
			}
		}
		if (!hasSiblings || !isJsonObject(inlined)) return inlined;
		const merged: JsonObject = { ...inlined };
		for (const key in node) {
			if (key === "$ref" || key === "$defs" || key === "definitions") continue;
			merged[key] = dereferenceKeyword(key, node[key], root, visiting);
		}
		return merged;
	}

	const result: JsonObject = {};
	for (const key in node) {
		const value = node[key];
		// Skip $defs/definitions — they get inlined into consumers
		if (key === "$defs" || key === "definitions") continue;

		result[key] = dereferenceKeyword(key, value, root, visiting);
	}
	return result;
}

/**
 * Dereference all local `$ref` pointers in a JSON Schema, inlining definitions
 * from `$defs` / `definitions`. The `$defs` block is stripped from the output.
 *
 * Non-local refs (e.g. `http://...`) are left untouched.
 * Circular references are broken with `{}`.
 *
 * @returns A new schema object with all local refs inlined, or the input unchanged
 *          if it's not an object or has no `$defs`/`definitions`.
 */
export function dereferenceJsonSchema(schema: unknown): unknown {
	if (!isJsonObject(schema)) return schema;

	// Fast path: nothing to dereference
	const hasDefs = schema.$defs !== undefined || schema.definitions !== undefined;
	if (!hasDefs) return schema;

	return dereferenceNode(schema, schema, new Set());
}
