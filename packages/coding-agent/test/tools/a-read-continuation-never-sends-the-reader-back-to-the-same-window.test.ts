/**
 * WHY: a line longer than a read's byte budget sent the reader in a circle. A window that stopped
 * at it said "Use :N to continue"; `:N` padded one line of leading context, collected that line,
 * stopped at N again and said the same. `:N+1` padded with N itself, refused the whole window, and
 * said "Use :N to continue". The refusal's own footer read "Showing 0 of M lines (0B limit). Use :N
 * to continue": the limit it stated was the bytes it had shown, and the line it named was itself.
 * One minified bundle, one-line JSON document or SVG path made every line after it unreachable.
 *
 * The class this closes: a continuation that leads to a window answering with the same
 * continuation, a padded window that never reaches the line the caller asked for, and a notice that
 * states a limit other than the budget the read was held to. The sweep places one oversized line at
 * every position of a short file, starts at the bare path and at every line, in the default display
 * and in `:raw`, through every single-range reader -- a local file read from memory, a local file
 * the line streamer reads because it is CRLF, an archive member, a `local://` resource, a notebook
 * cell the in-memory reader numbers with hashlines, an artifact -- follows each "Use :X to continue"
 * until it stops,
 * and asserts the chain never repeats a selector, never names a line past the end, shows every
 * other line from its start on, names the oversized line in its footer, states no limit but the
 * budget, and points at `:N:raw` only where `:raw` is the file's own bytes.
 *
 * Not caught: a new single-range reader is swept only once it is listed in READERS; multi-range
 * selectors, whose notices name an oversized line and offer no continuation; a URL body, which
 * reaches the in-memory reader the notebook row covers; and a window bounded by its line count.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { LocalProtocolHandler } from "@veyyon/coding-agent/internal-urls";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { createTools, type Tool, type ToolSession } from "@veyyon/coding-agent/tools";
import { inlineBudgetFor } from "@veyyon/coding-agent/tools/core/output-artifact";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { readToolView } from "@veyyon/coding-agent/tools/fs/read-view";
import { zip } from "@veyyon/coding-agent/utils/zip";
import { removeWithRetries } from "@veyyon/utils";
import { formatBytes } from "@veyyon/utils/format";
import type { ToolView } from "@veyyon/view";
import { makeToolSession } from "../helpers/tool-session";

const LINES = 6;
const POSITIONS = Array.from({ length: LINES }, (_, index) => index + 1);
/** A selector-free read, then one starting on every line. */
const STARTS: ReadonlyArray<number | undefined> = [undefined, ...POSITIONS];
type Mode = "default" | "raw";
const BOTH_MODES: readonly Mode[] = ["default", "raw"];

/** Line `n` of a fixture; the oversized one opens with a mark of its own so a raw snippet of it is told apart. */
function rowText(n: number, oversized: number, budget: number): string {
	return n === oversized ? `big${n}${"x".repeat(budget * 2)}` : `row${n}`;
}

function fixtureText(oversized: number, budget: number, eol: string): string {
	return POSITIONS.map(n => rowText(n, oversized, budget)).join(eol);
}

interface Reader {
	name: string;
	/** Whether a refused line points at `:N:raw`, which shows its start only where `:raw` means the file's bytes. */
	offersRaw: boolean;
	/** Lines the read text holds above the fixture's first row. */
	above: number;
	/** The displays in which the read text is the fixture's rows. */
	modes: readonly Mode[];
	/** Writes the fixture and returns the target a read names, without a selector. */
	prepare(dir: string, artifactDir: string, oversized: number, budget: number): Promise<string>;
}

const READERS: readonly Reader[] = [
	{
		name: "a local file read from memory",
		offersRaw: true,
		above: 0,
		modes: BOTH_MODES,
		async prepare(dir, _artifactDir, oversized, budget) {
			const name = `lf-${oversized}.txt`;
			await fs.writeFile(path.join(dir, name), fixtureText(oversized, budget, "\n"));
			return name;
		},
	},
	{
		name: "a CRLF local file the line streamer reads",
		offersRaw: true,
		above: 0,
		modes: BOTH_MODES,
		async prepare(dir, _artifactDir, oversized, budget) {
			const name = `crlf-${oversized}.txt`;
			await fs.writeFile(path.join(dir, name), fixtureText(oversized, budget, "\r\n"));
			return name;
		},
	},
	{
		name: "an archive member",
		offersRaw: false,
		above: 0,
		modes: BOTH_MODES,
		async prepare(dir, _artifactDir, oversized, budget) {
			const name = `arc-${oversized}.zip`;
			const member = new TextEncoder().encode(fixtureText(oversized, budget, "\n"));
			await fs.writeFile(path.join(dir, name), zip({ "m.txt": member }));
			return `${name}:m.txt`;
		},
	},
	{
		name: "an artifact",
		offersRaw: false,
		above: 0,
		modes: BOTH_MODES,
		async prepare(_dir, artifactDir, oversized, budget) {
			await fs.writeFile(path.join(artifactDir, `${oversized}.bash.log`), fixtureText(oversized, budget, "\n"));
			return `artifact://${oversized}`;
		},
	},
	{
		// An internal URL that resolves to a file reads as that file, so its `:raw` is the file's bytes,
		// and its continuations name the URL rather than the path behind it.
		name: "a local:// resource",
		offersRaw: true,
		above: 0,
		modes: BOTH_MODES,
		async prepare(_dir, artifactDir, oversized, budget) {
			const name = `res-${oversized}.txt`;
			await fs.mkdir(path.join(artifactDir, "local"), { recursive: true });
			await fs.writeFile(path.join(artifactDir, "local", name), fixtureText(oversized, budget, "\n"));
			return `local://${name}`;
		},
	},
	{
		// Mutable, so the in-memory reader numbers it with hashlines. Its `:raw` is the notebook's JSON,
		// not the line, so the refusal offers none, and its rows exist only in the editable display,
		// one line under the cell marker.
		name: "a notebook cell the in-memory reader numbers with hashlines",
		offersRaw: false,
		above: 1,
		modes: ["default"],
		async prepare(dir, _artifactDir, oversized, budget) {
			const name = `nb-${oversized}.ipynb`;
			const rows = POSITIONS.map(n => rowText(n, oversized, budget));
			const source = rows.map((row, index) => (index === rows.length - 1 ? row : `${row}\n`));
			const notebook = {
				cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source }],
				metadata: {},
				nbformat: 4,
				nbformat_minor: 5,
			};
			await fs.writeFile(path.join(dir, name), JSON.stringify(notebook));
			return name;
		},
	},
];

interface Chain {
	selectors: string[];
	texts: string[];
	results: Array<{ content: Array<{ type: string; text?: string }>; details?: ReadToolDetails }>;
	repeated: string | undefined;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

/** The selector that starts a chain: `line` of the read text, or no selector at all. */
function selectorFor(target: string, line: number | undefined, mode: Mode, above: number): string {
	if (mode === "raw") return `${target}:${line ?? 1 + above}:raw`;
	return line === undefined ? target : `${target}:${line}`;
}

/** Reads `first`, then whatever each result says to read next, until a result names nothing or a selector comes back. */
async function follow(read: Tool, target: string, first: string): Promise<Chain> {
	const chain: Chain = { selectors: [], texts: [], results: [], repeated: undefined };
	let selector: string | undefined = first;
	// Every hop shows at least one line or steps past one, so a chain longer than the text is a loop.
	while (selector !== undefined && chain.selectors.length <= LINES + 2) {
		if (chain.selectors.includes(selector)) {
			chain.repeated = selector;
			break;
		}
		chain.selectors.push(selector);
		const result = (await read.execute(
			"hop",
			{ path: selector } as never,
			undefined,
			undefined,
			undefined,
		)) as Chain["results"][number];
		const text = textOf(result);
		chain.results.push(result);
		chain.texts.push(text);
		const next = [...text.matchAll(/Use (?:\S+?)?:(\d+(?::raw)?) to continue/g)].at(-1)?.[1];
		selector = next === undefined ? undefined : `${target}:${next}`;
	}
	return chain;
}

/** The text of every span of a drawn view, section by section. */
function viewText(view: ToolView): string {
	if (view.kind !== "framedBlock") return "";
	return view.sections.flatMap(section => section.lines.map(line => line.map(span => span.text).join(""))).join("\n");
}

describe("a read continuation never sends the reader back to the same window", () => {
	let dir: string;
	let artifactDir: string;
	let unregisterArtifactsDir: (() => void) | undefined;
	let session: ToolSession;
	let read: Tool;
	let budget: number;

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-continuation-"));
		artifactDir = path.join(dir, "session");
		await fs.mkdir(artifactDir, { recursive: true });
		resetRegisteredArtifactDirsForTests();
		unregisterArtifactsDir = registerArtifactsDir(artifactDir);
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactDir, getSessionId: () => "session" });
		session = makeToolSession({
			cwd: dir,
			getSessionFile: () => path.join(dir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifactDir,
			// Hashline display, where a clipped line cannot be shown and the refusal is all a read returns.
			hasEditTool: true,
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
		budget = inlineBudgetFor(session);
		const tools = await createTools(session, ["read"]);
		const tool = tools.find(candidate => candidate.name === "read");
		if (!tool) throw new Error("read tool missing");
		read = tool;
	});

	afterAll(async () => {
		unregisterArtifactsDir?.();
		LocalProtocolHandler.resetOverrideForTests();
		resetRegisteredArtifactDirsForTests();
		await removeWithRetries(dir);
	});

	for (const reader of READERS) {
		for (const oversized of POSITIONS) {
			it(`${reader.name}, line ${oversized} over the budget`, async () => {
				const target = await reader.prepare(dir, artifactDir, oversized, budget);
				const limit = formatBytes(budget);
				for (const mode of reader.modes) {
					for (const start of STARTS) {
						const first = selectorFor(
							target,
							start === undefined ? undefined : start + reader.above,
							mode,
							reader.above,
						);
						const chain = await follow(read, target, first);
						const label = `${first} via ${chain.selectors.join(" -> ")}`;
						const all = chain.texts.join("\n");

						expect({ label, repeated: chain.repeated }).toEqual({ label, repeated: undefined });

						const from = start ?? 1;
						const missing = POSITIONS.filter(n => n >= from && n !== oversized && !all.includes(`row${n}`));
						expect({ label, missing }).toEqual({ label, missing: [] });

						// The window that stops at the oversized line says which line it is and what it exceeded.
						const oversizedLine = oversized + reader.above;
						if (oversized >= from) {
							const notice = `[Line ${oversizedLine} exceeds the ${limit} limit`;
							expect({ label, notice: all.includes(notice) }).toEqual({ label, notice: true });
						}

						// A continuation names a line the text has: the last line refused ends the chain.
						const beyond = chain.selectors
							.map(selector => Number(/:(\d+)(?::raw)?$/.exec(selector)?.[1]))
							.filter(line => line > LINES + reader.above);
						expect({ label, beyond }).toEqual({ label, beyond: [] });

						const hint = `Use :${oversizedLine}:raw to see the start of the line.`;
						const hinted = all.includes(hint);
						const wantHint = reader.offersRaw && mode === "default" && oversized >= from;
						if (wantHint || !reader.offersRaw) expect({ label, hinted }).toEqual({ label, hinted: wantHint });

						const stated = [...all.matchAll(/([\d.]+(?:B|KB|MB|GB)) limit/g)].map(match => match[1]);
						expect({ label, stated: stated.filter(value => value !== limit) }).toEqual({ label, stated: [] });
					}
				}
			});
		}
	}

	it("the read card states the budget a refused line exceeded", async () => {
		const target = await READERS[0]!.prepare(dir, artifactDir, 3, budget);
		const chain = await follow(read, target, `${target}:3`);
		const result = chain.results[0]!;
		expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
		const card = viewText(
			readToolView.renderResult(
				{ content: result.content as never, details: result.details },
				{ expanded: false, partial: false },
				{ path: `${target}:3` },
			),
		);
		expect(card).toContain(`First line exceeds ${formatBytes(budget)} limit`);
	});
});
