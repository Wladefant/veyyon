/**
 * WHY: a Public Web search whose engines were partly bot-walled and partly answered with no
 * results reported `All public engines failed: startpage: …; mojeek: …`. The engine that answered
 * with nothing was left out, so a narrow query (a `site:` filter plus quoted phrases) that found
 * nothing read as a search blocked everywhere, and the caller retried the same query instead of
 * loosening it.
 *
 * The class this closes: an aggregate that returns no result misstates what an engine did. Every
 * assignment of an outcome (results, no results, failure, no answer by the deadline) to every
 * engine in `PUBLIC_ENGINE_IDS` is run, the membership read at run time so a new engine joins the
 * sweep. For each assignment without a result, the error names each engine once under the outcome
 * it had, says "All public engines failed" only when all of them failed, and carries 504 when an
 * engine did not answer and 503 otherwise. Every assignment terminates within the hard deadline.
 *
 * What it does not catch: an engine excluded by settings, which the fan-out never starts, and the
 * per-engine classification of a page as a wall or an empty result, which
 * `a-bot-wall-served-at-200-is-not-search-content.test.ts` owns.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import { WebSearchTool } from "@veyyon/coding-agent/tools/web/search";
import * as providerModule from "@veyyon/coding-agent/tools/web/search/provider";
import { setPreferredSearchProvider } from "@veyyon/coding-agent/tools/web/search/provider";
import { type SearchParams, SearchProvider } from "@veyyon/coding-agent/tools/web/search/providers/base";
import {
	PUBLIC_ENGINE_IDS,
	PublicWebProvider,
	searchPublicWeb,
} from "@veyyon/coding-agent/tools/web/search/providers/public";
import {
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
} from "@veyyon/coding-agent/tools/web/search/types";
import { useIsolatedAgentDir } from "../../../helpers/isolated-agent-dir";
import { makeToolSession } from "../../../helpers/tool-session";

useIsolatedAgentDir();

type Outcome = "results" | "empty" | "fail" | "stall";
const OUTCOMES: readonly Outcome[] = ["results", "empty", "fail", "stall"];
type Assignment = Record<string, Outcome>;

const SOFT_MS = 5;
const HARD_MS = 40;

const AUTH_STORAGE = {
	hasAuth: () => false,
	hasOAuth: () => false,
	getApiKey: async () => undefined,
} as unknown as AuthStorage;

/** An engine that does what the assignment encoded in the query tells it to. */
class ScriptedEngine extends SearchProvider {
	readonly id: SearchProviderId;
	readonly label: string;
	constructor(id: SearchProviderId) {
		super();
		this.id = id;
		this.label = id;
	}
	isAvailable(): boolean {
		return true;
	}
	search(params: SearchParams): Promise<SearchResponse> {
		const outcome = (JSON.parse(params.query) as Assignment)[this.id];
		if (outcome === "results") {
			return Promise.resolve({
				provider: this.id,
				sources: [{ title: `${this.id} hit`, url: `https://example.com/${this.id}` }],
			});
		}
		if (outcome === "empty") return Promise.resolve({ provider: this.id, sources: [] });
		if (outcome === "fail") return Promise.reject(new SearchProviderError(this.id, `${this.id} wall (fixture)`, 429));
		const { promise, reject } = Promise.withResolvers<SearchResponse>();
		params.signal?.addEventListener("abort", () => reject(params.signal?.reason), { once: true });
		return promise;
	}
}

function scriptEngines(): void {
	const aggregate = new PublicWebProvider();
	const engines = new Map<SearchProviderId, ScriptedEngine>();
	vi.spyOn(providerModule, "getSearchProvider").mockImplementation(async id => {
		if (id === "public") return aggregate;
		let engine = engines.get(id);
		if (!engine) {
			engine = new ScriptedEngine(id);
			engines.set(id, engine);
		}
		return engine;
	});
}

function everyAssignment(): Assignment[] {
	let assignments: Assignment[] = [{}];
	for (const id of PUBLIC_ENGINE_IDS) {
		assignments = assignments.flatMap(partial => OUTCOMES.map(outcome => ({ ...partial, [id]: outcome })));
	}
	return assignments;
}

const enginesWith = (assignment: Assignment, outcome: Outcome): string[] =>
	PUBLIC_ENGINE_IDS.filter(id => assignment[id] === outcome).sort();

/** The engines a message lists before `suffix`, sorted, or none when the clause is absent. */
function listedBefore(message: string, suffix: string): string[] {
	const match = new RegExp(`([a-z]+(?:, [a-z]+)*) ${suffix}`).exec(message);
	return match ? match[1].split(", ").sort() : [];
}

afterEach(() => {
	vi.restoreAllMocks();
	setPreferredSearchProvider("auto");
});

describe("a Public Web search with no result states what each engine did", () => {
	it("names every engine under its own outcome, for every assignment of outcomes", async () => {
		scriptEngines();
		const assignments = everyAssignment();
		expect(assignments.length).toBe(OUTCOMES.length ** PUBLIC_ENGINE_IDS.length);

		const settled = await Promise.all(
			assignments.map(async assignment => {
				const started = performance.now();
				try {
					const response = await searchPublicWeb(
						{ query: JSON.stringify(assignment), systemPrompt: "", authStorage: AUTH_STORAGE },
						{ softMs: SOFT_MS, hardMs: HARD_MS },
					);
					return { assignment, response, error: undefined, ms: performance.now() - started };
				} catch (error) {
					return { assignment, response: undefined, error, ms: performance.now() - started };
				}
			}),
		);

		for (const { assignment, response, error, ms } of settled) {
			const label = JSON.stringify(assignment);
			expect(ms, label).toBeLessThan(HARD_MS + 2_000);

			const withResults = enginesWith(assignment, "results");
			const empty = enginesWith(assignment, "empty");
			const failed = enginesWith(assignment, "fail");
			const stalled = enginesWith(assignment, "stall");

			if (withResults.length > 0) {
				expect(error, label).toBeUndefined();
				expect(response?.sources.map(source => source.url).sort(), label).toEqual(
					withResults.map(id => `https://example.com/${id}`).sort(),
				);
				continue;
			}
			if (empty.length === PUBLIC_ENGINE_IDS.length) {
				expect(error, label).toBeUndefined();
				expect(response?.sources, label).toEqual([]);
				continue;
			}

			expect(error, label).toBeInstanceOf(SearchProviderError);
			const providerError = error as SearchProviderError;
			expect(providerError.provider, label).toBe("public");
			expect(providerError.status, label).toBe(stalled.length > 0 ? 504 : 503);
			const message = providerError.message;
			expect(listedBefore(message, "did not answer\\."), label).toEqual(stalled);
			expect(listedBefore(message, "found no results for this query\\."), label).toEqual(empty);
			for (const id of PUBLIC_ENGINE_IDS) {
				expect(message.includes(`${id}: ${id} wall (fixture)`), `${label} ${id}`).toBe(failed.includes(id));
			}
			expect(message.startsWith("All public engines failed:"), label).toBe(
				failed.length === PUBLIC_ENGINE_IDS.length,
			);
		}
	});

	it("shows the engine that found nothing in the web_search tool result", async () => {
		scriptEngines();
		setPreferredSearchProvider("public");
		const [quiet, ...walled] = PUBLIC_ENGINE_IDS;
		const assignment: Assignment = { [quiet]: "empty", ...Object.fromEntries(walled.map(id => [id, "fail"])) };

		const tool = new WebSearchTool(makeToolSession({ authStorage: AUTH_STORAGE }));
		const result = await tool.execute("call-1", { query: JSON.stringify(assignment) });

		const block = result.content[0];
		const text = block && "text" in block ? block.text : "";
		expect(text).toStartWith("Error: No public engine returned a result.");
		expect(text).toContain(`${quiet} found no results for this query.`);
		for (const id of walled) expect(text).toContain(`${id}: ${id} wall (fixture)`);
		expect(result.details?.error).toBe(text.slice("Error: ".length));
	});
});
