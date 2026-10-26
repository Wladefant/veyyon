/**
 * Shared helpers and base utilities for command controllers (/mcp, /ssh, /todo, /goal).
 *
 * Consolidates subcommand parsing, routing, source grouping, and transcript block presentation.
 */
import { Markdown } from "@veyyon/tui";
import type { SourceMeta } from "../../../discovery/capability/types";
import { parseSubcommand } from "../../../slash-commands/helpers/parse";
import { getMarkdownTheme } from "../../../theme/markdown-theme";
import { theme } from "../../../theme/theme-binding";
import { shortenPath } from "../../../tools/core/render-utils";
import { COMPOSER_INSET_COLS } from "../components/composer/composer-chrome";
import { mountTranscriptBlock, transcriptBlockText } from "../components/transcript/transcript-block-chrome";
import { TranscriptBlock } from "../components/transcript/transcript-container";
import type { InteractiveModeContext } from "../types";

export interface SubcommandRouteDef {
	name: string;
	aliases?: string[];
	/** Receives the text after the subcommand word, trimmed. */
	handler: (rest: string) => void | Promise<void>;
}

export interface SubcommandDispatchOptions {
	onHelp: () => void;
	showError: (message: string) => void;
}

/**
 * Dispatch a command's arguments to its registered subcommands. `args` is the text the slash dispatcher parsed
 * after the command name, split by the same `parseSubcommand` the text-mode handlers use, so `/mcp list` and
 * `/mcp:list` reach one route on every surface. No subcommand or `help` routes to `onHelp`; an unmatched one
 * shows an error.
 */
export async function dispatchSubcommand(
	args: string,
	commandName: string,
	routes: readonly SubcommandRouteDef[],
	options: SubcommandDispatchOptions,
): Promise<void> {
	const { verb, rest } = parseSubcommand(args);
	if (!verb || verb === "help") {
		options.onHelp();
		return;
	}
	const route = routes.find(candidate => candidate.name === verb || candidate.aliases?.includes(verb));
	if (!route) {
		options.showError(`Unknown subcommand: ${verb}. Type /${commandName} help for usage.`);
		return;
	}
	await route.handler(rest);
}

/**
 * Present a formatted Markdown panel on the transcript rail.
 */
export function showMarkdownPanel(ctx: Pick<InteractiveModeContext, "present">, title: string, markdown: string): void {
	const block = new TranscriptBlock();
	mountTranscriptBlock(block, {
		header: theme.bold(theme.fg("accent", title)),
		body: new Markdown(markdown.trim(), COMPOSER_INSET_COLS, 0, getMarkdownTheme()),
	});
	ctx.present(block);
}

/**
 * Present a plain message block on the transcript rail.
 */
export function showCommandMessage(ctx: Pick<InteractiveModeContext, "present">, text: string): void {
	const block = new TranscriptBlock();
	mountTranscriptBlock(block, { body: transcriptBlockText(text) });
	ctx.present(block);
}

/**
 * Group capability-loaded items by their source provider+path, yielding each
 * group with a display-ready `shortPath`.
 */
export function* groupBySource<T>(
	items: Iterable<T>,
	getSource: (item: T) => SourceMeta,
): Iterable<{ providerName: string; shortPath: string; items: T[] }> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const src = getSource(item);
		const key = `${src.providerName}|${src.path}`;
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
		}
		group.push(item);
	}
	for (const [key, grouped] of groups) {
		const sepIdx = key.indexOf("|");
		yield {
			providerName: key.slice(0, sepIdx),
			shortPath: shortenPath(key.slice(sepIdx + 1)),
			items: grouped,
		};
	}
}
