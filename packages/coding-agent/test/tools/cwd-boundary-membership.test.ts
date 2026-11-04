/**
 * The set of tools bound by the working-directory boundary is pinned, and the
 * documentation that lists them is checked against the code.
 *
 * WHY THIS SUITE EXISTS. A tool joins the boundary by declaring
 * `filesystemTargets`. That is a good design (one interface, no registry to
 * update) but it has a failure mode: forgetting costs nothing at compile time
 * and produces no warning. The tool simply is not gated, and every other test
 * stays green. `set_cwd` sat outside the boundary that way, which is how it
 * became usable to escape the boundary rather than be bound by it.
 *
 * So membership is asserted explicitly. Adding a filesystem tool without adding
 * it here fails, which is the prompt to ask whether it should be gated. Removing
 * one fails too, which is the prompt to ask what regressed.
 *
 * The second half checks `docs/handbook/src/reference/approval-mode.md`, because a list of gated tools
 * that lives in prose drifts from the code silently and a reader has no way to
 * tell. If the doc is wrong about which tools are gated, it is worse than absent.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasFilesystemTargets } from "@veyyon/coding-agent/tools/core/cwd-boundary";
import { TempDir } from "@veyyon/utils";
import { constructEveryTool } from "../helpers/every-tool";

/**
 * Every tool that declares filesystem targets, by the `name` its class exposes.
 *
 * Sorted, and compared as a whole set rather than with per-entry `toContain`, so
 * an ADDITION fails as loudly as a removal.
 *
 * `bash` is the odd member and joined deliberately. The others report every
 * path they touch; bash reports only the paths under a credentials directory
 * (`bashCredentialTargets`). Reporting a shell command's whole path set would
 * prompt on `/usr/bin/env` and every toolchain path a build names, which is the
 * false-positive noise that gets approvals switched off. Before it joined at
 * all, `read ~/.ssh/id_rsa` asked and `bash cat ~/.ssh/id_rsa` did not, so the
 * boundary had a hole that the more natural spelling walked straight through.
 */
const BOUND_TOOLS = ["ast_edit", "bash", "edit", "inspect_image", "read", "search", "set_cwd", "write"].sort();

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..", "..");

describe("boundary membership", () => {
	let profile: TempDir;

	beforeAll(() => {
		profile = TempDir.createSync("@cwd-boundary-membership-");
	});

	afterAll(() => {
		profile.removeSync();
	});

	/**
	 * THE regression this file exists for. A tool that lost its `filesystemTargets` declaration would
	 * silently stop being gated while continuing to read and write files, and a filesystem tool that
	 * joins without a decision recorded here is not gated either. Read from every constructed tool, so
	 * an addition fails as loudly as a removal and no tool can be missed by a scan that never opened
	 * its file.
	 */
	it("is declared by exactly the pinned tools among every tool a session can construct", async () => {
		const { tools, unconstructable } = await constructEveryTool(profile.path());

		expect(unconstructable).toEqual([]);
		expect(
			tools
				.filter(tool => hasFilesystemTargets(tool))
				.map(tool => tool.name)
				.sort(),
		).toEqual(BOUND_TOOLS);
	});

	/** The predicate the wrapper actually calls, exercised on both answers so the
	 * membership assertions above rest on a working check. */
	it("hasFilesystemTargets distinguishes a bound tool from an unbound one", () => {
		expect(hasFilesystemTargets({ filesystemTargets: () => [] })).toBe(true);
		expect(hasFilesystemTargets({})).toBe(false);
		expect(hasFilesystemTargets(null)).toBe(false);
		expect(hasFilesystemTargets({ filesystemTargets: "not a function" })).toBe(false);
	});
});

describe("docs/handbook/src/reference/approval-mode.md agrees with the code", () => {
	const doc = fs.readFileSync(
		path.join(REPO_ROOT, "docs", "handbook", "src", "reference", "approval-mode.md"),
		"utf8",
	);

	/**
	 * A reader who trusts this list and finds it incomplete has been misled about what is gated,
	 * which is worse than the doc not listing anything.
	 *
	 * This one stays as a doc check ON PURPOSE, under the security-boundary carve-out: the subject is
	 * whether the documented membership matches `BOUND_TOOLS`, and `BOUND_TOOLS` is itself pinned
	 * against the constructed tools by the sweep above. So the chain is code -> pinned set -> doc, and a tool
	 * that joins the boundary without being documented fails here. It is a completeness check over a
	 * derived list, not a scan for a hand-picked phrase.
	 */
	it.each(BOUND_TOOLS)("names %s as bound by the working-directory boundary", name => {
		expect(doc).toContain(`\`${name}\``);
	});

	// REMOVED, deliberately: two regexes over the doc's PROSE, `/yolo[^.]*opts out/i` and
	// `/no interactive UI[\s\S]{0,200}fails/i`. Both were green against a document asserting the
	// OPPOSITE of the truth -- "yolo never opts out of the working-directory boundary" matches the
	// first, and "a call that needs approval is auto-approved and proceeds; nothing fails" matches the
	// second -- while the first went red on a correct reword ("yolo bypasses the boundary entirely").
	// A check that cannot fail on the claim it names, and can fail on a correct edit, is worse than no
	// check. Both behaviours are proven for real in
	// `packages/coding-agent/test/tools/non-interactive-approval-fails-closed.test.ts`: the carve-out
	// by "yolo is the documented carve-out and still runs", and the headless refusal by "a tier that
	// requires approval refuses when there is no UI" and "the working-directory boundary refuses when
	// there is no UI".
});
