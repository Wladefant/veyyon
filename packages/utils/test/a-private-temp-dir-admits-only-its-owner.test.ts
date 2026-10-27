/**
 * WHY: veyyon wrote files under the shared system temp directory by fixed or guessable names (the shell
 * snapshot directory, the extracted stats dashboard, the `local://` fallback root, the debug transcript,
 * the LLM request dump, git patches, task worktrees, screenshots). Another account on the host could
 * create such a name first: a directory it owns lets it read or replace what veyyon writes there, and a
 * symbolic link redirects the write. Every one of those paths now goes through `privateTempDir()`, so the
 * class closes at that one function: it returns a directory only this user can enter, or throws.
 *
 * Covered: creation at mode 700, reuse of a valid directory with its contents, re-creation after a temp
 * cleaner removed it, and each rejected entry (a symbolic link, a file, a directory open to group or
 * other, a directory owned by another uid) with the exact message that states the entry and the fix.
 *
 * Not covered: Windows, where `process.getuid` is absent and the per-user temp directory is used without
 * the ownership check; and a caller that builds a temp path without this function, which no runtime test
 * can see.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { privateTempDir } from "../src/temp";

const posix = process.getuid !== undefined;
// Read only inside the POSIX-only block below, where `getuid` exists.
const uid = process.getuid?.() ?? -1;

describe.if(posix)("privateTempDir", () => {
	let root: string;
	let expected: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-private-temp-"));
		expected = path.join(root, `veyyon-${uid}`);
		vi.spyOn(os, "tmpdir").mockReturnValue(root);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(root, { recursive: true, force: true });
	});

	function refusal(problem: string, owner = uid): string {
		return `Refusing to use ${path.join(root, `veyyon-${owner}`)}: it ${problem}, and only a directory owned by uid ${owner} with mode 700 keeps other accounts out. Remove it, or set TMPDIR to a directory only you can write.`;
	}

	it("creates <tmpdir>/veyyon-<uid> closed to group and other", () => {
		expect(privateTempDir()).toBe(expected);
		const stats = fs.lstatSync(expected);
		expect({ directory: stats.isDirectory(), mode: stats.mode & 0o777, owner: stats.uid }).toEqual({
			directory: true,
			mode: 0o700,
			owner: uid,
		});
	});

	it("reuses a valid directory and keeps what is in it", () => {
		fs.mkdirSync(expected, { mode: 0o700 });
		fs.writeFileSync(path.join(expected, "kept"), "x");
		expect(privateTempDir()).toBe(expected);
		expect(fs.readFileSync(path.join(expected, "kept"), "utf8")).toBe("x");
	});

	it("creates the directory again after a temp cleaner removed it", () => {
		privateTempDir();
		fs.rmSync(expected, { recursive: true });
		expect(privateTempDir()).toBe(expected);
		expect(fs.lstatSync(expected).isDirectory()).toBe(true);
	});

	it("rejects a symbolic link, even to a valid directory", () => {
		const target = path.join(root, "elsewhere");
		fs.mkdirSync(target, { mode: 0o700 });
		fs.symlinkSync(target, expected);
		expect(() => privateTempDir()).toThrow(refusal("is a symbolic link"));
	});

	it("rejects a file", () => {
		fs.writeFileSync(expected, "");
		expect(() => privateTempDir()).toThrow(refusal("is not a directory"));
	});

	it.each([0o755, 0o750, 0o705, 0o770])("rejects a directory with mode %o", mode => {
		fs.mkdirSync(expected);
		fs.chmodSync(expected, mode);
		expect(() => privateTempDir()).toThrow(refusal(`has mode ${mode.toString(8)}`));
	});

	it("rejects a directory another uid owns", () => {
		// The directory this process creates is owned by `uid`; reporting a different uid makes it
		// another account's directory without needing a second account on the host.
		const other = uid + 1;
		vi.spyOn(process, "getuid").mockReturnValue(other);
		fs.mkdirSync(path.join(root, `veyyon-${other}`), { mode: 0o700 });
		expect(() => privateTempDir()).toThrow(refusal(`is owned by uid ${uid}`, other));
	});
});
