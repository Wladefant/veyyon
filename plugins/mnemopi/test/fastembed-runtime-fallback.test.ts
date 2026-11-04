import { afterEach, describe, expect, it, vi } from "bun:test";
import * as logger from "@veyyon/utils/logger";
import type * as Fastembed from "fastembed";
import { isRecoverableFastembedLoadError, loadFastembedOrInstall } from "../src/core/fastembed-runtime";

afterEach(() => {
	vi.restoreAllMocks();
});

/** Every warn and debug line the loader writes, in order, with its level. */
function recordLogs(): Array<{ level: "warn" | "debug"; message: string }> {
	const lines: Array<{ level: "warn" | "debug"; message: string }> = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string) => {
		lines.push({ level: "warn", message });
	});
	vi.spyOn(logger, "debug").mockImplementation((message: string) => {
		lines.push({ level: "debug", message });
	});
	return lines;
}

/** Stands in for a loaded module; the loader hands it back without reading it. */
const RUNTIME_COPY = {} as typeof Fastembed;

/**
 * The fastembed runtime-install fallback: when it is taken, and how loudly.
 *
 * `loadFastembedOnce` imports the optional `fastembed` peer, and on failure
 * falls back to downloading and installing a private copy into a runtime cache.
 * Two separate things about that need locking down.
 *
 * First, WHEN. Only a missing or unloadable module may trigger the fallback. If
 * an installed fastembed throws a real error (a corrupt model file, an
 * assertion inside the addon), falling back replaces a clear message with a
 * multi-minute install that fails exactly the same way at the end of it, so
 * that error is rethrown.
 *
 * Second, HOW LOUDLY. The fallback used to be a `logger.debug`, and this is the
 * case Law 10's speed bound is written for. The fallback preserves the
 * behaviour perfectly, so nothing is wrong with the result, but it downloads
 * and installs a runtime before the first embedding is produced. A user whose
 * first index takes minutes instead of seconds had nothing anywhere to explain
 * it. A degrade that expensive cannot be invisible.
 */
describe("the fastembed runtime-install fallback", () => {
	/**
	 * Bun's own resolver failure. This is the shape the fallback exists for: the
	 * optional peer was never installed, which is the default for anyone who did
	 * not opt into the ~270MB of native assets.
	 */
	it("falls back on Bun's ResolveMessage", () => {
		expect(
			isRecoverableFastembedLoadError(Object.assign(new Error("Cannot find package"), { name: "ResolveMessage" })),
		).toBe(true);
	});

	/** Node's equivalents, which is what a non-Bun consumer of the library sees. */
	it("falls back on the Node module-not-found codes", () => {
		for (const code of ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]) {
			expect(isRecoverableFastembedLoadError(Object.assign(new Error("nope"), { code })), code).toBe(true);
		}
	});

	/**
	 * A native addon that will not dlopen is the compiled-binary case, and it is
	 * genuinely recoverable: the runtime install fetches a build that matches the
	 * host. Without this the compiled binary would hard-fail rather than fall
	 * back, which is the whole reason the fallback was written.
	 */
	it("falls back when the native addon cannot be loaded", () => {
		expect(
			isRecoverableFastembedLoadError(Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" })),
		).toBe(true);
	});

	/** The message-text path, for runtimes that carry no code on the error. */
	it("falls back on a cannot-find-module message with no code at all", () => {
		expect(isRecoverableFastembedLoadError(new Error("Cannot find module 'fastembed'"))).toBe(true);
		expect(isRecoverableFastembedLoadError(new Error("cannot find package fastembed"))).toBe(true);
	});

	/**
	 * The half that matters most, and the one an over-eager predicate would break:
	 * a fastembed that IS installed and threw a real error must surface that
	 * error. Falling back here costs the user a long install and then fails
	 * identically, with the original cause now buried.
	 */
	it("rethrows a real error from an installed fastembed", () => {
		expect(isRecoverableFastembedLoadError(new Error("model file is corrupt"))).toBe(false);
		expect(isRecoverableFastembedLoadError(new TypeError("embed is not a function"))).toBe(false);
		expect(isRecoverableFastembedLoadError(Object.assign(new Error("out of memory"), { code: "ENOMEM" }))).toBe(
			false,
		);
	});

	/**
	 * Non-objects reach this predicate whenever something throws a string or a
	 * rejected promise resolves to `undefined`. Treating those as recoverable
	 * would kick off a runtime install for an error nobody can read.
	 */
	it("does not fall back for a thrown value that is not an error object", () => {
		for (const thrown of [undefined, null, "Cannot find module", 42]) {
			expect(isRecoverableFastembedLoadError(thrown), String(thrown)).toBe(false);
		}
	});

	/**
	 * The loudness lock: the fallback names itself at warn level, once, before the
	 * install runs, and it returns the runtime copy.
	 */
	it("reports the fallback at warn level, never debug", async () => {
		const lines = recordLogs();
		const missing = Object.assign(new Error("Cannot find package 'fastembed'"), { name: "ResolveMessage" });
		let installs = 0;

		const loaded = await loadFastembedOrInstall(
			() => Promise.reject(missing),
			async () => {
				installs += 1;
				return RUNTIME_COPY;
			},
		);

		expect(loaded).toBe(RUNTIME_COPY);
		expect(installs).toBe(1);
		expect(lines.map(line => line.level)).toEqual(["warn"]);
		expect(lines[0]?.message).toContain("the first indexing run will be slow");
	});

	/** And a real error from an installed fastembed reaches the caller with no install and no line. */
	it("rethrows a real load error without installing or reporting a fallback", async () => {
		const lines = recordLogs();
		const corrupt = new Error("model file is corrupt");
		let installs = 0;

		const load = loadFastembedOrInstall(
			() => Promise.reject(corrupt),
			async () => {
				installs += 1;
				return RUNTIME_COPY;
			},
		);

		await expect(load).rejects.toBe(corrupt);
		expect(installs).toBe(0);
		expect(lines).toEqual([]);
	});
});
