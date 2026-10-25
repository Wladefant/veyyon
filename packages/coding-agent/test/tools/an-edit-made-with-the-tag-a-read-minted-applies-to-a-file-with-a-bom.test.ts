/**
 * WHY: a whole-file read of a file that opens with a UTF-8 BOM minted a tag no edit could match. The
 * line streamer keeps the BOM on line 1, the read hashed those lines, and the patcher hashes the
 * file BOM-stripped, so an edit made with the tag the read had just printed was "a file changed
 * between read and edit". An edit of line 1 was rejected outright, and the rejection told the
 * model to read again, which printed the same tag; an edit of any other line went through only by
 * stale-tag recovery, with a warning that something else had changed the file. Windows tooling
 * writes that BOM into C#, PowerShell, project and solution files.
 *
 * The class this closes: a tag minted over a form of the text other than the one the patcher
 * hashes. The sweep crosses a BOM and no BOM, LF and CRLF, a final newline and none, with every
 * tag the model edits from -- a whole-file read, a range that shows line 1, a range that does not,
 * a text search -- edits a line that producer displayed, and asserts the edit applies with no
 * warning and changes that line alone, keeping the BOM and the line endings.
 *
 * Not caught: a producer that hashes text itself instead of recording it in the snapshot store,
 * which strips the BOM for every producer that does; the plugin's own suite pins that store rule.
 * A file in a legacy encoding, or one whose lines end in a lone CR, is outside this sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type Tool } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const LINES = ["one", "two", "three", "four"];

interface Shape {
	name: string;
	bom: boolean;
	eol: "\n" | "\r\n";
	finalNewline: boolean;
}

const SHAPES: Shape[] = [true, false].flatMap(bom =>
	(["\n", "\r\n"] as const).flatMap(eol =>
		[true, false].map(finalNewline => ({
			name: `${bom ? "BOM" : "no BOM"}, ${eol === "\n" ? "LF" : "CRLF"}, ${finalNewline ? "final newline" : "no final newline"}`,
			bom,
			eol,
			finalNewline,
		})),
	),
);

function fileBytes(shape: Shape, lines: readonly string[]): string {
	return `${shape.bom ? "\uFEFF" : ""}${lines.join(shape.eol)}${shape.finalNewline ? shape.eol : ""}`;
}

interface Producer {
	name: string;
	/** The lines it displays, any of which an edit may then name. */
	targets: number[];
	mint(tools: Record<string, Tool>, file: string): Promise<string>;
}

const PRODUCERS: Producer[] = [
	{
		name: "a whole-file read",
		targets: [1, 2, 4],
		mint: (tools, file) => run(tools.read, { path: file }),
	},
	{
		name: "a read of a range that shows line 1",
		targets: [1, 2],
		mint: (tools, file) => run(tools.read, { path: `${file}:1-2` }),
	},
	{
		name: "a read of a range that does not show line 1",
		targets: [3, 4],
		mint: (tools, file) => run(tools.read, { path: `${file}:3-4` }),
	},
	{
		name: "a text search",
		targets: [3],
		mint: (tools, file) => run(tools.search, { type: "text", input: "three", path: file }),
	},
];

async function run(tool: Tool | undefined, args: Record<string, unknown>): Promise<string> {
	if (!tool) throw new Error("tool missing");
	const result = await tool.execute("call", args as never, undefined, undefined, undefined);
	return result.content
		.filter(block => block.type === "text")
		.map(block => ("text" in block ? block.text : ""))
		.join("\n");
}

describe("an edit made with the tag a read minted applies to a file with a BOM", () => {
	let dir: string;
	let tools: Record<string, Tool>;

	beforeEach(async () => {
		resetSettingsForTest();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "bom-edit-"));
		await Settings.init({ inMemory: true, cwd: dir });
		const session = makeToolSession({
			cwd: dir,
			hasEditTool: true,
			enableLsp: false,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "read.summarize.enabled": false }),
		});
		tools = Object.fromEntries(
			(await createTools(session, ["read", "edit", "search"])).map(tool => [tool.name, tool]),
		);
	});

	afterEach(async () => {
		resetSettingsForTest();
		await removeWithRetries(dir);
	});

	for (const shape of SHAPES) {
		for (const producer of PRODUCERS) {
			it(`${shape.name}: ${producer.name}`, async () => {
				for (const target of producer.targets) {
					const file = `f${target}.txt`;
					const absolute = path.join(dir, file);
					await fs.writeFile(absolute, fileBytes(shape, LINES));

					const minted = await producer.mint(tools, file);
					const header = /^\[([^\]#\n]+)#([0-9A-F]{4})\]/m.exec(minted);
					expect({ target, header: header !== null }).toEqual({ target, header: true });
					const input = `[${header![1]}#${header![2]}]\nSWAP ${target}.=${target}:\n+CHANGED\n`;

					let outcome: string;
					try {
						outcome = await run(tools.edit, { input });
					} catch (error) {
						outcome = `rejected: ${(error as Error).message.split("\n")[0]}`;
					}
					const warned = /rejected|Recovered|changed (?:between|externally)/.exec(outcome)?.[0];
					expect({ target, warned }).toEqual({ target, warned: undefined });

					const expected = LINES.map((line, index) => (index + 1 === target ? "CHANGED" : line));
					expect({ target, bytes: await fs.readFile(absolute, "utf8") }).toEqual({
						target,
						bytes: fileBytes(shape, expected),
					});
				}
			});
		}
	}
});
