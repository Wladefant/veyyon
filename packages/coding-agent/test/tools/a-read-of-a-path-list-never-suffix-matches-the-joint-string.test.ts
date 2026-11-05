/**
 * WHY: a read of `a/scope.md; a/RUNLOG.md` stat'd the joint string, missed, and then suffix-globbed
 * the whole working directory for `**\/a/scope.md; a/RUNLOG.md` before it ever tried the split. No
 * file carries that name, so in a large tree every multi-path read waited out the 5 s glob deadline.
 *
 * Class closed: a delimited list reaches its entries without the joint string being suffix-matched,
 * so a deeper file whose name happens to be the joint string never stands in for the list. The order
 * around it is pinned too: a literal file holding the delimiter still reads as one target, and a
 * missing path the split declines still falls back to the suffix match.
 *
 * Not caught here: the native walk honouring the deadline. A walk that outlives the race costs CPU
 * and memory in the background and changes no result; it is measured on the shipped binary instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { removeWithRetries } from "@veyyon/utils";
import { toolResultText } from "../helpers/tool-result-text";

describe("a read of a path list", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-list-order-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	function read(target: string): Promise<string> {
		const session: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		};
		return new ReadTool(session).execute("call", { path: target }).then(toolResultText);
	}

	it("reads the entries it names, not a deeper file named by the joint string", async () => {
		await fs.writeFile(path.join(tmpDir, "alpha.md"), "alpha-body\n");
		await fs.writeFile(path.join(tmpDir, "beta.md"), "beta-body\n");
		await fs.mkdir(path.join(tmpDir, "deep", "nested"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "deep", "nested", "alpha.md; beta.md"), "joint-name-body\n");

		const text = await read("alpha.md; beta.md");

		expect(text).toContain("Note: interpreted as 2 paths: alpha.md, beta.md");
		expect(text).toContain("alpha-body");
		expect(text).toContain("beta-body");
		expect(text).not.toContain("joint-name-body");
	});

	it("reads a literal file whose name holds the delimiter as one target", async () => {
		await fs.writeFile(path.join(tmpDir, "gamma.md"), "gamma-body\n");
		await fs.writeFile(path.join(tmpDir, "delta.md"), "delta-body\n");
		await fs.writeFile(path.join(tmpDir, "gamma.md; delta.md"), "literal-joint-body\n");

		const text = await read("gamma.md; delta.md");

		expect(text).toContain("literal-joint-body");
		expect(text).not.toContain("gamma-body");
		expect(text).not.toContain("interpreted as");
	});

	it("still suffix-matches a missing path the split declines", async () => {
		await fs.mkdir(path.join(tmpDir, "docs", "notes"), { recursive: true });
		await fs.writeFile(path.join(tmpDir, "docs", "notes", "meeting notes.md"), "spaced-name-body\n");

		const text = await read("meeting notes.md");

		expect(text).toContain("resolved to 'docs/notes/meeting notes.md' via suffix match");
		expect(text).toContain("spaced-name-body");
	});
});
