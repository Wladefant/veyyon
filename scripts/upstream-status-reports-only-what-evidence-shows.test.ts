/**
 * WHY: `upstream-status.ts` decides which oh-my-pi commits this fork still lacks. Two defects in that
 * decision cost real work: a commit reported missing that a carrier already has sends a lane to port
 * it twice, and a follow-up fix that goes unreported leaves a port shipping the bug upstream already
 * corrected (the bash live-output queue ported in Wladefant/veyyon#167 without upstream's
 * `4e78d12428` compaction fix). The suite pins the patch parser, the rename normalization, the
 * citation resolver, the class precedence and the follow-up link.
 *
 * Gap: it does not run against real remotes, so a change in git's `-U0` output format or in how
 * santhreal writes port citations is not caught here; the report's counts are checked by running
 * `bun run upstream:status` itself.
 */
import { describe, expect, it } from "bun:test";
import {
	type Citations,
	classify,
	collectCitations,
	type Evidence,
	isSignificant,
	linkFollowUps,
	normalizeLine,
	type OmpClass,
	patchWalker,
	ShaIndex,
} from "./upstream-status";

const SHA_A = "4e78d12428e57aa2b37cb169b34a34e3545714aa";
const SHA_B = "1778ab93b444d73a02df22b1ad788e1a5e9fb758";
const SHA_C = "1778ab93b4ffffffffffffffffffffffffffffff";

function parse(patch: string) {
	const added: string[] = [];
	const removed: string[] = [];
	const commits: string[] = [];
	const walk = patchWalker({
		added: line => added.push(line),
		removed: line => removed.push(line),
		commit: sha => commits.push(sha),
	});
	for (const line of patch.split("\n")) walk(line);
	return { added, removed, commits };
}

function noCitations(): Record<"santhreal" | "fork", Citations> {
	return { santhreal: { shas: new Set(), prs: new Set() }, fork: { shas: new Set(), prs: new Set() } };
}

describe("the -U0 patch walker", () => {
	it("counts hunk lines that look like headers and skips real file headers", () => {
		const patch = [
			`commit ${SHA_A}`,
			"",
			"diff --git a/x.ts b/x.ts",
			"--- a/x.ts",
			"+++ b/x.ts",
			"@@ -1 +1,2 @@",
			"-const old = 1;",
			"+++counter;",
			"+--- divider in a markdown body",
			"\\ No newline at end of file",
			`commit ${SHA_B}`,
			"diff --git a/y.ts b/y.ts",
			"--- a/y.ts",
			"+++ b/y.ts",
			"@@ -0,0 +1 @@",
			"+commit this line is content, not a header",
		].join("\n");
		expect(parse(patch)).toEqual({
			added: ["++counter;", "--- divider in a markdown body", "commit this line is content, not a header"],
			removed: ["const old = 1;"],
			commits: [SHA_A, SHA_B],
		});
	});
});

describe("line normalization across the rename", () => {
	it("maps oh-my-pi and veyyon spellings of one line to the same form", () => {
		expect(normalizeLine('import { x } from "@oh-my-pi/pi-utils";')).toBe(
			normalizeLine('import   { x } from "@veyyon/utils";'),
		);
		expect(normalizeLine("const dir = process.env.PI_CONFIG_DIR ?? omp;")).toBe(
			normalizeLine("const dir = process.env.VEYYON_CONFIG_DIR ?? veyyon;"),
		);
	});

	it("keeps lines that differ outside the brand distinct", () => {
		expect(normalizeLine("const limit = MAX_LIVE_WRITE_QUEUE_CHUNKS;")).not.toBe(
			normalizeLine("const limit = MAX_LIVE_WRITE_QUEUE_BYTES;"),
		);
	});

	it("treats imports, braces and short lines as insignificant", () => {
		expect(isSignificant(normalizeLine('import { a, b, c, d } from "./module";'))).toBe(false);
		expect(isSignificant(normalizeLine("});"))).toBe(false);
		expect(isSignificant(normalizeLine("this.#writeQueue.splice(0, this.#writeOffset);"))).toBe(true);
	});
});

describe("citations", () => {
	const index = new ShaIndex([SHA_A, SHA_B, SHA_C]);

	it("resolves a unique prefix and refuses an ambiguous one", () => {
		expect(index.resolve("4e78d12")).toBe(SHA_A);
		expect(index.resolve("1778ab93b4")).toBeNull();
		expect(index.resolve("1778ab93b444")).toBe(SHA_B);
		expect(index.resolve("deadbee")).toBeNull();
	});

	it("collects commit and pull request citations in every form ports use", () => {
		const into: Citations = { shas: new Set(), prs: new Set() };
		collectCitations(
			[
				"Ports oh-my-pi 4e78d12 and https://github.com/can1357/oh-my-pi/pull/4269.",
				"fix(bash): bound queue [upstream #5001]",
				"port(upstream#6002): thing",
				"<!-- upstream-pr: 7003 -->",
				"Refs #164, see oh-my-pi#12 and upstream #45",
			].join("\n"),
			index,
			into,
		);
		expect([...into.shas]).toEqual([SHA_A]);
		expect([...into.prs].sort((a, b) => a - b)).toEqual([4269, 5001, 6002, 7003]);
	});

	const cited = (text: string) => {
		const into: Citations = { shas: new Set(), prs: new Set() };
		collectCitations(text, index, into);
		return into;
	};

	it("does not count a commit the text says was not ported", () => {
		// Wladefant/veyyon#180 named two follow-ups only to say they were still owed.
		expect([...cited("Ported 4e78d12428e5 but not 1778ab93b444 or deadbeef1234.").shas]).toEqual([SHA_A]);
		expect(cited("1778ab93b444 is not ported yet").shas.size).toBe(0);
		expect(cited("Ports 4e78d12428e5, not 1778ab93b444").shas.has(SHA_B)).toBe(false);
		expect(cited("Still lacks 4e78d12428e5, missing from the fork.").shas.size).toBe(0);
	});

	it("denies the list items under a line that says they are not ported", () => {
		const text = [
			"Two follow-ups remain unported:",
			"- 4e78d12428e5",
			"- 1778ab93b444",
			"",
			"Ports 1778ab93b444 here.",
		].join("\n");
		expect([...cited(text).shas]).toEqual([SHA_B]);
		expect(cited(["Ports these:", "- 4e78d12428e5", "- 1778ab93b444"].join("\n")).shas.size).toBe(2);
	});

	it("denies a pull request the text says was not ported, and keeps one it carried", () => {
		expect([...cited("Carries oh-my-pi#4269 but not oh-my-pi#5001").prs]).toEqual([4269]);
	});

	it("keeps a citation whose sentence denies something else", () => {
		expect([...cited("Port 4e78d12428e5 so the queue does not grow without bound.").shas]).toEqual([SHA_A]);
		expect([...cited("Port 4e78d12428e5 without changing behavior").shas]).toEqual([SHA_A]);
		expect([...cited("Port the remaining upstream change 4e78d12428e5").shas]).toEqual([SHA_A]);
	});

	it("denies a commit whatever the distance between it and the negation", () => {
		expect(cited("4e78d12428e5 from upstream is still definitely not ported").shas.size).toBe(0);
		expect(cited("Still not ported, upstream's 4e78d12428e5 change from last week").shas.size).toBe(0);
	});
});

describe("classification", () => {
	const base = (overrides: Partial<Evidence>): Evidence => ({
		citations: noCitations(),
		present: { santhreal: 0, fork: 0 },
		significant: 10,
		noiseOnly: false,
		...overrides,
	});

	it("ranks santhreal over the fork and a citation over content", () => {
		const citations = noCitations();
		citations.fork.shas.add(SHA_A);
		citations.santhreal.prs.add(4269);
		expect(classify(SHA_A, 4269, base({ citations }))).toBe("cited-santhreal");
		expect(classify(SHA_A, null, base({ citations, present: { santhreal: 0.9, fork: 0 } }))).toBe(
			"content-santhreal",
		);
		expect(classify(SHA_A, null, base({ citations, present: { santhreal: 0, fork: 0.9 } }))).toBe("cited-fork");
		expect(classify(SHA_B, null, base({ present: { santhreal: 0.69, fork: 0.7 } }))).toBe("content-fork");
	});

	it("reports a commit missing unless evidence shows a carrier has it", () => {
		expect(classify(SHA_A, null, base({ present: { santhreal: 0.69, fork: 0.69 } }))).toBe("missing");
		expect(classify(SHA_A, null, base({ significant: 2, present: { santhreal: 1, fork: 1 } }))).toBe("missing-small");
		expect(classify(SHA_A, null, base({ significant: 0, noiseOnly: true }))).toBe("noise");
	});
});

describe("follow-up links", () => {
	type Row = { sha: string; cls: OmpClass; followUpOf: string[] };
	const row = (sha: string, cls: OmpClass): Row => ({ sha, cls, followUpOf: [] });

	it("links a missing commit that rewrites a line an earlier carried commit added", () => {
		const commits = [row("port", "cited-fork"), row("fix", "missing"), row("unrelated", "missing")];
		linkFollowUps(
			commits,
			new Map([
				["port", { added: [1, 2], removed: [] }],
				["fix", { added: [3], removed: [2] }],
				["unrelated", { added: [4], removed: [9] }],
			]),
		);
		expect(commits.map(c => c.followUpOf)).toEqual([[], ["port"], []]);
	});

	it("ignores later carried commits, missing sources and boilerplate lines", () => {
		const commits = [
			row("early-fix", "missing"),
			row("port", "content-santhreal"),
			row("other-missing", "missing"),
			row("a", "noise"),
			row("b", "noise"),
			row("late-fix", "missing-small"),
		];
		linkFollowUps(
			commits,
			new Map([
				["early-fix", { added: [], removed: [1] }],
				["port", { added: [1, 7], removed: [] }],
				["other-missing", { added: [5], removed: [] }],
				["a", { added: [7], removed: [] }],
				["b", { added: [7], removed: [] }],
				["late-fix", { added: [], removed: [5, 7] }],
			]),
		);
		expect(commits.map(c => c.followUpOf)).toEqual([[], [], [], [], [], []]);
	});
});
