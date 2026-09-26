/**
 * WHY: a truncated `read` or `search` result recorded its whole `TruncationResult`
 * in `details.truncation`, kept text included. The content block already carries
 * that text formatted for the model, and every renderer reads only the counts, so
 * the copy was persisted with each truncated result, retained in memory for the
 * life of the session and parsed again on every resume. In a long session those
 * copies were several percent of the session file.
 *
 * The class this closes: a tool result whose `details` embed a truncation's kept
 * text. Every case below drives the production tool through `createTools`, the
 * same wrapped tool a session runs, and asserts the invariant over the whole
 * details tree rather than at one field: no object in it holds a truncation with
 * a `content` string. Each case also asserts it reached a truncation, so a case
 * whose input stopped truncating fails instead of passing on nothing. The type of
 * `details.truncation` (`TruncationSummary`, `content?: never`) makes a new site
 * that assigns a whole `TruncationResult` a type error.
 *
 * What it does not catch: an `artifact://` read and the autoresearch
 * `run_experiment` tool, which record truncation the same way through the same
 * helper but are not driven here, and a tool that stores a copy of its output
 * under a key other than `truncation`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type Tool } from "@veyyon/coding-agent/tools";
import { zip } from "@veyyon/coding-agent/utils/zip";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "./helpers/tool-session";

/** The inline budget under test, in KB: small enough that every input below truncates. */
const BUDGET_KB = 1;

let dir: string;
let tools: Map<string, Tool>;

/** Every object in `value` stored under a `truncation` key, with the path to it. */
function truncationRecords(value: unknown, at = "details"): Array<{ at: string; record: Record<string, unknown> }> {
	if (value === null || typeof value !== "object") return [];
	const found: Array<{ at: string; record: Record<string, unknown> }> = [];
	for (const [key, child] of Object.entries(value)) {
		const childAt = `${at}.${key}`;
		if (key === "truncation" && child !== null && typeof child === "object") {
			found.push({ at: childAt, record: child as Record<string, unknown> });
		}
		found.push(...truncationRecords(child, childAt));
	}
	return found;
}

async function run(name: string, args: Record<string, unknown>): Promise<unknown> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`${name} tool missing`);
	const result = await tool.execute(`call-${name}`, args as never, undefined, undefined, undefined);
	return result.details;
}

/** The truncation the result recorded, asserting it holds counts and no kept text. */
function expectCountsWithoutText(details: unknown): void {
	const records = truncationRecords(details);
	expect(records.some(({ record }) => record.truncated === true)).toBe(true);
	const withText = records.filter(({ record }) => "content" in record).map(({ at }) => at);
	expect(withText).toEqual([]);
	for (const { record } of records) {
		if (record.truncated === true) expect(typeof record.totalLines).toBe("number");
	}
}

describe("a truncated result records its counts, not its text", () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "truncation-summary-"));
		const artifactsDir = path.join(dir, ".artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });

		const lines = Array.from({ length: 3500 }, (_, i) => `line ${i + 1} needle`);
		await fs.writeFile(path.join(dir, "long.txt"), `${lines.join("\n")}\n`);
		await fs.writeFile(path.join(dir, "wide.txt"), `${"x".repeat(200_000)}\nsecond\n`);

		const listing = path.join(dir, "listing");
		await fs.mkdir(listing);
		// Names long enough that the listing passes file search's own 4KB budget too.
		for (let i = 0; i < 120; i++) await fs.writeFile(path.join(listing, `entry-${i}-${"n".repeat(48)}.txt`), "x");

		for (let i = 0; i < 8; i++) {
			await fs.writeFile(path.join(dir, `grouped-${i}.ts`), `${lines.slice(0, 200).join("\n")}\n`);
		}

		const cells = Array.from({ length: 200 }, (_, i) => ({
			cell_type: "code",
			execution_count: null,
			metadata: {},
			outputs: [],
			source: [`value_${i} = ${i}\n`, `print(value_${i})\n`],
		}));
		await fs.writeFile(
			path.join(dir, "book.ipynb"),
			JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }),
		);
		// An archive entry, read through the same in-memory window as a notebook,
		// whose first line passes the byte budget.
		await fs.writeFile(
			path.join(dir, "wide.zip"),
			zip({ "inner.txt": new TextEncoder().encode(`${"w".repeat(200_000)}\nsecond\n`) }),
		);
		const members = Object.fromEntries(
			Array.from({ length: 120 }, (_, i) => [`member-${i}-${"m".repeat(48)}.txt`, new TextEncoder().encode("x")]),
		);
		await fs.writeFile(path.join(dir, "members.zip"), zip(members));

		const db = new Database(path.join(dir, "rows.sqlite"));
		db.run("CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)");
		const insert = db.prepare("INSERT INTO items (label) VALUES (?)");
		for (let i = 0; i < 400; i++) insert.run(`label number ${i}`);
		db.close();

		const settings = Settings.isolated();
		settings.set("tools.artifactSpillThreshold", BUDGET_KB);
		const session = makeToolSession({
			cwd: dir,
			settings,
			skipPythonPreflight: true,
			getArtifactsDir: () => artifactsDir,
		});
		tools = new Map((await createTools(session, ["read", "search"])).map(tool => [tool.name, tool]));
	});

	afterAll(async () => {
		await removeWithRetries(dir);
	});

	it("a file window cut at the line or byte budget", async () => {
		expectCountsWithoutText(await run("read", { path: "long.txt" }));
	});

	it("a first line past the byte budget", async () => {
		expectCountsWithoutText(await run("read", { path: "wide.txt" }));
	});

	it("a directory listing past the budget", async () => {
		expectCountsWithoutText(await run("read", { path: "listing" }));
	});

	it("an archive listing past the budget", async () => {
		expectCountsWithoutText(await run("read", { path: "members.zip" }));
	});

	it("a converted notebook past the budget", async () => {
		expectCountsWithoutText(await run("read", { path: "book.ipynb" }));
	});

	it("an archive entry whose first line passes the byte budget", async () => {
		expectCountsWithoutText(await run("read", { path: "wide.zip:inner.txt" }));
	});

	it("a SQLite table read past the budget", async () => {
		expectCountsWithoutText(await run("read", { path: "rows.sqlite:items?limit=400" }));
	});

	it("a text search over one file past the budget", async () => {
		expectCountsWithoutText(await run("search", { type: "text", input: "needle", path: "long.txt" }));
	});

	it("a text search grouped over many files past the budget", async () => {
		expectCountsWithoutText(await run("search", { type: "text", input: "needle", path: "." }));
	});

	it("a file search past the budget", async () => {
		expectCountsWithoutText(await run("search", { type: "files", input: "listing/*.txt" }));
	});
});
