/**
 * The arguments a tool card draws, conformed to the types the tool's schema declares.
 *
 * A card draws the arguments the model sent, as recorded, and those never passed the validator: the
 * validator runs before `execute` and the assistant message keeps what the model wrote. A card is typed
 * against the schema, so a model that sent `input: 404` where the schema says string handed the card a
 * number, and the first string method on it threw. Every card is reached through here, so one pass over
 * the schema replaces a type check in every card.
 *
 * A primitive where a string is declared is drawn as its text, so the card still shows what the model
 * asked for. Any other mismatch is dropped, which a card already draws as an argument that has not
 * streamed yet. A value whose schema states no type is left as it is.
 */

import type { AnyAgentTool } from "@veyyon/agent-core";
import type { Tool } from "@veyyon/ai";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { isRecord } from "@veyyon/utils/type-guards";

type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

/** Deepest nesting conformed; a schema deeper than this is left unchecked below it. */
const MAX_DEPTH = 8;

function jsonTypeOf(value: unknown): JsonType | undefined {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return Number.isInteger(value) ? "integer" : "number";
		case "boolean":
			return "boolean";
		case "object":
			return "object";
		default:
			return undefined;
	}
}

/**
 * The JSON types a schema admits, or undefined when it states none a value can be checked against.
 * `anyOf` / `oneOf` admit the union of their branches, and a branch that states no type makes the
 * whole schema unchecked, because any value might be the one it accepts.
 */
function admittedTypes(schema: Record<string, unknown>): Set<JsonType> | undefined {
	const admitted = new Set<JsonType>();
	const { type } = schema;
	if (typeof type === "string") admitted.add(type as JsonType);
	else if (Array.isArray(type)) for (const entry of type) admitted.add(entry as JsonType);
	for (const literal of [
		...(Array.isArray(schema.enum) ? schema.enum : []),
		...("const" in schema ? [schema.const] : []),
	]) {
		const literalType = jsonTypeOf(literal);
		if (literalType) admitted.add(literalType);
	}
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		for (const branch of branches) {
			const branchTypes = isRecord(branch) ? admittedTypes(branch) : undefined;
			if (!branchTypes) return undefined;
			for (const branchType of branchTypes) admitted.add(branchType);
		}
	}
	if (admitted.size === 0) return undefined;
	if (admitted.has("number")) admitted.add("integer");
	return admitted;
}

/** The single schema a value is conformed against below this one, when there is exactly one. */
function soleBranch(schema: Record<string, unknown>, valueType: JsonType): Record<string, unknown> {
	for (const key of ["anyOf", "oneOf"] as const) {
		const branches = schema[key];
		if (!Array.isArray(branches)) continue;
		const matching = branches.filter(
			(branch): branch is Record<string, unknown> =>
				isRecord(branch) && admittedTypes(branch)?.has(valueType) === true,
		);
		if (matching.length === 1) return matching[0];
	}
	return schema;
}

const DROP = Symbol("drop");

function conform(value: unknown, schema: unknown, depth: number): unknown {
	if (value === undefined || !isRecord(schema) || depth > MAX_DEPTH) return value;
	const valueType = jsonTypeOf(value);
	const admitted = admittedTypes(schema);
	if (admitted && valueType && !admitted.has(valueType)) {
		if (admitted.has("string") && (valueType === "number" || valueType === "integer" || valueType === "boolean")) {
			return String(value);
		}
		return DROP;
	}
	const shape = valueType ? soleBranch(schema, valueType) : schema;
	if (Array.isArray(value)) {
		const items = shape.items;
		if (!isRecord(items)) return value;
		let out: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const conformed = conform(value[index], items, depth + 1);
			if (conformed === value[index] && out === undefined) continue;
			out ??= value.slice(0, index);
			if (conformed !== DROP) out.push(conformed);
		}
		return out ?? value;
	}
	if (isRecord(value)) {
		const properties = shape.properties;
		if (!isRecord(properties)) return value;
		let out: Record<string, unknown> | undefined;
		for (const key of Object.keys(value)) {
			const conformed = conform(value[key], properties[key], depth + 1);
			if (conformed === value[key]) continue;
			out ??= { ...value };
			if (conformed === DROP) delete out[key];
			else out[key] = conformed;
		}
		return out ?? value;
	}
	return value;
}

/**
 * `args` with every value the tool's schema does not admit conformed or dropped. Returns `args`
 * itself when nothing needed it, so a well-formed call costs no copy, and when there is no tool or its
 * schema cannot be read, because then there is nothing to conform against.
 */
export function displayArguments(tool: AnyAgentTool | undefined, args: unknown): unknown {
	if (!tool?.parameters || !isRecord(args)) return args;
	let schema: Record<string, unknown>;
	try {
		schema = toolWireSchema(tool as unknown as Tool);
	} catch {
		return args;
	}
	const conformed = conform(args, schema, 0);
	return conformed === DROP ? {} : conformed;
}
