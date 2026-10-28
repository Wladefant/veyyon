/**
 * WHY: every markit converter decides whether it handles a stream by the same rule, an exact extension or
 * a mimetype prefix, and each had its own copy of it. They share `acceptsStream` now. This suite pins the
 * rule itself and drives the registry for every converter by its extension alone, by each mimetype alone,
 * and by each mimetype with parameters, so a converter that stops accepting one of its own types fails.
 *
 * Not caught: a converter added to the registry without a row in `FORMATS`.
 */
import { describe, expect, it } from "bun:test";
import { Markit } from "@veyyon/coding-agent/export/markit";
import { acceptsStream } from "@veyyon/coding-agent/export/markit/converters/accepts-stream";
import type { StreamInfo } from "@veyyon/coding-agent/export/markit/types";

describe("acceptsStream", () => {
	const extensions = [".pdf"];
	const mimetypes = ["application/pdf", "application/x-pdf"];
	const cases: ReadonlyArray<readonly [StreamInfo, boolean]> = [
		[{ extension: ".pdf" }, true],
		[{ extension: ".PDF" }, false],
		[{ extension: ".pdfx" }, false],
		[{ mimetype: "application/pdf" }, true],
		[{ mimetype: "application/x-pdf" }, true],
		[{ mimetype: "application/pdf; charset=binary" }, true],
		[{ mimetype: "text/application/pdf" }, false],
		[{ extension: ".txt", mimetype: "application/pdf" }, true],
		[{ extension: "", mimetype: "" }, false],
		[{}, false],
	];
	for (const [streamInfo, accepted] of cases) {
		it(`${accepted ? "accepts" : "rejects"} ${JSON.stringify(streamInfo)}`, () => {
			expect(acceptsStream(streamInfo, extensions, mimetypes)).toBe(accepted);
		});
	}
});

describe("the markit registry", () => {
	const FORMATS: ReadonlyArray<readonly [converter: string, extension: string, mimetypes: readonly string[]]> = [
		["pdf", ".pdf", ["application/pdf", "application/x-pdf"]],
		["docx", ".docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]],
		["pptx", ".pptx", ["application/vnd.openxmlformats-officedocument.presentationml.presentation"]],
		["xlsx", ".xlsx", ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]],
		["epub", ".epub", ["application/epub", "application/epub+zip", "application/x-epub+zip"]],
	];

	async function handler(streamInfo: StreamInfo): Promise<string> {
		try {
			await new Markit().convert(Buffer.from("not a document"), streamInfo);
			return "converted";
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const [heading, first] = message.split("\n");
			return heading === "Conversion failed:" ? (first?.trim().split(":")[0] ?? message) : message;
		}
	}

	for (const [converter, extension, mimetypes] of FORMATS) {
		it(`hands a ${converter} stream to the ${converter} converter by extension and by every mimetype`, async () => {
			expect(await handler({ extension })).toBe(converter);
			for (const mimetype of mimetypes) {
				expect(await handler({ mimetype })).toBe(converter);
				expect(await handler({ mimetype: `${mimetype}; charset=binary` })).toBe(converter);
			}
		});
	}
});
