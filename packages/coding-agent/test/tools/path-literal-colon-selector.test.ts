import type { AnyAgentTool } from "@veyyon/agent-core";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { EditTool } from "@veyyon/coding-agent/edit";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	probeLiteralPathExists,
	resolveToCwd,
	splitPathAndSel,
	splitPathAndSelPreferringLiteral,
} from "@veyyon/coding-agent/tools/core/path-utils";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { removeWithRetries } from "@veyyon/utils";
import { SearchTool } from "../../src/tools/search/search";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

const EMPTY_ZIP_EOCD = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

// Regression: filenames whose tail matches the read-tool selector grammar
// (e.g. `test:1-2`, `log:raw`) used to be shredded by `splitPathAndSel` before
// either tool checked the filesystem — see issue #4618. Both `read` and `grep`
// must prefer a real literal file over the selector interpretation.
describe("literal colon filename resolution (issue #4618)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "literal-colon-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
			...overrides,
		};
	}

	describe("splitPathAndSelPreferringLiteral", () => {
		it("keeps the raw path intact when a literal colon file exists on disk", async () => {
			const literal = "test:1-2";
			await Bun.write(path.join(tmpDir, literal), "test\n");

			// Strict splitter still peels — this documents the contract the
			// literal-preferring variant sits on top of.
			expect(splitPathAndSel(literal)).toEqual({ path: "test", sel: "1-2" });

			expect(await splitPathAndSelPreferringLiteral(literal, tmpDir)).toEqual({ path: literal });
		});

		it("keeps a shell-escaped literal path intact when the resolved file exists", async () => {
			await fs.mkdir(path.join(tmpDir, "dir"), { recursive: true });
			await Bun.write(path.join(tmpDir, "dir", "a b:1-2"), "escaped literal\n");

			expect(await splitPathAndSelPreferringLiteral("dir/a\\ b:1-2", tmpDir)).toEqual({
				path: "dir/a\\ b:1-2",
			});
		});

		it("falls back to selector interpretation when the literal path does not exist", async () => {
			// No file created — the selector split wins because the raw path
			// cannot be stat'd.
			expect(await splitPathAndSelPreferringLiteral("test:1-2", tmpDir)).toEqual({
				path: "test",
				sel: "1-2",
			});
		});

		it("also protects `:raw`-shaped literal filenames", async () => {
			const literal = "log:raw";
			await Bun.write(path.join(tmpDir, literal), "line one\nline two\n");
			expect(await splitPathAndSelPreferringLiteral(literal, tmpDir)).toEqual({ path: literal });
		});

		it("keeps a literal dangling symlink intact (lstat exists even though stat fails)", async () => {
			const literal = path.join(tmpDir, "test:1-2");
			await fs.symlink(path.join(tmpDir, "missing-target"), literal);

			expect(await probeLiteralPathExists(literal, tmpDir)).toBe("exists");
			expect(await splitPathAndSelPreferringLiteral(literal, tmpDir)).toEqual({ path: literal });
		});

		it("returns the strict split unchanged when there is no selector tail", async () => {
			expect(await splitPathAndSelPreferringLiteral("plain.txt", tmpDir)).toEqual({
				path: "plain.txt",
			});
		});
	});

	describe("probeLiteralPathExists", () => {
		it('returns "missing" for a path that clearly does not exist', async () => {
			expect(await probeLiteralPathExists(path.join(tmpDir, "never-here:1-2"), tmpDir)).toBe("missing");
		});

		it('returns "exists" for a regular file', async () => {
			const literal = path.join(tmpDir, "regular:1-2");
			await Bun.write(literal, "hi\n");
			expect(await probeLiteralPathExists(literal, tmpDir)).toBe("exists");
		});

		it('returns "exists" for a dangling symlink', async () => {
			const literal = path.join(tmpDir, "dangling:1-2");
			await fs.symlink(path.join(tmpDir, "nowhere"), literal);
			expect(await probeLiteralPathExists(literal, tmpDir)).toBe("exists");
		});
	});

	describe("read tool", () => {
		it("reads a literal file whose name ends in a selector-shaped suffix", async () => {
			const literal = "test:1-2";
			const absolute = path.join(tmpDir, literal);
			await Bun.write(absolute, "test\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal", { path: absolute });
			const output = toolResultText(result);

			expect(output).toContain("test");
			// The strict split would have opened `test` (which doesn't exist)
			// and thrown "Path 'test' not found".
			expect(output).not.toMatch(/not found/i);
		});

		it("reads a shell-escaped literal file whose name ends in a selector-shaped suffix", async () => {
			await fs.mkdir(path.join(tmpDir, "dir"), { recursive: true });
			await Bun.write(path.join(tmpDir, "dir", "a b:1-2"), "escaped literal read\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-escaped-literal", { path: "dir/a\\ b:1-2" });
			const output = toolResultText(result);

			expect(output).toContain("escaped literal read");
		});

		it("prefers a real `foo:1-2` file over interpreting `:1-2` as a range on `foo`", async () => {
			await Bun.write(path.join(tmpDir, "foo"), "line 1\nline 2\nline 3\n");
			await Bun.write(path.join(tmpDir, "foo:1-2"), "colon file wins\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal-wins", {
				path: path.join(tmpDir, "foo:1-2"),
			});
			const output = toolResultText(result);

			expect(output).toContain("colon file wins");
			expect(output).not.toContain("line 1");
		});

		it("still honors the `:5-10` selector when only the base file exists on disk", async () => {
			const absolute = path.join(tmpDir, "notes");
			const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
			await Bun.write(absolute, `${lines}\n`);

			const session = createSession();
			session.settings.set("read.summarize.enabled", false);
			const tool = new ReadTool(session);
			const result = await tool.execute("read-selector-preserved", {
				path: `${absolute}:5-10`,
			});
			const output = toolResultText(result);

			expect(output).toContain("line 5");
			expect(output).toContain("line 10");
			// Lines well outside the requested range must not appear — the selector
			// still peels because the raw `notes:5-10` path does not exist literally.
			expect(output).not.toContain("line 30");
			expect(output).not.toContain("line 40");
		});

		it("reads a literal file that looks like an archive selector (`data.zip:1-2`)", async () => {
			// A real POSIX file whose name ends in a selector-shaped tail after an
			// archive extension. The archive resolver would otherwise open `data.zip`
			// alongside it and error on the phantom member.
			const baseArchive = path.join(tmpDir, "data.zip");
			// Empty zip bytes — the file just needs to stat as a real archive so
			// the archive resolver would happily accept it.
			await Bun.write(baseArchive, EMPTY_ZIP_EOCD);
			const literal = path.join(tmpDir, "data.zip:1-2");
			await Bun.write(literal, "literal archive-shaped file\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal-zip-selector", { path: literal });
			const output = toolResultText(result);

			expect(output).toContain("literal archive-shaped file");
		});

		it("reads a literal file that looks like a sqlite selector (`notes.db:1-2`)", async () => {
			// A real POSIX file whose base name matches a sqlite-shaped path plus a
			// selector-shaped tail. The sqlite resolver would misroute this to
			// `notes.db` and try to open a table named `1-2`.
			const baseDb = path.join(tmpDir, "notes.db");
			// SQLite database header (16-byte magic string plus zero-padding).
			const header = new Uint8Array(4096);
			header.set(Buffer.from("SQLite format 3\0", "utf-8"), 0);
			await Bun.write(baseDb, header);
			const literal = path.join(tmpDir, "notes.db:1-2");
			await Bun.write(literal, "literal db-shaped file\n");

			const tool = new ReadTool(createSession());
			const result = await tool.execute("read-literal-db-selector", { path: literal });
			const output = toolResultText(result);

			expect(output).toContain("literal db-shaped file");
		});
	});

	describe("search tool (text)", () => {
		it("searches inside a literal `test:1-2` file", async () => {
			const literal = "test:1-2";
			const absolute = path.join(tmpDir, literal);
			await Bun.write(absolute, "needle\n");

			const tool = new SearchTool(createSession());
			const result = await tool.execute("grep-literal", {
				type: "text",
				input: "needle",
				path: absolute,
			});
			const output = toolResultText(result);

			expect(output).toContain("needle");
			expect(output).not.toMatch(/not found/i);
		});

		it("searches a shell-escaped literal file whose name ends in a selector-shaped suffix", async () => {
			await fs.mkdir(path.join(tmpDir, "dir"), { recursive: true });
			await Bun.write(path.join(tmpDir, "dir", "a b:1-2"), "escaped literal needle\n");

			const tool = new SearchTool(createSession());
			const result = await tool.execute("grep-escaped-literal", {
				type: "text",
				input: "needle",
				path: "dir/a\\ b:1-2",
			});
			const output = toolResultText(result);

			expect(output).toContain("escaped literal needle");
		});

		it("searches a literal file whose name contains a semicolon and selector-shaped tail (`a;b:1-2`)", async () => {
			// Semicolon is the delimited-path separator; without a raw-literal
			// probe in `splitDelimitedPathEntry`, expandDelimitedPathEntries would
			// split `a;b:1-2` into `["a", "b:1-2"]` before grep saw the literal file.
			const literal = path.join(tmpDir, "a;b:1-2");
			await Bun.write(literal, "delimited literal needle\n");

			const tool = new SearchTool(createSession());
			const result = await tool.execute("grep-literal-semicolon-selector", {
				type: "text",
				input: "needle",
				path: literal,
			});

			const output = toolResultText(result);
			expect(output).toContain("delimited literal needle");
			expect(output).not.toMatch(/not found/i);
		});

		it("searches a literal file that looks like an archive selector (`data.zip:1-2`)", async () => {
			// The base archive exists too; grep must not rematerialize the raw
			// literal path as archive `data.zip` plus phantom member `1-2`.
			const baseArchive = path.join(tmpDir, "data.zip");
			await Bun.write(baseArchive, EMPTY_ZIP_EOCD);
			const literal = path.join(tmpDir, "data.zip:1-2");
			await Bun.write(literal, "literal archive needle\n");

			const tool = new SearchTool(createSession());
			const result = await tool.execute("grep-literal-zip-selector", {
				type: "text",
				input: "needle",
				path: literal,
			});

			const output = toolResultText(result);
			expect(output).toContain("literal archive needle");
		});

		it("preserves `:N-M` line-range filtering when the literal file does not exist", async () => {
			const absolute = path.join(tmpDir, "notes.txt");
			await Bun.write(absolute, "one\ntwo\nthree\nfour\n");

			const tool = new SearchTool(createSession());
			const rangedResult = await tool.execute("grep-range-filter", {
				type: "text",
				input: ".",
				path: `${absolute}:1-2`,
			});
			const rangedOutput = toolResultText(rangedResult);

			expect(rangedOutput).toContain("one");
			expect(rangedOutput).toContain("two");
			// Lines outside the range are filtered out.
			expect(rangedOutput).not.toContain("three");
			expect(rangedOutput).not.toContain("four");
		});
	});
});

// Regression: some models intermittently prefix an otherwise-valid path with a
// stray leading `:` (e.g. `:/abs/path`, `:../rel`). The literal `:/abs/path`
// does not exist on disk, so the #4618 literal-preferring probe cannot save it;
// `expandPath` strips the mangled prefix before resolution so `read`, `grep`,
// and `edit` all open the intended file — see issue #5508.
describe("leading-colon path recovery (issue #5508)", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "leading-colon-"));
		await Settings.init({ inMemory: true, cwd: tmpDir });
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(tmpDir);
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return makeToolSession({
			cwd: tmpDir,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => null,
			getSessionId: () => null,
			getPlanModeState: () => undefined,
			settings: Settings.isolated({
				"search.contextBefore": 0,
				"search.contextAfter": 0,
				"edit.mode": "patch",
			}),
			...overrides,
		});
	}

	it("strips a leading colon before an absolute path in resolveToCwd", () => {
		expect(resolveToCwd(":/tmp/veyyon-colon-test.txt", tmpDir)).toBe("/tmp/veyyon-colon-test.txt");
	});

	it("strips a leading colon before `./` and `../` relative paths in resolveToCwd", () => {
		expect(resolveToCwd(":./sub/file.md", tmpDir)).toBe(path.join(tmpDir, "sub/file.md"));
		expect(resolveToCwd(":../sibling.md", tmpDir)).toBe(path.resolve(tmpDir, "../sibling.md"));
	});

	it("does not strip a colon that is not a mangled path prefix", () => {
		// `:selector` shapes and bare tokens must round-trip unchanged — the
		// lookahead only fires before `/`, `~/`, `./`, or `../`.
		expect(resolveToCwd(":raw", tmpDir)).toBe(path.join(tmpDir, ":raw"));
		expect(resolveToCwd(":name.txt", tmpDir)).toBe(path.join(tmpDir, ":name.txt"));
	});

	it("read opens a file addressed with a leading colon", async () => {
		const abs = path.join(tmpDir, "colon-read.txt");
		await Bun.write(abs, "test line A\ntest line B\n");

		const result = await new ReadTool(createSession()).execute("read-leading-colon", { path: `:${abs}` });
		const output = toolResultText(result);

		expect(output).toContain("test line A");
		expect(output).not.toMatch(/not found/i);
	});

	it("read opens a relative file addressed with a leading colon", async () => {
		await Bun.write(path.join(tmpDir, "rel.txt"), "relative body\n");

		const result = await new ReadTool(createSession()).execute("read-leading-colon-rel", { path: ":./rel.txt" });
		const output = toolResultText(result);

		expect(output).toContain("relative body");
		expect(output).not.toMatch(/not found/i);
	});

	it("search searches a file addressed with a leading colon", async () => {
		const abs = path.join(tmpDir, "colon-grep.txt");
		await Bun.write(abs, "needle here\nsecond line\n");

		const result = await new SearchTool(createSession()).execute("grep-leading-colon", {
			type: "text",
			input: "needle",
			path: `:${abs}`,
		});
		const output = toolResultText(result);

		expect(output).toContain("needle");
		expect(output).not.toMatch(/not found/i);
	});

	it("edit updates a file addressed with a leading colon", async () => {
		const abs = path.join(tmpDir, "colon-edit.txt");
		await Bun.write(abs, "needle here\nsecond\n");

		const result = await new EditTool(createSession()).execute("edit-leading-colon", {
			path: `:${abs}`,
			edits: [{ op: "update", diff: "@@\n-needle here\n+replaced" }],
		});

		expect(result.isError).toBeFalsy();
		expect(toolResultText(result)).not.toMatch(/not found/i);
		expect(await Bun.file(abs).text()).toBe("replaced\nsecond\n");
	});

	it("parses selector tails after relative and Windows drive paths", () => {
		const relative = "selector-fixture.txt";
		const windowsPath = "C:\\workspace\\selector-fixture.txt";
		for (const base of [relative, windowsPath]) {
			expect(splitPathAndSel(`${base}:1-3`)).toEqual({ path: base, sel: "1-3" });
			expect(splitPathAndSel(`${base}:raw`)).toEqual({ path: base, sel: "raw" });
			expect(splitPathAndSel(`${base}:raw:1-3`)).toEqual({ path: base, sel: "raw:1-3" });
		}
	});


	it("keeps selector behavior in real reads and parses Windows absolute paths portably", async () => {
		const relative = "selector-fixture.txt";
		const absolute = path.join(tmpDir, relative);
		await fs.writeFile(absolute, ["zero", "one", "two", "three", "four"].join("\n"));
		let readTool: AnyAgentTool;
		const session = createSession({
			getToolByName: name => (name === "read" ? readTool : undefined),
		});
		readTool = new ReadTool(session);
		const read = async (readPath: string): Promise<string> => {
			const result = await callSessionTool("read", { path: readPath }, { session });
			if (typeof result === "string") return result;
			if ("text" in result && typeof result.text === "string") return result.text;
			throw new Error("Read tool returned a non-text bridge result");
		};

		const bare = await read(relative);
		expect(bare).toContain("zero");
		expect(bare).toContain("four");
		const relativeRange = await read(`${relative}:2-3`);
		expect(relativeRange).toContain("one");
		expect(relativeRange).toContain("two");

		expect(await read(`${relative}:raw:2-3`)).toBe("one\ntwo");

		const windowsAbsolute = absolute.replaceAll("/", "\\");
		if (process.platform === "win32") {
			const absoluteRange = await read(`${windowsAbsolute}:raw:3-4`);
			expect(absoluteRange).toBe("two\nthree");
		} else {
			// Linux cannot open a Windows absolute path; check the shared parser against Windows syntax here.
			const windowsPath = "C:\\workspace\\selector-fixture.txt";
			expect(splitPathAndSel(`${windowsPath}:raw:3-4`)).toEqual({ path: windowsPath, sel: "raw:3-4" });
		}

		const perEntry = await read(`${relative}:raw:1-1;${relative}:raw:5-5`);
		expect(perEntry).toContain("zero");
		expect(perEntry).toContain("four");
		expect(perEntry).not.toContain("one");
		expect(perEntry).not.toContain("three");
	});
});

describe("Windows drive-root directory colon selector resolution (-20261108-1452-1517)", () => {
	let uniqueRootDir: string;

	beforeEach(async () => {
		const uniqueName = `veyyon-reg-20261108-1452-1517-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		uniqueRootDir = path.join(os.tmpdir(), uniqueName);
		await fs.mkdir(uniqueRootDir, { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(uniqueRootDir);
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: uniqueRootDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "search.contextBefore": 0, "search.contextAfter": 0 }),
			...overrides,
		};
	}
	it("preserves drive-root selector grammar without filesystem operations", () => {
		expect(splitPathAndSel("C:\\pr1510.diff:306-310")).toEqual({
			path: "C:\\pr1510.diff",
			sel: "306-310",
		});
		expect(splitPathAndSel("C:/pr1510.diff:raw:2-4")).toEqual({
			path: "C:/pr1510.diff",
			sel: "raw:2-4",
		});
		expect(splitPathAndSel("C:\\pr1510.diff:raw")).toEqual({
			path: "C:\\pr1510.diff",
			sel: "raw",
		});
	});


	it("reads absolute path with line range in drive-root directory", async () => {
		const fileName = "pr1510.diff";
		const absolute = path.join(uniqueRootDir, fileName);
		await fs.writeFile(absolute, Array.from({ length: 400 }, (_, i) => `diff line ${i + 1}`).join("\n"));

		const tool = new ReadTool(createSession());
		const result = await tool.execute("read-drive-root-range", {
			path: `${absolute}:306-310`,
		});
		const output = toolResultText(result);
		expect(output).toContain("diff line 306");
		expect(output).toContain("diff line 310");
		expect(output).not.toContain("diff line 304");
		expect(output).not.toContain("diff line 315");
	});

	it("reads absolute path with raw selector and range in drive-root directory", async () => {
		const fileName = "pr1510.diff";
		const absolute = path.join(uniqueRootDir, fileName);
		await fs.writeFile(absolute, Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));

		const tool = new ReadTool(createSession());
		const result = await tool.execute("read-drive-root-raw-range", {
			path: `${absolute}:raw:2-4`,
		});
		const output = toolResultText(result);
		expect(output).toBe("line 2\nline 3\nline 4");
	});

	it("reads relative path with line range in drive-root directory", async () => {
		const fileName = "pr1510.diff";
		const absolute = path.join(uniqueRootDir, fileName);
		await fs.writeFile(absolute, Array.from({ length: 400 }, (_, i) => `diff line ${i + 1}`).join("\n"));

		const tool = new ReadTool(createSession({ cwd: uniqueRootDir }));
		const result = await tool.execute("read-drive-root-rel-range", {
			path: `${fileName}:306-310`,
		});
		const output = toolResultText(result);
		expect(output).toContain("diff line 306");
		expect(output).toContain("diff line 310");
		expect(output).not.toContain("diff line 304");
		expect(output).not.toContain("diff line 315");
	});

	it("reads relative path with raw selector in drive-root directory", async () => {
		const fileName = "pr1510.diff";
		const absolute = path.join(uniqueRootDir, fileName);
		const content = "first line\nsecond line\nthird line\n";
		await fs.writeFile(absolute, content);

		const tool = new ReadTool(createSession({ cwd: uniqueRootDir }));
		const result = await tool.execute("read-drive-root-rel-raw", {
			path: `${fileName}:raw`,
		});
		const output = toolResultText(result);
		expect(output).toBe(content);
	});

	it("preserves actual named streams on Windows while missing streams return missing", async () => {
		if (process.platform !== "win32") return;
		const baseFile = path.join(uniqueRootDir, "stream-test.txt");
		await fs.writeFile(baseFile, "base content\n");
		await fs.writeFile(`${baseFile}:custom`, "custom stream content\n");
		await fs.writeFile(`${baseFile}:raw`, "raw stream content\n");

		expect(await probeLiteralPathExists(`${baseFile}:custom`, uniqueRootDir)).toBe("exists");
		expect(await probeLiteralPathExists(`${baseFile}:raw`, uniqueRootDir)).toBe("exists");

		expect(await probeLiteralPathExists(`${baseFile}:1-5`, uniqueRootDir)).toBe("missing");
		expect(await probeLiteralPathExists(`${baseFile}:100-200`, uniqueRootDir)).toBe("missing");
	});

	it.skipIf(process.platform !== "win32")("treats a missing stream as missing even when lstat reports its base file", async () => {
		const baseFile = path.join(uniqueRootDir, "repro-mock.txt");
		await fs.writeFile(baseFile, "line 1\nline 2\nline 3\n");
		const targetPath = `${baseFile}:2-3`;

		const realStat = await fs.stat(baseFile);
		const spy = spyOn(nodeFs.promises, "lstat").mockImplementation(
			(async (p: nodeFs.PathLike) => {
				if (path.resolve(String(p)) === path.resolve(targetPath)) {
					return realStat;
				}
				return nodeFs.promises.stat(p);
			}) as unknown as typeof nodeFs.promises.lstat,
		);
		try {
			const probe = await probeLiteralPathExists(targetPath, uniqueRootDir);
			expect(probe).toBe("missing");

			const split = await splitPathAndSelPreferringLiteral(targetPath, uniqueRootDir);
			expect(split).toEqual({ path: baseFile, sel: "2-3" });
		} finally {
			spy.mockRestore();
		}
	});
});
