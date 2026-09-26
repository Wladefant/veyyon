/**
 * WHY. A transcript draws each tool call from the arguments the model sent, as recorded, not from the
 * arguments the validator accepted. A model that searched for `404` sent `input: 404`, a number where
 * the schema says string. The search card put that value into its description, the terminal drawer
 * called a string method on it, and every resume of that session printed
 * `tool "search" call renderer threw: TypeError: e.toWellFormed is not a function` in place of the card.
 *
 * The class this closes: an argument of the wrong JSON type makes a card throw. The variant space is
 * read from the registry at run time: every builtin tool the session builds, every slot its wire schema
 * declares (top-level properties, nested object properties and array items, three levels down), and
 * every JSON type that slot does not admit. A tool, property or nested field added later is covered the
 * day it lands.
 *
 * What this suite does NOT catch: a card drawn with no tool instance (a transcript naming a tool this
 * session did not build), which has no schema to conform against; a tool a setting gates out of this
 * session; and a card that draws a wrong-typed argument without throwing but shows something unreadable.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool } from "@veyyon/ai";
import { toolWireSchema } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { createTools } from "@veyyon/coding-agent/tools";
import { displayArguments } from "@veyyon/coding-agent/presentation/display-arguments";
import type { Component, TUI } from "@veyyon/tui";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { createToolExecution } from "../helpers/tool-execution";
import { makeToolSession } from "../helpers/tool-session";

type Schema = {
	type?: string | string[];
	enum?: unknown[];
	const?: unknown;
	properties?: Record<string, Schema>;
	items?: Schema;
	anyOf?: Schema[];
	oneOf?: Schema[];
};

/** Where a value sits in the arguments: property names and array indices. */
type Slot = { path: (string | number)[]; schema: Schema };

const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

/** One value of every JSON type, so each slot is tried with every type it does not admit. */
const VALUES_BY_TYPE: Record<string, unknown> = {
	string: "x",
	number: 404.5,
	integer: 7,
	boolean: true,
	array: ["x", 1],
	object: { nested: 1 },
	null: null,
};

const MAX_DEPTH = 3;

function branches(schema: Schema): Schema[] {
	return [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
}

/** The JSON types a slot admits, or undefined when its schema states none. */
function admitted(schema: Schema): Set<string> | undefined {
	const types = new Set<string>();
	if (typeof schema.type === "string") types.add(schema.type);
	if (Array.isArray(schema.type)) for (const type of schema.type) types.add(type);
	for (const value of [...(schema.enum ?? []), ...(schema.const === undefined ? [] : [schema.const])]) {
		types.add(value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
	}
	for (const branch of branches(schema)) {
		const inner = admitted(branch);
		if (!inner) return undefined;
		for (const type of inner) types.add(type);
	}
	if (types.size === 0) return undefined;
	if (types.has("number")) types.add("integer");
	return types;
}

/** The object or array shape of a slot: itself, or its one branch of that kind. */
function shapeOf(schema: Schema, kind: "object" | "array"): Schema | undefined {
	const has = (s: Schema) => (kind === "object" ? s.properties !== undefined : s.items !== undefined);
	if (has(schema)) return schema;
	const matching = branches(schema).filter(has);
	return matching.length === 1 ? matching[0] : undefined;
}

/** A well-typed value for a slot, so the one wrong-typed value is the only thing wrong. */
function wellTyped(schema: Schema, depth = 0): unknown {
	if (schema.const !== undefined) return schema.const;
	if (schema.enum?.length) return schema.enum[0];
	const object = shapeOf(schema, "object");
	if (object && depth < MAX_DEPTH) {
		return Object.fromEntries(
			Object.entries(object.properties ?? {}).map(([key, inner]) => [key, wellTyped(inner, depth + 1)]),
		);
	}
	const array = shapeOf(schema, "array");
	if (array?.items && depth < MAX_DEPTH) return [wellTyped(array.items, depth + 1)];
	const first = branches(schema)[0];
	if (schema.type === undefined && first) return wellTyped(first, depth);
	const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
	return type === undefined ? "x" : VALUES_BY_TYPE[type];
}

/** Every slot a schema declares, down to {@link MAX_DEPTH}. Array items are addressed at index 0. */
function slots(schema: Schema, prefix: (string | number)[] = []): Slot[] {
	if (prefix.length > MAX_DEPTH) return [];
	const found: Slot[] = [];
	const object = shapeOf(schema, "object");
	for (const [key, inner] of Object.entries(object?.properties ?? {})) {
		found.push({ path: [...prefix, key], schema: inner }, ...slots(inner, [...prefix, key]));
	}
	const array = shapeOf(schema, "array");
	if (array?.items) found.push({ path: [...prefix, 0], schema: array.items }, ...slots(array.items, [...prefix, 0]));
	return found;
}

function withValueAt(root: unknown, slotPath: (string | number)[], value: unknown): unknown {
	const copy = structuredClone(root) as Record<string | number, unknown>;
	let cursor = copy;
	for (const key of slotPath.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
	cursor[slotPath[slotPath.length - 1] as string | number] = value;
	return copy;
}

function flatten(component: Component): string {
	return component
		.render(160)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.join(" ");
}

describe("a tool card drawing a call whose arguments have the wrong type", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir = "";
	let tools: Tool[] = [];

	beforeAll(async () => {
		await initTheme();
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wrong-typed-args-"));
		tools = await createTools(
			makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getArtifactsDir: () => path.join(tmpDir, "artifacts"),
				allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
				settings: Settings.isolated({}),
				enableLsp: false,
				skipPythonPreflight: true,
				getPlanModeState: () => ({ enabled: false }),
			}),
		);
	});

	afterAll(async () => {
		restoreSettingsTestState(settingsState);
		if (tmpDir) await removeWithRetries(tmpDir);
	});

	function draw(tool: Tool, args: unknown, phase: "call" | "result"): string {
		const component = createToolExecution(tool.name, args, {}, tool as never, ui, tmpDir, "call-1");
		if (phase === "result") component.updateResult({ content: [{ type: "text", text: "done" }] }, false, "call-1");
		try {
			return flatten(component);
		} catch (error) {
			return `render threw: ${String(error)}`;
		}
	}

	it("covers the tools every turn depends on, including nested slots", () => {
		const names = tools.map(tool => tool.name);
		for (const required of ["read", "write", "edit", "bash", "search"]) expect(names).toContain(required);
		// A sweep that never reaches below the top level would pass while a nested field still crashes.
		const nested = tools.flatMap(tool => slots(toolWireSchema(tool) as Schema).filter(slot => slot.path.length > 1));
		expect(nested.length).toBeGreaterThan(0);
	});

	it("draws every such call without a renderer failure", () => {
		const failures: string[] = [];
		for (const tool of tools) {
			const schema = toolWireSchema(tool) as Schema;
			const baseline = wellTyped(schema);
			for (const slot of slots(schema)) {
				const types = admitted(slot.schema);
				if (!types) continue;
				for (const [type, value] of Object.entries(VALUES_BY_TYPE)) {
					if (types.has(type)) continue;
					const args = withValueAt(baseline, slot.path, value);
					for (const phase of ["call", "result"] as const) {
						const threw = /render(?:er)? threw:? ([^—]*)/.exec(draw(tool, args, phase));
						if (threw)
							failures.push(`${tool.name}.${slot.path.join(".")}=${type} (${phase}): ${threw[1]?.trim()}`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
	});

	it("shows a number sent where the schema asks for text as that text", () => {
		const search = tools.find(tool => tool.name === "search");
		expect(search).toBeDefined();
		const drawn = draw(search as Tool, { type: "text", input: 404, path: "src" }, "call");
		expect(drawn).not.toContain("renderer threw");
		expect(drawn).toContain("404");
	});

	it("conforms a copy and leaves the arguments the transcript records as the model sent them", () => {
		const search = tools.find(tool => tool.name === "search") as never;
		const recorded = { type: "text", input: 404, path: { dir: "src" } };
		const sent = structuredClone(recorded);

		expect(displayArguments(search, recorded)).toEqual({ type: "text", input: "404" });
		expect(recorded).toEqual(sent);

		const wellFormed = { type: "text", input: "404", path: "src" };
		expect(displayArguments(search, wellFormed)).toBe(wellFormed);
	});
});
