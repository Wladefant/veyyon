/**
 * Every `veyyon …` command line the handbook shows parses with the parser that will receive it.
 *
 * WHY THIS SUITE EXISTS. The install guide documents `veyyon rollback 1.1.0`, and the shipped binary
 * answered it with `Error: Unexpected argument: "1.1.0"` at exit 2. The rollback command read its
 * version from the raw argv without declaring it, and the parser later learned to refuse a positional
 * no declared argument consumes. Both halves were correct on their own; the documented command line
 * was the only thing that showed they disagreed, and nothing ran it.
 *
 * The class is "the manual promises a command line the parser refuses". The sweep walks every code
 * block under `docs/handbook/src`, takes each line that runs `veyyon` or `vey`, and parses it: a
 * subcommand through that command's own declared flags and args, and a launch (bare, `launch` or
 * `acp`) through the launch parser, which must recognize every flag the line passes. A new page or a
 * new example is covered without being listed.
 *
 * NOT CAUGHT: a line using shell syntax (a pipe, `&&`, `$VAR`, a `\` continuation) is skipped rather
 * than guessed at, and a line that parses but means something other than its prose says. Values are
 * checked only where the parser checks them.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { commands } from "@veyyon/coding-agent/cli-commands";
import type { CliConfig, CommandCtor } from "@veyyon/utils/cli";

const HANDBOOK = path.join(import.meta.dirname, "../../../../docs/handbook/src");

/** Commands whose `run()` hands the argv to the launch parser instead of declaring flags. */
const LAUNCH_PARSED = new Set(["launch", "acp"]);

const ctors = new Map<string, CommandCtor>();
for (const entry of commands) {
	ctors.set(entry.name, (await entry.load()) as CommandCtor);
}
const cliConfig = { bin: "veyyon", version: "0.0.0", commands: ctors } as CliConfig;

/** The words of a shell line with quotes removed, or null when the line uses shell syntax. */
function shellWords(line: string): string[] | null {
	const words: string[] = [];
	let word = "";
	let quote: string | null = null;
	let started = false;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			else word += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (started) words.push(word);
			word = "";
			started = false;
			continue;
		}
		if (ch === "#" && !started) break;
		if ("|&;$`\\".includes(ch)) return null;
		word += ch;
		started = true;
	}
	if (quote) return null;
	if (started) words.push(word);
	return words;
}

interface DocumentedLine {
	where: string;
	words: string[];
}

/** Every `veyyon`/`vey` line inside a fenced code block of the handbook, as words after the binary. */
function documentedLines(): { lines: DocumentedLine[]; skipped: number } {
	const lines: DocumentedLine[] = [];
	let skipped = 0;
	const files = fs
		.readdirSync(HANDBOOK, { recursive: true, encoding: "utf8" })
		.filter(file => file.endsWith(".md"))
		.sort();
	for (const file of files) {
		const text = fs.readFileSync(path.join(HANDBOOK, file), "utf8").split("\n");
		let inBlock = false;
		text.forEach((line, index) => {
			if (/^\s*```/.test(line)) {
				inBlock = !inBlock;
				return;
			}
			if (!inBlock) return;
			const match = /^\s*(?:\$\s+)?(?:veyyon|vey)(?:\s+(.*))?$/.exec(line);
			if (!match) return;
			const words = shellWords(match[1] ?? "");
			if (words === null) {
				skipped++;
				return;
			}
			lines.push({ where: `${file}:${index + 1}: ${line.trim()}`, words });
		});
	}
	return { lines, skipped };
}

/** Why `words` fails to parse, or null when it parses. */
async function parseFailure(words: string[]): Promise<string | null> {
	const ctor = words.length > 0 ? ctors.get(words[0]) : undefined;
	if (ctor && !LAUNCH_PARSED.has(words[0])) {
		const instance = new ctor(words.slice(1), cliConfig) as unknown as { parse(cmd: CommandCtor): Promise<unknown> };
		try {
			await instance.parse(ctor);
			return null;
		} catch (error) {
			return (error as Error).message;
		}
	}
	const launchArgs = ctor ? words.slice(1) : words;
	try {
		const parsed = parseArgs(launchArgs);
		return parsed.unrecognizedFlags.length > 0 ? `unknown flag ${parsed.unrecognizedFlags.join(", ")}` : null;
	} catch (error) {
		return (error as Error).message;
	}
}

const { lines, skipped } = documentedLines();

describe("every documented command line", () => {
	it("parses with the parser that receives it", async () => {
		const failures: string[] = [];
		for (const line of lines) {
			const failure = await parseFailure(line.words);
			if (failure !== null) failures.push(`${line.where} -> ${failure}`);
		}

		expect(failures).toEqual([]);
	});

	/** The reported line, by content: the install guide's rollback example names a version. */
	it("includes the rollback example and parses its version", async () => {
		const rollback = lines.find(
			line => line.words[0] === "rollback" && line.words.length === 2 && /^\d+\.\d+\.\d+$/.test(line.words[1]),
		);

		expect(rollback?.where).toContain("install.md");
		expect(await parseFailure(rollback?.words ?? [])).toBeNull();
	});

	/** Anti-vacuity: the sweep found the handbook's examples, and skipped few of them. */
	it("reads the handbook's command lines", () => {
		const subcommands = lines.filter(line => ctors.has(line.words[0]) && !LAUNCH_PARSED.has(line.words[0]));

		expect(subcommands.length).toBeGreaterThan(100);
		expect(lines.length - subcommands.length).toBeGreaterThan(40);
		expect(skipped).toBeLessThan(lines.length / 10);
	});
});
