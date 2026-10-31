/**
 * WHY. A compiled build stores the wire form of each tool schema it computes, and a later launch of
 * that build sends the stored form instead of building the schema. A stored form is correct only for
 * the build that computed it: a form served to another build, from a file written under another store
 * version, or under an id another schema also uses, sends a model a schema the tool does not validate.
 *
 * THE CLASS. The store's read and write paths through `createToolSchema`: the same build reads its own
 * entries without building; another build, another store version and an unreadable file are each
 * ignored and replaced; a launch with no build id writes nothing; two processes of one build keep each
 * other's entries; a second builder under a declared id throws. And `toolWireSchema`, which sends a
 * supplied wire form only while `parameters` is an accessor, so a copy that replaced `parameters` never
 * sends the form it copied.
 *
 * WHAT IT DOES NOT CATCH. Whether each built-in tool supplies the form its own `parameters` produce;
 * that sweep is `every-builtin-tool-sends-the-wire-schema-its-parameters-produce.test.ts` in
 * `packages/coding-agent`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool } from "@veyyon/ai";
import { type } from "@veyyon/ai/utils/schema/arktype";
import {
	createToolSchema,
	createToolWireSchemaStore,
	type ToolWireSchemaStore,
	toolSchema,
} from "@veyyon/ai/utils/schema/tool-schema";
import { parametersWireSchema, toolWireSchema } from "@veyyon/ai/utils/schema/wire";

let dir = "";
let file = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-wire-schema-"));
	file = path.join(dir, "cache", "tool-wire-schemas.json");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A schema builder that counts its builds. */
function counted() {
	const builds = { count: 0 };
	const build = () => {
		builds.count += 1;
		return type({ path: type("string").describe("file to read"), "limit?": "number" });
	};
	return { builds, build };
}

const EXPECTED = parametersWireSchema(counted().build());

function storeOf(build: string | undefined): ToolWireSchemaStore {
	return createToolWireSchemaStore(build, () => file);
}

function readFile(): { version: unknown; build: unknown; entries: Record<string, unknown> } {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Compute and store `id` under build `build`, as an earlier launch does. */
function storeEarlier(build: string, id: string): void {
	const store = storeOf(build);
	void createToolSchema(store, id, counted().build).wire;
	store.save();
}

describe("a stored tool wire schema", () => {
	it("is read by a later launch of the same build without building the schema", () => {
		storeEarlier("build-a", "read");
		const { builds, build } = counted();
		const schema = createToolSchema(storeOf("build-a"), "read", build);
		expect(schema.wire).toEqual(EXPECTED);
		expect(builds.count).toBe(0);
	});

	it("is written once the task that computed it ends", async () => {
		const { builds, build } = counted();
		void createToolSchema(storeOf("build-a"), "read", build).wire;
		expect(builds.count).toBe(1);
		expect(fs.existsSync(file)).toBe(false);
		await Promise.resolve();
		expect(readFile().entries).toEqual({ read: EXPECTED });
	});

	const STALE_FILES: Record<string, (stale: Record<string, unknown>) => string> = {
		"another build": stale => JSON.stringify({ version: readFile().version, build: "build-b", entries: stale }),
		"another store version": stale => JSON.stringify({ version: 0, build: "build-a", entries: stale }),
		"a file that is not JSON": () => "{ not json",
		"a file whose entries are not an object": () =>
			JSON.stringify({ version: readFile().version, build: "build-a", entries: [] }),
	};

	for (const [name, contents] of Object.entries(STALE_FILES)) {
		it(`is ignored and replaced when it comes from ${name}`, () => {
			storeEarlier("build-a", "seed");
			fs.writeFileSync(file, contents({ read: { "x-stale": true } }));
			const { builds, build } = counted();
			const store = storeOf("build-a");
			const schema = createToolSchema(store, "read", build);
			expect(schema.wire).toEqual(EXPECTED);
			expect(builds.count).toBe(1);
			store.save();
			const written = readFile();
			expect(written.build).toBe("build-a");
			expect(written.entries).toEqual({ read: EXPECTED });
		});
	}

	it("is neither read nor written by a launch with no build id", async () => {
		storeEarlier("build-a", "read");
		fs.rmSync(file);
		for (const build of [undefined, ""]) {
			const counter = counted();
			expect(createToolSchema(storeOf(build), "read", counter.build).wire).toEqual(EXPECTED);
			expect(counter.builds.count).toBe(1);
		}
		await Promise.resolve();
		expect(fs.existsSync(file)).toBe(false);
	});

	it("keeps the entries another process of the same build wrote in the meantime", () => {
		const first = storeOf("build-a");
		const second = storeOf("build-a");
		void createToolSchema(second, "other", counted().build).wire;
		void createToolSchema(first, "read", counted().build).wire;
		first.save();
		second.save();
		expect(Object.keys(readFile().entries).sort()).toEqual(["other", "read"]);
	});

	it("is declared once per id: the same builder again is accepted, another builder throws", () => {
		const build = () => type({ id: "string" });
		const id = `test:declared-${process.pid}`;
		expect(toolSchema(id, build).id).toBe(id);
		expect(toolSchema(id, build).wire).toEqual(parametersWireSchema(build()));
		expect(() => toolSchema(id, () => type({ other: "string" }))).toThrow(`Tool schema id "${id}"`);
	});
});

describe("toolWireSchema", () => {
	const schema = type({ path: "string" });
	const supplied = { type: "object", properties: { supplied: { type: "string" } } };

	it("sends the supplied wire form while parameters is an accessor", () => {
		const tool: Tool = {
			name: "t",
			description: "",
			get parameters() {
				return schema;
			},
			wireParameters: supplied,
		};
		expect(toolWireSchema(tool)).toBe(supplied);
	});

	it("sends the replaced parameters, not the copied wire form, from a copy that replaced them", () => {
		const original: Tool = {
			name: "t",
			description: "",
			get parameters() {
				return schema;
			},
			wireParameters: supplied,
		};
		const replacement = type({ replaced: "number" });
		const copy: Tool = { ...original, parameters: replacement };
		expect(toolWireSchema(copy)).toEqual(parametersWireSchema(replacement));
	});
});
