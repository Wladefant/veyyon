/**
 * WHY: fast-xml-parser leaves the total number of entity expansions uncapped by default, so an Office
 * part that references an entity millions of times expands without bound. The xlsx, pptx and epub
 * converters each built their own parser with a cap of 1,000,000; a converter that built one without
 * the option would parse such a part to the end. They now share `createMarkitXmlParser`, and this suite
 * pins the cap at the parser and through each XML converter on the first part it reads.
 *
 * Not caught: a new XML converter that builds its own parser; the sweep below names the three that
 * exist, so a fourth needs a row here.
 */
import { describe, expect, it } from "bun:test";
import { Markit } from "@veyyon/coding-agent/export/markit";
import { createMarkitXmlParser } from "@veyyon/coding-agent/export/markit/converters/xml-text";
import { zip } from "@veyyon/coding-agent/utils/zip";

const CAP = 1_000_000;

function expansions(count: number): string {
	return `<?xml version="1.0"?><a>${"&amp;".repeat(count)}</a>`;
}

describe("the markit XML parser", () => {
	it(`performs ${CAP} entity expansions and fails on the next one`, () => {
		const parsed = createMarkitXmlParser().parse(expansions(CAP)) as { a: string };
		expect(parsed.a).toBe("&".repeat(CAP));
		expect(() => createMarkitXmlParser().parse(expansions(CAP + 1))).toThrow(
			`Entity expansion count limit exceeded: ${CAP + 1} > ${CAP}`,
		);
	});
});

describe("an Office converter", () => {
	const firstPart: ReadonlyArray<readonly [converter: string, extension: string, part: string]> = [
		["xlsx", ".xlsx", "xl/workbook.xml"],
		["pptx", ".pptx", "ppt/presentation.xml"],
		["epub", ".epub", "META-INF/container.xml"],
	];
	for (const [converter, extension, part] of firstPart) {
		it(`${converter} fails on a ${part} that expands entities past the cap`, async () => {
			const document = Buffer.from(zip({ [part]: new TextEncoder().encode(expansions(CAP + 1)) }));
			let message = "";
			try {
				await new Markit().convert(document, { extension });
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toBe(
				`Conversion failed:\n  ${converter}: [EntityReplacer] Entity expansion count limit exceeded: ${CAP + 1} > ${CAP}`,
			);
		});
	}
});
