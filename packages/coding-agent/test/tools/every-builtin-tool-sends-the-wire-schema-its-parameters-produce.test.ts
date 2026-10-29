/**
 * WHY. A request carries a tool's `wireParameters`, the JSON Schema a compiled build stores in the
 * profile's wire-schema cache so a later launch need not build the tool's arktype `parameters`. A call
 * is still validated against `parameters`. A tool whose two getters select different schemas (one
 * reads another mode's holder), or two schemas declared under one id (a runtime input missing from
 * the id), sends the model one schema and validates against another, and the cache serves the wrong
 * one for the life of the build.
 *
 * THE CLASS. The fixture constructs every built-in and hidden tool from the factory tables, under each
 * setting value that selects a different schema: each edit mode, each subset of eval languages, task
 * batch and isolation, bash async. It runs in a child process with a build id, so every wire form is
 * stored and read the way a compiled build does. Each supplied wire form must equal the one its
 * `parameters` produce. A tool that supplies none fails the suite until it is recorded below, and a
 * factory the fixture cannot construct fails it too.
 *
 * WHAT IT DOES NOT CATCH. A schema input no variant changes: a setting added later that selects a
 * schema needs a variant in the fixture. The store's rejection of a stale version or a corrupt file
 * is `tool-schema.test.ts` in `packages/ai`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WireSchemaSweepReport } from "../fixtures/builtin-tool-wire-schemas";

const FIXTURE = path.join(import.meta.dirname, "../fixtures/builtin-tool-wire-schemas.ts");

/** Tools that compute their wire form from `parameters` on every launch. */
const COMPUTED_EACH_LAUNCH = ["report_tool_issue", "yield"];

let home = "";

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "wire-schema-home-"));
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

/** Run the sweep as a launch of build `build` whose profile lives under {@link home}. */
function sweep(build: string): WireSchemaSweepReport {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("VEYYON_") || key.startsWith("XDG_")) continue;
		env[key] = value;
	}
	env.HOME = home;
	env.VEYYON_BUILD_ID = build;
	const run = spawnSync(process.execPath, [FIXTURE], {
		cwd: import.meta.dirname,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	expect(run.stderr).toBe("");
	expect(run.status).toBe(0);
	const report = JSON.parse(run.stdout) as WireSchemaSweepReport;
	expect(report.storeFile.startsWith(home)).toBe(true);
	return report;
}

/** Mark every stored wire form, so a launch that sends one sends it changed. */
function markStoredForms(storeFile: string): void {
	const stored = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
		schemas: Record<string, Record<string, unknown>>;
	};
	for (const wire of Object.values(stored.schemas)) wire["x-marked"] = true;
	fs.writeFileSync(storeFile, JSON.stringify(stored));
}

function toolsIn(mismatches: string[]): string[] {
	return [...new Set(mismatches.map(entry => entry.slice(entry.indexOf("/") + 1, entry.indexOf(":"))))].sort();
}

describe("every built-in tool's wire schema", () => {
	it("is supplied by every tool but the ones recorded here", () => {
		const report = sweep("build-a");
		expect(report.unbuilt).toEqual([]);
		expect(report.nonSuppliers).toEqual(COMPUTED_EACH_LAUNCH);
		expect(report.suppliers.filter(name => COMPUTED_EACH_LAUNCH.includes(name))).toEqual([]);
	});

	it("equals the schema its parameters produce, on the launch that stores it and on the one that reads it", () => {
		const cold = sweep("build-a");
		expect(cold.mismatches).toEqual([]);
		const warm = sweep("build-a");
		expect(warm.mismatches).toEqual([]);
		expect(warm.storedIds).toEqual(cold.storedIds);
	});

	it("is read from the store by the next launch of the same build, for every tool that supplies one", () => {
		const cold = sweep("build-a");
		markStoredForms(cold.storeFile);
		const warm = sweep("build-a");
		expect(toolsIn(warm.mismatches)).toEqual(cold.suppliers);
	});

	it("is never read from the store by another build", () => {
		const cold = sweep("build-a");
		markStoredForms(cold.storeFile);
		const other = sweep("build-b");
		expect(other.mismatches).toEqual([]);
		expect(other.storedIds).toEqual(cold.storedIds);
		expect(JSON.parse(fs.readFileSync(other.storeFile, "utf8")).build).toBe("build-b");
	});
});
