/**
 * `readFileText`, `readFileRange` and `writeFileCreatingParents` return and write the same bytes as the
 * `Bun.file().text()`, `Bun.file().slice().bytes()` and `Bun.write` calls they replaced.
 *
 * WHY THIS SUITE EXISTS. The read, edit, LSP, archive and discovery paths moved off Bun's non-blocking opens
 * onto these helpers so an open waits out a lease instead of failing with `EAGAIN`. Their callers were
 * written against Bun's results: the edit path re-detects a leading BOM because the text read drops it,
 * the conflict and SQLite sniffers read a prefix that may be shorter than asked, and the vault and TTS
 * writers rely on missing parent directories being created. A decoder that kept the BOM would make an edit
 * write it twice; a range read off by one would misjudge a binary file or a SQLite header.
 *
 * THE CLASS is a helper whose result differs from the Bun call it replaced. Each case compares against the
 * Bun call on the same bytes rather than against a literal, so a divergence in either direction fails.
 *
 * WHAT THIS DOES NOT CATCH. Waiting out a lease, which
 * `packages/coding-agent/test/a-leased-workspace-file-is-read-and-edited-once-the-lease-breaks.test.ts`
 * proves under a real lease, and `readFileRange` looping over a short read, which a local file never
 * returns.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileRange, readFileText, writeFileCreatingParents } from "@veyyon/utils/fs-io";

const created: string[] = [];

function tempFile(bytes: Uint8Array): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-fs-io-"));
	created.push(dir);
	const file = path.join(dir, "data.bin");
	fs.writeFileSync(file, bytes);
	return file;
}

afterEach(() => {
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ENCODER = new TextEncoder();
const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function concat(...parts: Uint8Array[]): Uint8Array {
	return new Uint8Array(parts.flatMap(part => [...part]));
}

describe("readFileText decodes like Bun.file().text()", () => {
	const inputs: Record<string, Uint8Array> = {
		"a leading BOM": concat(BOM, ENCODER.encode("def greet():\n")),
		"a BOM after the first byte": concat(ENCODER.encode("x"), BOM),
		"two leading BOMs": concat(BOM, BOM, ENCODER.encode("y")),
		"an invalid byte": new Uint8Array([0x61, 0xff, 0x62]),
		"a truncated multibyte sequence": new Uint8Array([0x61, 0xe2, 0x82]),
		"CRLF line endings": ENCODER.encode("a\r\nb\r\n"),
		"an empty file": new Uint8Array(),
	};
	for (const [name, bytes] of Object.entries(inputs)) {
		it(`for ${name}`, async () => {
			const file = tempFile(bytes);
			expect(await readFileText(file)).toBe(await Bun.file(file).text());
		});
	}
});

describe("readFileRange slices like Bun.file().slice().bytes()", () => {
	const bytes = ENCODER.encode("0123456789");
	const ranges: Array<[number, number]> = [
		[0, 4],
		[3, 7],
		[0, 10],
		[0, 64],
		[8, 64],
		[10, 20],
		[4, 4],
	];
	for (const [start, end] of ranges) {
		it(`for ${start}..${end} of a 10-byte file`, async () => {
			const file = tempFile(bytes);
			expect(await readFileRange(file, start, end)).toEqual(await Bun.file(file).slice(start, end).bytes());
		});
	}

	it("fails on a missing file instead of returning nothing", async () => {
		const missing = path.join(path.dirname(tempFile(bytes)), "absent.bin");
		await expect(readFileRange(missing, 0, 4)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("writeFileCreatingParents writes like Bun.write", () => {
	it("creates every missing parent directory and writes the bytes", async () => {
		const root = path.dirname(tempFile(new Uint8Array()));
		const target = path.join(root, "a", "b", "c.txt");
		await writeFileCreatingParents(target, "first");
		const viaBun = path.join(root, "d", "e", "f.txt");
		await Bun.write(viaBun, "first");
		expect(fs.readFileSync(target, "utf8")).toBe(fs.readFileSync(viaBun, "utf8"));
	});

	it("replaces an existing file's content rather than appending", async () => {
		const file = tempFile(ENCODER.encode("a longer original"));
		await writeFileCreatingParents(file, new Uint8Array([0x6e, 0x65, 0x77]));
		expect(fs.readFileSync(file, "utf8")).toBe("new");
	});
});
