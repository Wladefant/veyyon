/**
 * Child-process half of `every-builtin-tool-sends-the-wire-schema-its-parameters-produce.test.ts`.
 *
 * The parent sets `VEYYON_BUILD_ID` and a scratch home, so every tool schema reads and stores its wire
 * form through the store a compiled build uses. This constructs every built-in and hidden tool under
 * each settings variant that selects a different schema, compares the wire form each tool supplies
 * with the one its `parameters` produce, and prints one JSON report on stdout.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parametersWireSchema, toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { getToolWireSchemaCachePath } from "@veyyon/utils/dirs";
import type { SettingPath } from "../../src/config/settings";
import { EVAL_LANGUAGE_ORDER, type EvalLanguageToken } from "../../src/tools/shell/eval";
import { EDIT_MODES } from "../../src/utils/edit-mode";
import { visitEveryFirstPartyTool } from "../helpers/every-first-party-tool";

export interface WireSchemaSweepReport {
	/** Tools that supply `wireParameters`, by name. */
	suppliers: string[];
	/** Tools that supply none, by name. */
	nonSuppliers: string[];
	/** Factories that returned no tool in every variant. */
	unbuilt: string[];
	/** `variant/tool: what differs` for each tool whose supplied wire form is not its parameters'. */
	mismatches: string[];
	/** The store file, and the ids it holds once the sweep ends. */
	storeFile: string;
	storedIds: string[];
}

type Overrides = Partial<Record<SettingPath, unknown>>;

const EVAL_SETTING: Record<EvalLanguageToken, SettingPath> = {
	py: "eval.py",
	js: "eval.js",
	rb: "eval.rb",
	jl: "eval.jl",
};

/** Every non-empty subset of the eval languages, as settings. */
function evalVariants(): [string, Overrides][] {
	const variants: [string, Overrides][] = [];
	for (let mask = 1; mask < 1 << EVAL_LANGUAGE_ORDER.length; mask++) {
		const overrides: Overrides = {};
		const on = EVAL_LANGUAGE_ORDER.filter((_, bit) => (mask & (1 << bit)) !== 0);
		for (const lang of EVAL_LANGUAGE_ORDER) overrides[EVAL_SETTING[lang]] = on.includes(lang);
		variants.push([`eval=${on.join(",")}`, overrides]);
	}
	return variants;
}

/** Each setting that selects a tool's schema, at each value that selects a different one. */
const VARIANTS: [string, Overrides][] = [
	["default", {}],
	...EDIT_MODES.map((mode): [string, Overrides] => [`edit=${mode}`, { "edit.mode": mode }]),
	...[true, false].flatMap(batch =>
		["none", "auto"].flatMap(isolation =>
			[true, false].map((async): [string, Overrides] => [
				`batch=${batch},isolation=${isolation},async=${async}`,
				{ "agent.batch": batch, "agent.isolation.mode": isolation, "async.enabled": async },
			]),
		),
	),
	...evalVariants(),
];

/** JSON text with object keys sorted, so key order does not count as a difference. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner !== null && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
			: inner,
	);
}

async function sweep(): Promise<WireSchemaSweepReport> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wire-schema-sweep-"));
	const suppliers = new Set<string>();
	const nonSuppliers = new Set<string>();
	const mismatches: string[] = [];
	let unbuilt: string[] | undefined;
	try {
		for (const [variant, overrides] of VARIANTS) {
			const missing = await visitEveryFirstPartyTool(
				dir,
				tool => {
					const supplied = tool.wireParameters;
					if (supplied === undefined) {
						nonSuppliers.add(tool.name);
						return;
					}
					suppliers.add(tool.name);
					const expected = canonical(parametersWireSchema(tool.parameters));
					if (canonical(supplied) !== expected) mismatches.push(`${variant}/${tool.name}: wireParameters`);
					else if (canonical(toolWireSchema(tool)) !== expected)
						mismatches.push(`${variant}/${tool.name}: toolWireSchema`);
				},
				overrides,
			);
			unbuilt = unbuilt === undefined ? missing : unbuilt.filter(name => missing.includes(name));
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
	// The store writes once the task that put an entry ends.
	await new Promise(resolve => setTimeout(resolve, 0));
	const storeFile = getToolWireSchemaCachePath();
	let storedIds: string[] = [];
	try {
		const stored = JSON.parse(await fs.readFile(storeFile, "utf8")) as { entries?: Record<string, unknown> };
		storedIds = Object.keys(stored.entries ?? {}).sort();
	} catch {}
	return {
		suppliers: [...suppliers].sort(),
		nonSuppliers: [...nonSuppliers].sort(),
		unbuilt: unbuilt ?? [],
		mismatches,
		storeFile,
		storedIds,
	};
}

process.stdout.write(`${JSON.stringify(await sweep())}\n`);
process.exit(0);
