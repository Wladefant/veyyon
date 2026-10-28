/**
 * No two first-party source files hold the same bytes.
 *
 * THE DEFECT. The suite for the composer's draft markers existed three times:
 * `packages/coding-agent/test/modes/a-composer-marker-is-read-whole-or-read-as-text.test.ts`, the same
 * file again under `test/modes/terminal/` after the tests moved beside their sources, and a third copy
 * there named `a-draft-marker-is-recognized-by-shape-and-only-images-renumber.test.ts`, added by a
 * merge of that move. CI ran the suite three times, and a change to the contract had to find and edit
 * three files or leave two of them asserting the old behavior.
 *
 * THE CLASS. A file copied whole where it was meant to move: a rename that kept the old path, a merge
 * that brought both sides of a move, a module duplicated into a second package. Every first-party
 * TypeScript and Rust file git lists is hashed, and two with one digest fail unless the group is
 * listed in `SANCTIONED_COPIES`, which is pinned by exact equality.
 *
 * WHAT IT DOES NOT CATCH. A copy that differs by one byte: a renamed describe block, a reflowed
 * comment, a changed import path. Vendored trees under `natives/vendor/` are outside the sweep.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { listTrackedFiles, REPO_ROOT } from "./git-baseline";

const SOURCE = /\.(?:[cm]?tsx?|rs)$/;
const FOREIGN_ROOTS = ["natives/vendor/"];

/** Byte-identical groups kept on purpose, sorted, each with its reason. */
const SANCTIONED_COPIES: readonly (readonly string[])[] = [
	// Each package's bundler resolves stylesheet imports through an ambient declaration of its own.
	["apps/stats/src/client/css.d.ts", "clients/web/src/env.d.ts"],
];

/** Every group of two or more first-party source files whose bytes are identical, each sorted. */
function byteIdenticalGroups(): string[][] {
	const byDigest = new Map<string, string[]>();
	for (const file of listTrackedFiles(REPO_ROOT)) {
		if (!SOURCE.test(file) || FOREIGN_ROOTS.some(root => file.startsWith(root))) continue;
		const digest = createHash("sha256")
			.update(fs.readFileSync(path.join(REPO_ROOT, file)))
			.digest("hex");
		const group = byDigest.get(digest);
		if (group) group.push(file);
		else byDigest.set(digest, [file]);
	}
	return [...byDigest.values()]
		.filter(group => group.length > 1)
		.map(group => group.sort())
		.sort((a, b) => a.join("\0").localeCompare(b.join("\0")));
}

describe("no source file is a byte copy of another", () => {
	it("holds no copy beyond the sanctioned groups", () => {
		expect(byteIdenticalGroups()).toEqual(SANCTIONED_COPIES.map(group => [...group]));
	});
});
