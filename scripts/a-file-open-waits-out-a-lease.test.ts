/**
 * Shipped source opens a file through `node:fs`, which waits out a lease another process holds on it. The
 * non-blocking opens `Bun.file()` reads and `Bun.write` make are frozen at the sites in
 * `bun-nonblocking-open-baseline.json`, and the count only goes down.
 *
 * WHY THIS SUITE EXISTS. Bun opens with `O_NONBLOCK`, and an open of a file under a conflicting lease
 * fails with `EAGAIN` at once instead of waiting for the lease to break. The kernel NFS server holds such
 * a lease on every file it has delegated to a client, so on an exported tree `edit` failed with
 * "EAGAIN: resource temporarily unavailable, open '<path>'" whenever another machine had the file open,
 * and context discovery cached an `AGENTS.md` it could not open as absent. The opens were spread over the
 * read, edit, write, search, LSP, archive, document and discovery paths, one `Bun.file(path).text()` at
 * a time, so the sweep fails on every new one rather than on the paths that failed first.
 * `test/a-leased-workspace-file-is-read-and-edited-once-the-lease-breaks.test.ts` proves the behaviour
 * under a real lease.
 *
 * THE CLASS is a call that opens a path through Bun: `Bun.write(...)` and `Bun.file(...)` used for
 * anything but a metadata access (`.exists()`, `.stat()`, `.size`, `.type`, `.lastModified`, `.name`,
 * `.delete()`, `.unlink()`), which stat or unlink without opening. A `Bun.file(...)` held in a variable
 * counts, because the sweep cannot see which method a later line calls on it.
 *
 * WHAT THIS DOES NOT CATCH. A name assembled at run time (`Bun["wri" + "te"]`), an alias
 * (`const { file } = Bun`), an open through another Bun API (`Bun.spawn` with a `Bun.file` stdout counts,
 * `Bun.mmap` does not), a `.js` file, and test code, which ships nowhere.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Node, Project } from "ts-morph";
import { collectSourceFiles, REPO_ROOT, typeScriptMembers, typeScriptMemberTopLevels } from "./workspace-layout";

/** `BunFile` members that stat or unlink the path without opening it. */
const METADATA_ONLY = new Set(["exists", "stat", "size", "type", "lastModified", "name", "delete", "unlink"]);

/** Members that ship nowhere: the eval suites and the offline simulations. */
const SHIPPED_MEMBERS = typeScriptMembers().filter(member => !member.startsWith("tests/"));

/** Open count per file that already held a non-blocking open; a count only goes down. */
const BASELINE: Record<string, number> = JSON.parse(
	fs.readFileSync(path.join(REPO_ROOT, "scripts", "bun-nonblocking-open-baseline.json"), "utf8"),
);

/** Each non-blocking open in `source`, as the text of the line holding it. */
function nonBlockingOpens(project: Project, source: string): string[] {
	if (!source.includes("Bun")) return [];
	const file = project.createSourceFile("probe.ts", source, { overwrite: true });
	const found: string[] = [];
	file.forEachDescendant(node => {
		if (!Node.isCallExpression(node)) return;
		const callee = node.getExpression();
		if (!Node.isPropertyAccessExpression(callee)) return;
		const receiver = callee.getExpression().getText();
		if (receiver !== "Bun" && receiver !== "globalThis.Bun") return;
		const method = callee.getName();
		if (method !== "write" && method !== "file") return;
		if (method === "file") {
			const parent = node.getParent();
			const metadataOnly =
				Node.isPropertyAccessExpression(parent) &&
				parent.getExpression() === node &&
				METADATA_ONLY.has(parent.getName());
			if (metadataOnly) return;
		}
		const line = node.getStartLineNumber();
		found.push(`${line}: ${source.split("\n")[line - 1]?.trim() ?? ""}`);
	});
	return found;
}

interface Sweep {
	readonly scanned: string[];
	/** Open count per file, for every file holding one. */
	readonly counts: Record<string, number>;
	/** `<file>:<line>: <text>` for every open, so a failure shows the new line. */
	readonly sites: string[];
}

function sweep(): Sweep {
	const project = new Project({ useInMemoryFileSystem: true });
	const scanned = collectSourceFiles(SHIPPED_MEMBERS, REPO_ROOT)
		.map(file => path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"))
		.sort();
	const counts: Record<string, number> = {};
	const sites: string[] = [];
	for (const rel of scanned) {
		const found = nonBlockingOpens(project, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
		if (found.length === 0) continue;
		counts[rel] = found.length;
		for (const site of found) sites.push(`${rel}:${site}`);
	}
	return { scanned, counts, sites };
}

describe("a file open waits out a lease", () => {
	const result = sweep();

	it("reads every tree that holds a shipped TypeScript member", () => {
		expect(result.scanned.length).toBeGreaterThan(1000);
		const roots = new Set(result.scanned.map(rel => rel.split("/")[0]));
		const withSource = typeScriptMemberTopLevels().filter(root =>
			SHIPPED_MEMBERS.some(
				member => member.startsWith(`${root}/`) && fs.existsSync(path.join(REPO_ROOT, member, "src")),
			),
		);
		expect(withSource.filter(root => !roots.has(root))).toEqual([]);
	});

	it("finds no non-blocking open beyond the baseline, and the baseline holds the count the source has", () => {
		const grown = Object.entries(result.counts)
			.filter(([file, count]) => count > (BASELINE[file] ?? 0))
			.map(([file]) => file);
		expect(
			result.sites.filter(site => grown.some(file => site.startsWith(`${file}:`))),
			"Open the file through node:fs or @veyyon/utils/fs-io (readFileText, readFileRange, writeFileCreatingParents)",
		).toEqual([]);
		// An open removed from a baselined file lowers its count here, so the freed count cannot be spent again.
		expect(result.counts).toEqual(BASELINE);
	});
});

describe("what counts as a non-blocking open", () => {
	const project = new Project({ useInMemoryFileSystem: true });
	const count = (source: string): number => nonBlockingOpens(project, source).length;

	it("matches a content read, a write and a held handle", () => {
		expect(count("const text = await Bun.file(p).text();")).toBe(1);
		expect(count("const bytes = await Bun.file(p).bytes();")).toBe(1);
		expect(count("const value = await Bun.file(p).json();")).toBe(1);
		expect(count("const head = await Bun.file(p).slice(0, 4).arrayBuffer();")).toBe(1);
		expect(count("const writer = Bun.file(p).writer();")).toBe(1);
		expect(count("const handle = Bun.file(p);")).toBe(1);
		expect(count("await Bun.write(p, text);")).toBe(1);
		expect(count("await globalThis.Bun.write(p, text);")).toBe(1);
		expect(count("await Bun.write(Bun.file(p), text);")).toBe(2);
	});

	it("leaves metadata access, comments, strings and node:fs alone", () => {
		expect(count("const there = await Bun.file(p).exists();")).toBe(0);
		expect(count("const stats = await Bun.file(p).stat();")).toBe(0);
		expect(count("const bytes = Bun.file(p).size;")).toBe(0);
		expect(count("const mime = Bun.file(p).type;")).toBe(0);
		expect(count("await Bun.file(p).delete();")).toBe(0);
		expect(count("await Bun.file(p).unlink();")).toBe(0);
		expect(count("// Bun.file(p).text() would fail with EAGAIN\nconst x = 1;")).toBe(0);
		expect(count('const label = "Bun.write(p, text)";')).toBe(0);
		expect(count("const text = await fs.readFile(p, 'utf8');")).toBe(0);
	});
});
