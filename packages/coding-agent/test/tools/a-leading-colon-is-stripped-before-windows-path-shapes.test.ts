import { describe, expect, it } from "bun:test";
import { expandPath } from "../../src/tools/core/path-utils";

/**
 * WHY THIS EXISTS. A stray leading `:` is what a mangled path prefix looks like once something
 * upstream has eaten the first character of an absolute or relative path, and `expandPath` strips it.
 * The lookahead only recognized the POSIX shapes, so on Windows — where the same mangling produces
 * `:C:\repo\file.ts` or `:\server\share` — the colon survived and the path resolved to something that
 * cannot exist. The class this closes is "a leading colon before any recognized path shape is stripped",
 * not the four literals below: the same widening is what makes a drive-relative `:.\src`, a parent
 * `:..\lib`, and a UNC root behave.
 *
 * GAP THIS DOES NOT COVER. This moves the strip, it does not make resolution platform-aware: on a POSIX
 * host `expandPath(":C:\\repo\\file.ts")` still returns a Windows-shaped string, because stripping the
 * colon is string work and the caller's `path.resolve` is what is platform-bound. A leading colon before
 * a shape neither branch lists (say a future `file://`-relative form) would still survive.
 */
describe("a leading colon is stripped before every Windows path shape", () => {
	it("strips the colon before a drive-letter path", () => {
		expect(expandPath(":C:\\repo\\file.ts")).toBe("C:\\repo\\file.ts");
		expect(expandPath(":c:/repo/file.ts")).toBe("c:/repo/file.ts");
	});

	it("strips the colon before a backslash-rooted or UNC path", () => {
		expect(expandPath(":\\repo\\file.ts")).toBe("\\repo\\file.ts");
		expect(expandPath(":\\\\server\\share\\file.ts")).toBe("\\\\server\\share\\file.ts");
	});

	it("strips the colon before a backslash-relative path", () => {
		expect(expandPath(":.\\src")).toBe(".\\src");
		expect(expandPath(":..\\sibling")).toBe("..\\sibling");
	});

	it("still strips the colon before the POSIX shapes", () => {
		expect(expandPath(":/abs/path")).toBe("/abs/path");
		expect(expandPath(":./rel")).toBe("./rel");
		expect(expandPath(":../rel")).toBe("../rel");
	});

	it("leaves a leading colon that is not a path prefix alone", () => {
		// A selector (`:1-2`, `:raw`), a plain name, and a colon-initial name must
		// round-trip: the drive-letter branch needs the letter AND its colon.
		expect(expandPath(":1-2")).toBe(":1-2");
		expect(expandPath(":raw")).toBe(":raw");
		expect(expandPath(":cache")).toBe(":cache");
		expect(expandPath(":name.txt")).toBe(":name.txt");
	});
});
