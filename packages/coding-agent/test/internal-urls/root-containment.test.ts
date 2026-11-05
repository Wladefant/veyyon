import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import {
	ensureWithinRoot,
	isWithinRoot,
	realPathWithinRoot,
} from "@veyyon/coding-agent/internal-urls/filesystem-resource";
import { removeWithRetries } from "@veyyon/utils";

/**
 * Locks the single owner of the internal-URL root-containment predicate. The
 * `local://`, `vault://`, and `memory://` handlers each carried a byte-identical
 * private `ensureWithinRoot` (and `skill://` an inline copy of the same check).
 * They now delegate to `filesystem-resource.ts`; if any of them ever hardened or
 * loosened its own copy, the handlers would silently disagree on what "inside
 * the root" means, which is exactly the class of escape bug this predicate
 * exists to prevent. The source-scan test at the bottom fails if a private copy
 * of the containment logic reappears.
 *
 * The `/` separator here is `path.sep` on POSIX; these tests run on the CI
 * POSIX host, so descendant paths are written with `/`.
 */
describe("isWithinRoot", () => {
	const root = "/home/user/vault";

	it("accepts the root itself", () => {
		expect(isWithinRoot(root, root)).toBe(true);
	});

	it("accepts a direct child", () => {
		expect(isWithinRoot(`${root}/notes.md`, root)).toBe(true);
	});

	it("accepts a deep descendant", () => {
		expect(isWithinRoot(`${root}/a/b/c/deep.md`, root)).toBe(true);
	});

	it("rejects a sibling that shares the root as a name prefix", () => {
		// The classic prefix-without-separator bug: "/home/user/vault-secret"
		// starts with "/home/user/vault" but is NOT inside it.
		expect(isWithinRoot(`${root}-secret/leak.md`, root)).toBe(false);
	});

	it("rejects a parent directory", () => {
		expect(isWithinRoot("/home/user", root)).toBe(false);
	});

	it("rejects an unrelated path", () => {
		expect(isWithinRoot("/etc/passwd", root)).toBe(false);
	});
});

describe("ensureWithinRoot", () => {
	const root = "/home/user/vault";

	it("throws a scheme-specific escape message when the target is outside", () => {
		expect(() => ensureWithinRoot("/etc/passwd", root, "vault")).toThrow("vault:// URL escapes vault root");
		expect(() => ensureWithinRoot("/etc/passwd", root, "local")).toThrow("local:// URL escapes local root");
		expect(() => ensureWithinRoot("/etc/passwd", root, "memory")).toThrow("memory:// URL escapes memory root");
	});

	it("rejects the name-prefix sibling for every scheme", () => {
		expect(() => ensureWithinRoot(`${root}-secret/x`, root, "vault")).toThrow("vault:// URL escapes vault root");
	});
});

/**
 * `realPathWithinRoot` is the one confinement sequence `local://` and `memory://` resolve
 * through: the lexical target, the real path of its parent and its own real path must each stay
 * inside the root. Each escape below is reachable by one of those three checks only.
 */
describe.skipIf(process.platform === "win32")("realPathWithinRoot", () => {
	let tempDir = "";
	let root = "";
	let outside = "";

	beforeEach(async () => {
		tempDir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), "root-containment-")));
		root = join(tempDir, "root");
		outside = join(tempDir, "outside");
		await fs.mkdir(join(root, "notes"), { recursive: true });
		await fs.mkdir(outside, { recursive: true });
		await fs.writeFile(join(root, "notes", "plan.md"), "plan");
		await fs.writeFile(join(outside, "secret.md"), "secret");
		await fs.symlink(outside, join(root, "linked-dir"));
		await fs.symlink(join(outside, "secret.md"), join(root, "linked-file.md"));
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
	});

	it("returns the real path of a file inside the root", async () => {
		await expect(realPathWithinRoot(join(root, "notes", "plan.md"), root, "local")).resolves.toBe(
			join(root, "notes", "plan.md"),
		);
	});

	it("returns null for a missing file inside the root", async () => {
		await expect(realPathWithinRoot(join(root, "notes", "absent.md"), root, "memory")).resolves.toBeNull();
	});

	it("rejects a lexical path outside the root that does not exist", async () => {
		await expect(realPathWithinRoot(join(tempDir, "nowhere", "secret.md"), root, "local")).rejects.toThrow(
			"local:// URL escapes local root",
		);
	});

	it("rejects a missing file under a directory symlinked outside the root", async () => {
		await expect(realPathWithinRoot(join(root, "linked-dir", "absent.md"), root, "memory")).rejects.toThrow(
			"memory:// URL escapes memory root",
		);
	});

	it("rejects a file symlinked outside the root", async () => {
		await expect(realPathWithinRoot(join(root, "linked-file.md"), root, "local")).rejects.toThrow(
			"local:// URL escapes local root",
		);
	});
});

describe("root-containment single-owner lock", () => {
	it("no internal-urls handler reimplements the containment predicate inline", () => {
		const dir = join(import.meta.dir, "..", "..", "src", "internal-urls");
		const offenders: string[] = [];
		// The predicate's shape: `.startsWith(`${<something>root}${path.sep}`)` or
		// `.startsWith(<root> + path.sep)`. filesystem-resource.ts is the one owner.
		const inlinePredicate = /\.startsWith\(\s*(`\$\{[^}]*[Rr]oot[^}]*\}\$\{path\.sep\}`|\w+\s*\+\s*path\.sep)/;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			if (entry.name === "filesystem-resource.ts") continue;
			const text = readFileSync(join(dir, entry.name), "utf8");
			if (inlinePredicate.test(text)) offenders.push(entry.name);
		}
		expect(offenders).toEqual([]);
	});
});
