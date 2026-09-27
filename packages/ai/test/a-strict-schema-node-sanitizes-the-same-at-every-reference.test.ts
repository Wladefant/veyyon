/**
 * WHY: `sanitizeSchemaForStrictMode` memoizes each node it visits so a shared subgraph is
 * sanitized once and a cycle terminates. A `nullable: true` node was cached as its inner,
 * non-null form while the first reference received the `anyOf: [T, null]` wrapper, so a
 * node referenced twice lost its null branch at the second reference: the strict schema
 * depended on whether the caller reused one object or wrote two equal ones.
 *
 * The class this suite closes: any rewrite whose result differs from the node the cache
 * holds. Every rewrite form the sanitizer applies is placed twice under every container
 * it recurses into, and the result must equal sanitizing the same schema with the two
 * references written out as separate objects. The combinator containers are read from
 * `COMBINATOR_KEYS`, so a new combinator is swept without an edit here.
 *
 * Not caught: a rewrite form missing from `REWRITE_FORMS` below. The forms mirror the
 * branches of the sanitizer (`$ref` with siblings, single `allOf`, `type` arrays, `const`,
 * `default`, `nullable`), which are code paths rather than an enumerable table.
 */
import { describe, expect, it } from "bun:test";
import { COMBINATOR_KEYS, sanitizeSchemaForStrictMode } from "@veyyon/ai/utils/schema";

type Schema = Record<string, unknown>;

/** Carries keywords strict mode strips, so an unsanitized copy of it never equals its sanitized form. */
const LEAF_DEF: Schema = {
	type: "object",
	properties: { id: { type: "string", format: "uuid" } },
	required: ["id"],
	additionalProperties: true,
};

const REWRITE_FORMS: Record<string, () => Schema> = {
	"nullable scalar with a description": () => ({ type: "string", nullable: true, description: "a name" }),
	"nullable scalar": () => ({ type: "integer", nullable: true }),
	"nullable object": () => ({ type: "object", properties: { x: { type: "string" } }, nullable: true }),
	"nullable const": () => ({ const: "only", nullable: true }),
	"type array": () => ({ type: ["string", "null"], description: "maybe" }),
	const: () => ({ const: "only" }),
	"type array its enum narrows to one type": () => ({
		type: ["string", "integer"],
		enum: ["a", 1.5],
		description: "d",
	}),
	"default folded into the description": () => ({ type: "string", description: "mode", default: "fast" }),
	"single allOf": () => ({ allOf: [{ type: "string", nullable: true }], description: "wrapped" }),
	"$ref with a sibling": () => ({ $ref: "#/$defs/Leaf", description: "a leaf" }),
	plain: () => ({ type: "boolean" }),
};

/** Each container places the node twice, alongside the `$defs` the `$ref` form resolves against. */
const CONTAINERS: Record<string, (node: Schema) => Schema> = {
	properties: node => ({ type: "object", properties: { a: node, b: node } }),
	"items tuple": node => ({ type: "array", items: [node, node] }),
	prefixItems: node => ({ type: "array", prefixItems: [node, node] }),
	"property and items": node => ({
		type: "object",
		properties: { a: node, list: { type: "array", items: node } },
	}),
	$defs: node => ({ type: "object", properties: {}, $defs: { A: node, B: node } }),
	definitions: node => ({ type: "object", properties: {}, definitions: { A: node, B: node } }),
	...Object.fromEntries(
		COMBINATOR_KEYS.map(key => [key, (node: Schema): Schema => ({ [key]: [node, { type: "number" }, node] })]),
	),
};

function withLeafDefs(root: Schema): Schema {
	const defs = (root.$defs as Schema | undefined) ?? {};
	return { ...root, $defs: { ...defs, Leaf: LEAF_DEF } };
}

describe("a strict-mode schema node sanitizes the same at every reference", () => {
	for (const [formName, form] of Object.entries(REWRITE_FORMS)) {
		for (const [containerName, container] of Object.entries(CONTAINERS)) {
			it(`${formName} placed twice under ${containerName}`, () => {
				const shared = withLeafDefs(container(form()));
				const separate = withLeafDefs(JSON.parse(JSON.stringify(shared)) as Schema);
				expect(sanitizeSchemaForStrictMode(shared)).toEqual(sanitizeSchemaForStrictMode(separate));
			});
		}
	}

	it("a nullable node that references itself resolves to its nullable form", () => {
		const node: Schema = { type: "object", properties: {} as Schema, nullable: true, description: "a tree" };
		(node.properties as Schema).child = node;
		const sanitized = sanitizeSchemaForStrictMode(node);
		expect(sanitized.description).toBe("a tree");
		const [inner, nullBranch] = sanitized.anyOf as [Schema, Schema];
		expect(nullBranch).toEqual({ type: "null" });
		expect(inner.description).toBeUndefined();
		expect((inner.properties as Schema).child).toBe(sanitized);
	});
});
