/**
 * WHY: a read of a missing path searches the working directory for a unique path ending in it, for
 * at most 5 s. A read naming several paths searched for each one with a 5 s limit of its own, so in
 * a tree too large to search in that time (a 6.2-million-entry bug bounty root) a read whose list
 * named two missing paths took 10 s, and one naming n took 5n s.
 *
 * Class closed: every suffix search a read call makes shares one 5 s limit counted from its first,
 * whatever names the paths: the parts of a delimited list, and the archive, SQLite and plain-path
 * stages of one path. A search that ends inside the limit leaves the rest to the next path, and a
 * path already searched is not searched again.
 *
 * The walk is the native `glob`, replaced here by a spy that spends a stated amount of a clock the
 * test advances, so the limit is observed without waiting it out; the limit each walk is given is
 * read from `scopedTimeoutSignal`.
 *
 * Not caught here: the native walk stopping when its signal aborts, which
 * `a-read-of-a-path-list-never-suffix-matches-the-joint-string.test.ts` names as measured on the
 * shipped binary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import * as natives from "@veyyon/natives";
import { removeWithRetries } from "@veyyon/utils";
import * as scopedTimeout from "@veyyon/utils/scoped-timeout";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

describe("a read waits out the suffix-search limit once", () => {
	let tmpDir: string;
	let elapsed: number;
	/** The suffix pattern of every walk, in call order. */
	let walks: string[];
	/** The time limit each walk was given, in call order. */
	let limits: number[];

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-suffix-limit-"));
		elapsed = 0;
		walks = [];
		limits = [];
		const start = performance.now();
		vi.spyOn(performance, "now").mockImplementation(() => start + elapsed);
		const scoped = scopedTimeout.scopedTimeoutSignal;
		vi.spyOn(scopedTimeout, "scopedTimeoutSignal").mockImplementation((ms, parent) => {
			limits.push(ms);
			return scoped(ms, parent);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpDir);
	});

	/**
	 * Each walk spends `spend` ms of the clock, then times out when the clock has reached the 5 s
	 * limit, or returns the match `matches` holds for its pattern.
	 */
	function walksTaking(spend: number, matches: Record<string, string> = {}): void {
		vi.spyOn(natives, "glob").mockImplementation(async options => {
			walks.push(options.pattern);
			elapsed += spend;
			if (elapsed >= 5000) throw new DOMException("The operation timed out.", "TimeoutError");
			const found = matches[options.pattern];
			return {
				matches: found ? [{ path: found, fileType: natives.FileType.File }] : [],
				totalMatches: found ? 1 : 0,
				timedOut: false,
			};
		});
	}

	function read(target: string): Promise<string> {
		const session: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		};
		return new ReadTool(session).execute("call", { path: target }).then(resultText);
	}

	it("searches once for a list of missing paths when the first search reaches the limit", async () => {
		walksTaking(5000);

		const text = await read("one/RUNLOG.md; two/RUNLOG.md; three/RUNLOG.md");

		expect(walks).toEqual(["**/one/RUNLOG.md"]);
		for (const missing of ["one", "two", "three"]) {
			expect(text).toContain(`Could not read ${missing}/RUNLOG.md: Path '${missing}/RUNLOG.md' not found`);
		}
	});

	it("leaves what a search did not spend to the next path, and searches no path past the limit", async () => {
		walksTaking(2000);

		await read("one.md; two.md; three.md; four.md");

		// 2 s each: the third search starts at 4 s and reaches the limit, and the fourth never starts.
		expect(walks).toEqual(["**/one.md", "**/two.md", "**/three.md"]);
		// The clock starts at whatever `performance.now()` read, so a remainder carries float error.
		expect(limits.map(Math.round)).toEqual([5000, 3000, 1000]);
	});

	it("searches every missing path whose search fits in the limit", async () => {
		walksTaking(10);

		const text = await read("one.md; two.md; three.md");

		expect(walks).toEqual(["**/one.md", "**/two.md", "**/three.md"]);
		expect(text).toContain("Could not read three.md: Path 'three.md' not found");
	});

	it("searches a path the list names twice once", async () => {
		walksTaking(10);

		await read("one.md; one.md");

		expect(walks).toEqual(["**/one.md"]);
	});

	it("still resolves a later path by suffix inside the limit", async () => {
		await fs.mkdir(path.join(tmpDir, "deep"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "deep", "two.md"), "two-body\n");
		walksTaking(2000, { "**/two.md": "deep/two.md" });

		const text = await read("one.md; two.md");

		expect(walks).toEqual(["**/one.md", "**/two.md"]);
		expect(text).toContain("resolved to 'deep/two.md' via suffix match");
		expect(text).toContain("two-body");
	});

	it("gives a later read call a limit of its own", async () => {
		walksTaking(5000);

		await read("one.md; two.md");
		elapsed = 0;
		await expect(read("three.md")).rejects.toThrow("Path 'three.md' not found");

		expect(walks).toEqual(["**/one.md", "**/three.md"]);
	});
});
