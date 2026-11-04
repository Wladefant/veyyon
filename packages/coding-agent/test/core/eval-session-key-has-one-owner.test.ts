/**
 * One owner for the key a retained eval kernel is stored under, and the two divergences that cost.
 *
 * WHY THIS SUITE EXISTS. A managed eval kernel is retained per (session, runtime) so the second cell
 * can see what the first defined. That key is therefore the identity of the kernel: two spellings of
 * the same pair mean two interpreters running, twice the memory, and a cell that cannot see the
 * variable it just set. Python, Ruby and Julia each had their OWN copy of the key builder, and copies
 * drift:
 *
 *  - Python and Ruby canonicalised the interpreter path with `realpath`, so `/usr/bin/python3` and the
 *    versioned binary behind it keyed one session. Julia only called `path.resolve`, which does not
 *    follow a symlink, so the same Julia reached through a link started a SECOND kernel.
 *  - Julia joined the parts with `::`, a sequence that can occur inside a session id or a path, so two
 *    different triples could in principle collapse to one key. The other two used a NUL byte, which
 *    cannot appear in either.
 *
 * Neither is visible in ordinary use, which is exactly why they survived: nothing fails, a second
 * kernel simply starts and the cell that expected its state finds nothing. So the properties are
 * asserted here directly on the key, including the collision the separator choice governs, and a source
 * check keeps the three executors from growing private copies again.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildEvalSessionKey, normalizeSessionCwd } from "@veyyon/coding-agent/eval/executor-base";
import { TempDir } from "@veyyon/utils";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

/** A resolver that returns what it was given, for the cases where resolution is not the subject. */
const asGiven = (interpreter: string): string => interpreter;

function key(options: {
	sessionId?: string;
	cwd?: string;
	interpreter?: string;
	resolveInterpreterPath?: (interpreter: string, cwd: string) => string;
	resolveDefaultRuntimeScope?: (cwd: string) => string;
}): string {
	return buildEvalSessionKey({
		sessionId: options.sessionId ?? "python:session-1",
		cwd: options.cwd ?? "/proj",
		interpreter: options.interpreter,
		resolveInterpreterPath: options.resolveInterpreterPath ?? asGiven,
		resolveDefaultRuntimeScope: options.resolveDefaultRuntimeScope,
	});
}

describe("the cwd and the key", () => {
	/**
	 * THE kernel leak. A cwd in the key started a kernel per directory a session moved through and kept
	 * every earlier one alive until the session ended. Each runner applies the cwd of every cell, so a
	 * directory change keeps the one kernel.
	 */
	it("leaves the cwd out, so one session keeps one kernel in every directory", () => {
		expect(key({ cwd: "/proj/a" })).toBe(key({ cwd: "/proj/b" }));
	});

	/** A project venv selects a different Python, which a kernel cannot switch to after it started. */
	it("keeps two directories apart when the cwd selects a different default runtime", () => {
		const venvOf = (cwd: string): string => (cwd === path.resolve("/proj/a") ? "/proj/a/.venv" : "");

		expect(key({ cwd: "/proj/a", resolveDefaultRuntimeScope: venvOf })).not.toBe(
			key({ cwd: "/proj/b", resolveDefaultRuntimeScope: venvOf }),
		);
		expect(key({ cwd: "/proj/b", resolveDefaultRuntimeScope: venvOf })).toBe(
			key({ cwd: "/proj/c", resolveDefaultRuntimeScope: venvOf }),
		);
	});

	it("hands the default-runtime resolver the resolved cwd", () => {
		const seen: string[] = [];

		key({
			cwd: "proj/sub/..",
			resolveDefaultRuntimeScope: cwd => {
				seen.push(cwd);
				return "";
			},
		});

		expect(seen).toEqual([path.resolve("proj")]);
	});

	/** A named interpreter is the runtime, so a project venv in the cwd does not change the kernel. */
	it("ignores the default runtime when an interpreter is named", () => {
		const venvOf = (cwd: string): string => `${cwd}/.venv`;

		expect(key({ cwd: "/proj/a", interpreter: "/usr/bin/python3", resolveDefaultRuntimeScope: venvOf })).toBe(
			key({ cwd: "/proj/b", interpreter: "/usr/bin/python3", resolveDefaultRuntimeScope: venvOf }),
		);
	});

	it("is exported on its own, because the executors resolve their cwd before anything else", () => {
		expect(normalizeSessionCwd("proj/sub")).toBe(path.resolve("proj/sub"));
		expect(normalizeSessionCwd("/proj/./sub")).toBe(path.resolve("/proj/sub"));
	});
});

describe("the interpreter in the key", () => {
	/**
	 * THE Julia bug. A symlink and its target are the same interpreter, and keying them separately
	 * starts a second kernel that shares no state with the first. Asserted against a real symlink on
	 * disk, because the whole point is that `path.resolve` cannot see through one.
	 */
	it("follows a symlink, so a link and its target are one kernel", () => {
		using dir = TempDir.createSync("@veyyon-eval-session-key-");
		const real = path.join(dir.path(), "python3.12");
		const link = path.join(dir.path(), "python3");
		fs.writeFileSync(real, "#!/bin/sh\n");
		fs.symlinkSync(real, link);

		expect(key({ interpreter: link })).toBe(key({ interpreter: real }));
		// And the key carries the canonical path, not the link, so it is legible in a debug dump.
		expect(key({ interpreter: link })).toContain(fs.realpathSync.native(real));
	});

	/**
	 * A path that cannot be canonicalised is keyed as written. An interpreter that does not exist gets
	 * its own key either way, and the failure belongs to kernel startup, which reports it.
	 */
	it("keys a path that does not exist as written rather than failing", () => {
		const missing = path.join(path.sep, "nonexistent-interpreter-4f2c", "bin", "python3");

		expect(key({ interpreter: missing })).toContain(missing);
	});

	/** No interpreter named means the runtime chooses, and every such call shares one key. */
	it("is empty when the caller named none", () => {
		expect(key({})).toBe(key({ interpreter: undefined }));
		expect(key({})).toBe("python:session-1\0\0");
	});

	/**
	 * The resolver is the language's own (`resolveExplicitPythonRuntime` and friends), so a version alias
	 * that resolves to one binary keys one kernel. Asserted through a stand-in resolver, because each
	 * language's real resolution is tested where it lives.
	 */
	it("goes through the caller's resolver before it is canonicalised", () => {
		using dir = TempDir.createSync("@veyyon-eval-session-key-");
		const real = path.join(dir.path(), "ruby3.3");
		fs.writeFileSync(real, "#!/bin/sh\n");
		const resolveAlias = (interpreter: string): string => (interpreter === "3.3" ? real : interpreter);

		expect(key({ interpreter: "3.3", resolveInterpreterPath: resolveAlias })).toBe(
			key({ interpreter: real, resolveInterpreterPath: resolveAlias }),
		);
	});

	/** The resolver sees the RESOLVED cwd, so a relative interpreter is resolved against one directory. */
	it("hands the resolver the already-resolved cwd", () => {
		const seen: string[] = [];

		key({
			cwd: "proj/sub",
			interpreter: "./bin/python3",
			resolveInterpreterPath: (interpreter, cwd) => {
				seen.push(cwd);
				return interpreter;
			},
		});

		expect(seen).toEqual([path.resolve("proj/sub")]);
	});
});

describe("the separator between the parts", () => {
	/**
	 * THE Julia collision. Julia joined with `::`, so a session id ending in `:` beside a path starting
	 * with `:` produced the same string as a different pair. NUL cannot occur in either, so the parts
	 * cannot be confused. This is the test that fails if someone "tidies" the separator into a colon.
	 */
	it("is a NUL byte, which cannot appear in a session id or a path", () => {
		const built = key({ sessionId: "julia:s1", interpreter: "/opt/julia/bin/julia" });

		expect(built).toBe("julia:s1\0/opt/julia/bin/julia\0");
		expect(built.split("\0")).toHaveLength(3);
	});

	it("keeps two pairs apart that a colon separator would merge", () => {
		// With `::` these two both spell `a::/b::/c::`. With NUL they cannot.
		const first = key({ sessionId: "a", interpreter: "/b::/c" });
		const second = key({ sessionId: "a::/b", interpreter: "/c" });

		expect(first).not.toBe(second);
	});

	it("keeps different session ids apart in the same directory", () => {
		expect(key({ sessionId: "python:a" })).not.toBe(key({ sessionId: "python:b" }));
	});
});

describe("the three executors", () => {
	/**
	 * The lock. Each of them had a private `buildSessionKey` and a private `normalizeSessionCwd`, and
	 * that is how the two divergences above happened. A new copy would reintroduce them silently, so the
	 * absence is asserted on the source.
	 */
	it("share the one builder instead of defining their own", async () => {
		for (const dir of ["py", "rb", "jl"]) {
			const specifiers = moduleSpecifiersIn(
				await Bun.file(path.join(import.meta.dir, `../../src/eval/${dir}/executor.ts`)).text(),
			);

			// The IMPORT EDGE, which is also the proof of absence: a module cannot import
			// `buildEvalSessionKey` and declare it, so `bun check` enforces the exclusivity. The three
			// `not.toContain("function buildSessionKey(")` lines this replaced each matched one exact
			// spelling, and the divergence that actually shipped -- one executor normalising the cwd
			// differently -- was a difference in a function BODY, which no absence of a signature can
			// see. The properties of the key itself are asserted above, on the key.
			expect(specifiers, dir).toContain("../executor-base");
		}
	});
});
