/**
 * Tool specs as they go on the wire: each tool's wire schema with the `i` intent field injected per its intent mode,
 * its description with rendered examples, and the reverse step that strips `i` back out of a call's arguments.
 */

import type { Context, Tool, TSchema } from "@veyyon/ai";
import { type Dialect, renderToolExamples } from "@veyyon/ai/dialect";
import { stripSchemaDescriptions, toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { internString, isRecord } from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import type { AgentContext, AgentTool, AnyAgentTool } from "./types";

const INTENT_FIELD_DESCRIPTION = "concise intent";
const INTENT_SCHEMA_UNION_KEYS = ["anyOf", "oneOf"] as const;

function injectIntentIntoSchema(
	schema: unknown,
	mode: "require" | "optional" = "require",
	describeIntent = true,
): unknown {
	if (!isRecord(schema)) return schema;
	const propertiesValue = schema.properties;
	const hasOwnProperties = isRecord(propertiesValue);
	if (!hasOwnProperties) {
		const union = injectIntentIntoUnionBranches(schema, mode, describeIntent);
		if (union) return union;
	}

	const properties = hasOwnProperties ? propertiesValue : {};
	const requiredValue = schema.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) return leadWithExistingIntent(schema, properties, required, mode);
	return {
		...schema,
		properties: {
			[INTENT_FIELD]: describeIntent
				? { type: "string", description: INTENT_FIELD_DESCRIPTION }
				: { type: "string" },
			...properties,
		},
		...(mode === "require" ? { required: required.concat(INTENT_FIELD) } : {}),
	};
}

/**
 * A pure union root (anyOf/oneOf with no own properties) with `i` pushed into each alternative branch, so each closed
 * shape keeps `additionalProperties: false` honest with intent tracing; `undefined` when the root has no union key.
 *
 * Adding a sibling root `properties: { i }` / `required: [i]` would force every input to satisfy both root *and* a
 * branch, leaving no satisfiable shape because each branch's `additionalProperties: false` rejects every other field —
 * and OpenAI strict sanitization later promotes that sibling to a closed root `type: "object"` that rejects every
 * non-`i` key outright. allOf is not alternation (its members are sub-constraints), so it is not recursed into.
 */
function injectIntentIntoUnionBranches(
	schema: Record<string, unknown>,
	mode: "require" | "optional",
	describeIntent: boolean,
): Record<string, unknown> | undefined {
	for (const key of INTENT_SCHEMA_UNION_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		return {
			...schema,
			[key]: variants.map(variant => injectIntentIntoSchema(variant, mode, describeIntent)),
		};
	}
	return undefined;
}

/**
 * `schema` with its existing `i` property moved first and, under `require`, listed in `required`; `schema` itself
 * when both already hold.
 */
function leadWithExistingIntent(
	schema: Record<string, unknown>,
	properties: Record<string, unknown>,
	required: string[],
	mode: "require" | "optional",
): Record<string, unknown> {
	const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
	const needsRequired = mode === "require" && !required.includes(INTENT_FIELD);
	if (!needsReorder && !needsRequired) return schema;
	const { [INTENT_FIELD]: intentProp, ...rest } = properties;
	return {
		...schema,
		...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
		...(needsRequired ? { required: required.concat(INTENT_FIELD) } : {}),
	};
}

/**
 * Cross-request cache for {@link normalizeTools} (P7, BACKLOG perf hotspots).
 * `toolWireSchema`/`stripSchemaDescriptions` are already stamped per-tool (see
 * `@veyyon/ai/utils/schema/stamps`), so the expensive schema conversion
 * itself is not repeated — but every call still re-runs the outer `.map()`
 * (object spreads, `injectIntentIntoSchema`, `renderToolExamples`) even when
 * `tools` and the flags are unchanged. Callers like `StablePrefix.build` in
 * `append-only-context.ts` and `Agent#buildSideRequestContext` invoke this
 * with the SAME `tools` array reference on every turn/request, so keying a
 * single-slot cache off that array identity (invalidated whenever the flags
 * change) skips the whole rebuild. Keyed on the array, not the session, since
 * that's the actual stable+shared reference across call sites.
 */
const normalizedToolsCache = new WeakMap<
	NonNullable<AgentContext["tools"]>,
	{ key: string; result: Context["tools"] }
>();

// Overloads: a defined tool list normalizes to a defined tool list (the body only
// returns `undefined` for a falsy input), so callers passing a real array do not
// have to null-check the result.
export function normalizeTools(
	tools: NonNullable<AgentContext["tools"]>,
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions?: boolean,
): NonNullable<Context["tools"]>;
export function normalizeTools(
	tools: AgentContext["tools"],
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions?: boolean,
): Context["tools"];
export function normalizeTools(
	tools: AgentContext["tools"],
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions = false,
): Context["tools"] {
	if (!tools) return tools;
	injectIntent = injectIntent && Bun.env.VEYYON_NO_INTENT !== "1";
	const cacheKey = `${injectIntent}|${exampleDialect ?? ""}|${pruneDescriptions}`;
	const cached = normalizedToolsCache.get(tools);
	if (cached && cached.key === cacheKey) return cached.result;
	// Drop null/undefined/non-object slots so a bad registry entry cannot
	// TypeError mid-map (adversarial / partial tool lists).
	const valid = tools.filter(
		(t): t is NonNullable<(typeof tools)[number]> =>
			t !== null && t !== undefined && typeof t === "object" && typeof (t as { name?: unknown }).name === "string",
	);
	const result = valid.map(t => normalizeTool(t, injectIntent, exampleDialect, pruneDescriptions));
	normalizedToolsCache.set(tools, { key: cacheKey, result });
	return result;
}

/** One tool as it goes on the wire: its wire schema, with `i` injected per the tool's intent mode, and its description. */
function normalizeTool(
	tool: AnyAgentTool,
	injectIntent: boolean,
	exampleDialect: Dialect | undefined,
	pruneDescriptions: boolean,
): Tool {
	const intentMode = resolveIntentMode(tool.intent);
	const doInjectIntent = injectIntent && intentMode !== "omit";
	const spec = specWithoutSchema(tool);
	// When the full catalog is rendered into the system prompt, ship the tool
	// specs without their descriptions (top-level + nested schema annotations)
	// so they are not duplicated on the wire. Strip the STABLE wire schema (the
	// memoized `stripSchemaDescriptions` result is reused across requests), then
	// re-inject `i` (without its hint, which `describeIntent: false` omits) so
	// intent tracing keeps the field while no descriptions ride the wire.
	if (pruneDescriptions) {
		let parameters = stripSchemaDescriptions(toolWireSchema(tool)) as TSchema;
		if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode, false) as TSchema;
		return { ...spec, parameters, description: "" } as Tool;
	}
	let parameters = toolWireSchema(tool) as TSchema;
	if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode) as TSchema;
	const description = tool.description ?? "";
	const examplesBlock = exampleDialect
		? renderToolExamples({ ...spec, parameters } as Tool, exampleDialect, doInjectIntent ? INTENT_FIELD : undefined)
		: "";
	// Every agent normalizes its own tool list, so an appended examples block would otherwise
	// leave one copy of each description per live agent.
	const finalDescription = examplesBlock ? internString(`${description}\n\n${examplesBlock}`) : description;
	return { ...spec, parameters, description: finalDescription } as Tool;
}

/**
 * The own enumerable properties of `tool` a spread copies, without `parameters` and `wireParameters`.
 *
 * A wrapped tool forwards every property through an enumerable accessor, so spreading it reads
 * `parameters`, which builds the schema the caller is about to replace with its wire form.
 */
function specWithoutSchema(tool: AnyAgentTool): Record<PropertyKey, unknown> {
	const spec: Record<PropertyKey, unknown> = {};
	for (const key of Reflect.ownKeys(tool)) {
		if (key === "parameters" || key === "wireParameters") continue;
		if (!Object.prototype.propertyIsEnumerable.call(tool, key)) continue;
		spec[key] = (tool as unknown as Record<PropertyKey, unknown>)[key];
	}
	return spec;
}

function resolveIntentMode(intent: AgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return "require";
}

export function extractIntent(args: Record<string, unknown>): {
	intent?: string;
	strippedArgs: Record<string, unknown>;
} {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}
