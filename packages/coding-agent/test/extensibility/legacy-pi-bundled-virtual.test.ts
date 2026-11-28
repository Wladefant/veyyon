import { describe, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	__getLegacyPiBundledModulesGlobal,
	__synthesizeLegacyPiBundledSourceWithModules,
} from "@veyyon/coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@veyyon/utils";
import { resolveBundledPiExports } from "../../scripts/legacy-pi-virtual-module";

describe("legacy Pi export prepass", () => {
	it("includes the source position of a duplicate declaration", async () => {
		using scratch = TempDir.createSync("@veyyon-legacy-prepass-");
		const file = path.join(scratch.path(), "duplicate.ts");
		await writeFile(file, "export const repeated = 1;\nexport const repeated = 2;\n");

		await expect(resolveBundledPiExports([{ key: "fixture/duplicate", importSpecifier: file }], [])).rejects.toThrow(
			/duplicate\.ts:2:\d+: [^\n]*repeated/,
		);
	});

	it("keeps entries with overlapping export names separate and retains aliases", async () => {
		using scratch = TempDir.createSync("@veyyon-legacy-prepass-");
		const first = path.join(scratch.path(), "first.ts");
		const second = path.join(scratch.path(), "second.ts");
		await writeFile(first, "export const shared = 1;\nexport const firstOnly = 2;\n");
		await writeFile(second, "export const shared = 3;\nexport const secondOnly = 4;\n");
		const entries = [
			{ key: "fixture/first", importSpecifier: first },
			{ key: "fixture/second", importSpecifier: second },
			{ key: "fixture/alias", importSpecifier: first },
		];

		const modules = await resolveBundledPiExports(entries, []);
		expect(modules.map(module => ({ ...module, exports: module.exports?.toSorted() }))).toEqual([
			{ ...entries[0], exports: ["firstOnly", "shared"] },
			{ ...entries[1], exports: ["secondOnly", "shared"] },
			{ ...entries[2], exports: ["firstOnly", "shared"] },
		]);
	});
});

// Regression for issue #3423: Bun 1.3.14 made `--compile` extras unreachable
// via every filesystem-style API. The compat layer now routes canonical
// `@veyyon/*` imports through virtual modules backed by live host module
// references. The synthesizer must preserve every named/default export.
describe("legacy-pi bundled virtual module synthesizer (issue #3423)", () => {
	const modules = {
		"@veyyon/coding-agent": {
			VERSION: "16.1.17",
			defineTool: () => undefined,
			Type: { Object: () => undefined },
		},
		"@veyyon/utils": {
			isCompiledBinary: () => false,
			default: () => "default-export",
			VERSION: "16.1.17",
		},
		typebox: {
			Type: { Object: () => undefined },
		},
	};
	const globalKey = __getLegacyPiBundledModulesGlobal();

	it("emits one ES named export per enumerable namespace key", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/coding-agent", modules);
		expect(src).toContain(
			`const __veyyon_bundled = globalThis[${JSON.stringify(globalKey)}]["@veyyon/coding-agent"];`,
		);
		expect(src).toContain('export const VERSION = __veyyon_bundled["VERSION"];');
		expect(src).toContain('export const defineTool = __veyyon_bundled["defineTool"];');
		expect(src).toContain('export const Type = __veyyon_bundled["Type"];');
		// Every named export emerges from a live module lookup — never the FS.
		expect(src).not.toMatch(/\$bunfs|file:\/\//);
	});

	it("forwards `default` through `export default` so default imports survive", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/utils", modules);
		expect(src).toContain("export default __veyyon_bundled.default;");
		// Default and named exports coexist on the same module.
		expect(src).toContain('export const VERSION = __veyyon_bundled["VERSION"];');
		expect(src).toContain('export const isCompiledBinary = __veyyon_bundled["isCompiledBinary"];');
	});

	it("omits `default` line when the registered namespace has no default export", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/coding-agent", modules);
		expect(src).not.toContain("export default");
	});

	it("throws when asked to synthesize a key the bundled modules do not cover", () => {
		// The bundled registry is keyed on the canonical `@veyyon/*` package
		// names (see legacy-pi-virtual-module.ts: keys are `manifest.name/...`),
		// so the lookup — and the error — echo the requested key verbatim with no
		// `pi-` normalization (matched by the five passing cases above).
		expect(() => __synthesizeLegacyPiBundledSourceWithModules("@veyyon/not-bundled", modules)).toThrow(
			/no bundled module registered for @veyyon\/not-bundled/,
		);
	});

	it("addresses the same globalThis key the install function would stash to", () => {
		// The emitted source MUST read from the exact key the install function
		// writes to — a rename of either side breaks every legacy extension
		// load with a `Cannot read properties of undefined` at first import.
		const src = __synthesizeLegacyPiBundledSourceWithModules("typebox", modules);
		expect(src.startsWith(`const __veyyon_bundled = globalThis[${JSON.stringify(globalKey)}]["typebox"];`)).toBe(
			true,
		);
	});

	it("end-to-end: synthesized source resolves named bindings against a runtime globalThis entry", () => {
		// Evaluate the synthesized source in isolation. Bun's loader normally
		// turns it into an ES module; here we use `new Function` to exercise
		// the inner globalThis lookup + property-getter pattern in isolation —
		// it would `throw` if the emitted code addressed the wrong stash key
		// or skipped an enumerable export.
		Reflect.set(globalThis, globalKey, modules);
		try {
			const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/coding-agent", modules);
			// Strip the ES export prefix and run the body as a plain script so
			// we can read `__veyyon_bundled` from the returned closure.
			const body = src
				.split("\n")
				.filter(line => line.startsWith("const __veyyon_bundled"))
				.join("\n");
			const fn = new Function(`${body}; return __veyyon_bundled;`);
			const live: unknown = fn();
			if (typeof live !== "object" || live === null) {
				throw new Error("synthetic module did not resolve an object namespace");
			}
			expect("VERSION" in live ? live.VERSION : undefined).toBe("16.1.17");
			expect(typeof ("defineTool" in live ? live.defineTool : undefined)).toBe("function");
			expect(typeof ("Type" in live ? live.Type : undefined)).toBe("object");
		} finally {
			Reflect.deleteProperty(globalThis, globalKey);
		}
	});
});
