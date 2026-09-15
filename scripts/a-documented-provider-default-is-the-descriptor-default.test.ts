/**
 * A provider's default model, written into prose, is the one its descriptor states.
 *
 * THE DEFECT. Command Code's default moved from `moonshotai/Kimi-K2.7-Code` to
 * `claude-sonnet-4-6` in `CATALOG_PROVIDERS`. Three documents name that default and two kept the
 * old one: `docs/handbook/src/reference/providers.md` and `packages/ai/README.md`. A reader
 * following either configured a model the provider no longer defaults to, and nothing went red.
 *
 * THE CLASS. One fact, four owners: the descriptor, and every page that repeats it. The settings
 * tables had the same shape of drift and got `settings-doc-coherence.test.ts`; this is the same
 * gate for provider defaults. Every statement is found at run time by scanning the pages, and the
 * descriptor list comes from `CATALOG_PROVIDERS` rather than a copy, so a provider added or a
 * default changed is covered without touching this file.
 *
 * HOW A STATEMENT IS FOUND. A prose sentence or a table row that names exactly one provider — by
 * its discovery label ("Command Code") or its backticked id (`command-code`) — and states a
 * backticked default in the same scope. Exactly one, because a sentence naming two providers
 * cannot say which default belongs to which; those are skipped rather than guessed, and that is
 * the gap: a default stated in a sentence that names two providers is not checked.
 *
 * WHAT ELSE IT DOES NOT CATCH. A default that is wrong in the descriptor itself. This proves the
 * pages agree with the code, not that the code is right about the provider.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderCatalogEntry } from "@veyyon/catalog/provider-models/descriptor-types";
import { CATALOG_PROVIDERS } from "@veyyon/catalog/provider-models/descriptors";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The pages that state a provider default in prose. A page that starts stating one joins this list. */
const PAGES = [
	"docs/handbook/src/reference/providers.md",
	"docs/handbook/src/reference/environment-complete.md",
	"packages/ai/README.md",
] as const;

/**
 * Providers a document can name: a discovery label is the human spelling a page uses.
 *
 * Annotated rather than cast, so the table ceasing to be a list of catalog entries is a type
 * error here rather than a silently empty sweep.
 */
const CATALOG_ENTRIES: readonly ProviderCatalogEntry[] = CATALOG_PROVIDERS;
const NAMEABLE = CATALOG_ENTRIES.flatMap(provider => {
	const label = provider.catalogDiscovery?.label;
	return label === undefined ? [] : [{ id: provider.id, label, defaultModel: provider.defaultModel }];
});

/** `defaults to \`x\``, `default model: \`x\``, or a table cell's `default \`x\``. */
const DEFAULT_STATEMENT = /default(?:s to| model:|)\s+(?:the tool-capable\s+)?`([^`]+)`/;

interface Statement {
	readonly page: string;
	readonly line: number;
	readonly provider: string;
	readonly stated: string;
	readonly descriptor: string;
}

/**
 * A table row is one scope because its cells split the provider from the default; prose splits on
 * sentences so a paragraph covering several providers is read one provider at a time.
 */
function scopesOf(line: string): string[] {
	return line.trimStart().startsWith("|") ? [line] : line.split(/(?<=\.)\s+/);
}

function statementsIn(page: string): Statement[] {
	const found: Statement[] = [];
	const lines = readFileSync(join(REPO_ROOT, page), "utf8").split("\n");
	for (const [index, line] of lines.entries()) {
		for (const scope of scopesOf(line)) {
			const stated = scope.match(DEFAULT_STATEMENT)?.[1];
			if (stated === undefined) continue;
			const named = NAMEABLE.filter(
				provider => scope.includes(provider.label) || scope.includes(`\`${provider.id}\``),
			);
			if (named.length !== 1) continue;
			const provider = named[0];
			if (provider === undefined) continue;
			found.push({
				page,
				line: index + 1,
				provider: provider.id,
				stated,
				descriptor: provider.defaultModel,
			});
		}
	}
	return found;
}

const STATEMENTS = PAGES.flatMap(statementsIn);

describe("a documented provider default is the descriptor default", () => {
	/** A matcher that quietly stops matching would make every assertion below vacuously green. */
	it("finds the default statements the pages carry", () => {
		expect(STATEMENTS.length).toBeGreaterThanOrEqual(6);
		expect([...new Set(STATEMENTS.map(statement => statement.page))].sort()).toEqual([...PAGES].sort());
	});

	/** The providers whose defaults are documented at all, so a page dropping one is visible. */
	it("covers the providers the pages name", () => {
		expect([...new Set(STATEMENTS.map(statement => statement.provider))].sort()).toEqual([
			"command-code",
			"nous-research",
		]);
	});

	/** THE ASSERTION. Every stated default equals the descriptor's, reported with its exact site. */
	it("states the descriptor's model everywhere it states a default", () => {
		const wrong = STATEMENTS.filter(statement => statement.stated !== statement.descriptor).map(
			statement =>
				`${statement.page}:${statement.line} says ${statement.provider} defaults to ${statement.stated}, descriptor says ${statement.descriptor}`,
		);

		expect(wrong).toEqual([]);
	});
});
