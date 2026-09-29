/**
 * WHY THIS SUITE EXISTS.
 *
 * THE DEFECT IT CLOSES. `export/share.ts` imported `buildSessionData` from `export/html`, which
 * text-imports the HTML export template, its stylesheet, its viewer script and the 369 KiB React
 * tool renderers. The builtin `/share` command and the interactive command controller import
 * `export/share`, so every interactive session held those strings and the export module's code on
 * its heap (1.9 MiB of heap and extra memory at idle) for an `/export` or `/share` nobody typed.
 *
 * THE CLASS. A first-party file that is not TypeScript and is larger than 16 KiB (an embedded
 * template, a generated bundle, a data table) is in the import graph of an idle interactive session
 * only when the first frame needs it. That graph is the CLI entry's plus the interactive mode's,
 * which `main.ts` loads through a dynamic import every interactive launch takes. The sweep reads
 * both graphs at run time, so a new asset, or a new static edge to an existing one, turns this red
 * until the list below records it.
 *
 * WHAT IT DOES NOT CATCH. A TypeScript module that inlines a large string literal, a string defined
 * at build time (`process.env.VEYYON_DOCS_EMBED`), and an asset a live session loads after startup.
 * The package-level half of the same class is `a-dependency-nobody-reached-does-not-load-at-startup`.
 */
import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildStartupImportGraph } from "./helpers/startup-import-graph";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const SRC = join(REPO_ROOT, "packages", "coding-agent", "src");
const ENTRIES = [join(SRC, "main.ts"), join(SRC, "modes", "terminal", "interactive-mode.ts")];
const ASSET_LIMIT_BYTES = 16 * 1024;

/**
 * Large non-TypeScript files the first frame reads. `models.json` is the bundled model catalog the
 * model registry resolves before the first prompt; `loader-state.js` is the native addon loader;
 * `package.json` supplies the version the banner prints; `emojis.json` is the table the composer's
 * `:` completion reads on the first keystroke.
 */
const LARGE_ASSETS_AT_STARTUP = [
	"natives/bridge/bindings/native/loader-state.js",
	"packages/catalog/src/models.json",
	"packages/coding-agent/package.json",
	"packages/coding-agent/src/modes/terminal/data/emojis.json",
];

const graphs = ENTRIES.map(entry => buildStartupImportGraph(REPO_ROOT, entry));
const files = new Set(graphs.flatMap(graph => [...graph.files]));

describe("startup import graph assets", () => {
	test("holds no large asset outside the recorded set", () => {
		const large = [...files]
			.filter(file => file.startsWith("/") && !/\.tsx?$/.test(file))
			.filter(file => statSync(file).size > ASSET_LIMIT_BYTES)
			.map(file => relative(REPO_ROOT, file))
			.sort();
		expect(large).toEqual(LARGE_ASSETS_AT_STARTUP);
	});

	test("keeps the HTML export template out of a session that never exports", () => {
		const exportDir = join(REPO_ROOT, "packages", "coding-agent", "src", "export", "html");
		const loaded = [...files].filter(file => file.startsWith(`${exportDir}/`)).map(file => relative(REPO_ROOT, file));
		expect(loaded).toEqual([]);
	});

	test("walks both entries to completion", () => {
		for (const graph of graphs) {
			expect(graph.unscannable).toEqual([]);
			expect(graph.files.size).toBeGreaterThan(1_000);
		}
	});
});
