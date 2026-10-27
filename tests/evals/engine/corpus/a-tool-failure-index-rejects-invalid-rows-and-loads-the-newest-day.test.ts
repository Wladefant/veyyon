/**
 * WHY: Tool-failure indexes are an untrusted, versioned discovery format. A permissive
 * reader can turn malformed or unsafe records into misleading benchmark evidence. These
 * tests pin accepted row shape, stable rejection classes, and newest-day digest loading;
 * they do not parse session files or prove any indexed outcome.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadNewestToolFailureIndex, parseToolFailureIndex } from "./tool-failure-index";

const tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-failure-index-"));
	tempRoots.push(root);
	return root;
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema_version: 1,
		tool: "read",
		args_shape: { file_path: "string", recursive: "bool", enabled: "boolean" },
		error_text: "The requested file was not found.",
		session_id: "session-test-001",
		file: "packages/example.ts",
		line: 12,
		timestamp: "2026-10-27T12:30:00.000Z",
		...overrides,
	};
}

function jsonl(...rows: unknown[]): string {
	return rows.map((value) => JSON.stringify(value)).join("\n");
}

describe("tool-failure index row parsing", () => {
	test("returns a valid version-1 row unchanged", () => {
		const expected = row();
		const result = parseToolFailureIndex(jsonl(expected));

		expect(result).toEqual({ records: [expected], rejections: [] });
	});

	test("rejects unsupported versions and missing required fields with stable reasons", () => {
		const incomplete = row();
		delete incomplete.error_text;
		const missingVersion = row();
		delete missingVersion.schema_version;
		const result = parseToolFailureIndex(jsonl(row({ schema_version: 2 }), incomplete, missingVersion));

		expect(result.records).toEqual([]);
		expect(result.rejections).toEqual([
			{ line: 1, reason: "unsupported-version" },
			{ line: 2, reason: "missing-field" },
			{ line: 3, reason: "missing-field" },
		]);
	});

	test("rejects paths with an NTFS stream suffix or a NUL byte", () => {
		const result = parseToolFailureIndex(
			jsonl(row({ file: "src/example.ts:stream" }), row({ file: "src/\u0000example.ts" })),
		);

		expect(result.records).toEqual([]);
		expect(result.rejections).toEqual([
			{ line: 1, reason: "invalid-field" },
			{ line: 2, reason: "invalid-field" },
		]);
	});

	test("rejects malformed JSON, invalid fields and blank required strings", () => {
		const wrongType = row({ tool: 3 });
		const unsafePath = row({ file: "../outside.ts" });
		const badTimestamp = row({ timestamp: "2026-02-31T12:30:00.000Z" });
		const badShape = row({ args_shape: { flag: "truthy" } });
		const emptyError = row({ error_text: "  " });
		const blankTool = row({ tool: "  " });
		const blankSession = row({ session_id: "\t" });
		const result = parseToolFailureIndex(
			[
				"{not-json",
				JSON.stringify(wrongType),
				JSON.stringify(unsafePath),
				JSON.stringify(badTimestamp),
				JSON.stringify(badShape),
				JSON.stringify(emptyError),
				JSON.stringify(blankTool),
				JSON.stringify(blankSession),
				`\uFEFF${JSON.stringify(row())}`,
			].join("\n"),
		);

		expect(result.records).toEqual([]);
		expect(result.rejections).toEqual([
			{ line: 1, reason: "invalid-json" },
			{ line: 2, reason: "invalid-field" },
			{ line: 3, reason: "invalid-field" },
			{ line: 4, reason: "invalid-field" },
			{ line: 5, reason: "invalid-field" },
			{ line: 6, reason: "invalid-field" },
			{ line: 7, reason: "invalid-field" },
			{ line: 8, reason: "invalid-field" },
			{ line: 9, reason: "invalid-json" },
		]);
	});
});

describe("newest tool-failure index directory loading", () => {
	test("loads only the newest YYYY-MM-DD directory and validates its source-row count", async () => {
		const root = await tempRoot();
		for (const day of ["2026-10-25", "2026-10-27"]) {
			const directory = path.join(root, day);
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(path.join(directory, "tool-errors.jsonl"), jsonl(row({ session_id: `private-${day}` })));
			await fs.writeFile(
				path.join(directory, "digest.json"),
				JSON.stringify({ schema_version: 1, tool_case_count: 1, coverage_complete: day === "2026-10-27", producer_note: "ignored" }),
			);
		}

		const result = await loadNewestToolFailureIndex(root);

		expect(result.day).toBe("2026-10-27");
		expect(result.digest).toEqual({ schema_version: 1, tool_case_count: 1, coverage_complete: true });
		expect(result.records).toEqual([row({ session_id: "private-2026-10-27" })]);
		expect(result.rejections).toEqual([]);
	});
	test("keeps digest counts aligned to source rows when a row is rejected", async () => {
		const root = await tempRoot();
		const directory = path.join(root, "2026-10-27");
		await fs.mkdir(directory);
		await fs.writeFile(path.join(directory, "tool-errors.jsonl"), "{broken");
		await fs.writeFile(
			path.join(directory, "digest.json"),
			JSON.stringify({ schema_version: 1, tool_case_count: 1, coverage_complete: false }),
		);

		const result = await loadNewestToolFailureIndex(root);

		expect(result.records).toEqual([]);
		expect(result.rejections).toEqual([{ line: 1, reason: "invalid-json" }]);
	});

	test("rejects an unsupported digest version and a count that disagrees with source rows", async () => {
		for (const [digest, message] of [
			[{ schema_version: 2, tool_case_count: 0, coverage_complete: false }, "invalid digest.json"],
			[{ schema_version: 1, tool_case_count: 1, coverage_complete: false }, "count does not match"],
		] as const) {
			const root = await tempRoot();
			const directory = path.join(root, "2026-10-27");
			await fs.mkdir(directory);
			await fs.writeFile(path.join(directory, "tool-errors.jsonl"), "");
			await fs.writeFile(path.join(directory, "digest.json"), JSON.stringify(digest));
			await expect(loadNewestToolFailureIndex(root)).rejects.toThrow(message);
		}
	});

});
