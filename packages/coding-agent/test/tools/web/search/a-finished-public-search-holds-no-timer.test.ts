/**
 * WHY: the credential-free web search raced its soft deadline and its extended wait against
 * `Bun.sleep` calls that nothing cancelled. A search that settled early left those timers running
 * for the rest of the deadline, so a process embedding the search (an SDK caller, a script) stayed
 * alive up to the full hard deadline after its answer arrived.
 *
 * The class: every timer a public search arms ends when the search returns, whichever wait ended
 * it. Each case runs a search in a child process whose only remaining work would be such a timer,
 * with deadlines far beyond the spawn bound, and asserts the child exits on its own.
 *
 * Not caught: a timer that is unref'd yet never cleared (it no longer holds the process open), and
 * timers armed by an engine's own transport rather than by the fan-out.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { hermeticSpawnEnv } from "../../../helpers/hermetic-spawn-env";

const providerUrl = new URL("../../../../src/tools/web/search/provider.ts", import.meta.url).href;
const publicUrl = new URL("../../../../src/tools/web/search/providers/public.ts", import.meta.url).href;

/** Far beyond the spawn bound: a timer left armed for this long fails the case by timeout. */
const LINGER_MS = 120_000;
/** Bun start-up and the search import graph, with room for a loaded machine. */
const SPAWN_BOUND_MS = 30_000;

const DDG_RESULT = `<div class="result results_links results_links_deep web-result"><a class="result__a" href="https://a.example/one">Alpha</a><a class="result__snippet" href="https://a.example/one">alpha snippet</a></div>`;

/**
 * A child that runs one search against two scripted engines and prints its source URLs. DuckDuckGo
 * answers with one result after `ddgDelayMs`; Google answers an empty page at once, or with
 * `googleHangs` never answers until the fan-out cancels it.
 */
function probe(
	deadlines: { softMs: number; hardMs: number },
	engines: { ddgDelayMs: number; googleHangs: boolean },
): string {
	return `
const { setExcludedSearchProviders } = await import(${JSON.stringify(providerUrl)});
const { searchPublicWeb } = await import(${JSON.stringify(publicUrl)});
setExcludedSearchProviders(["startpage", "mojeek"]);
const body = ${JSON.stringify(DDG_RESULT)};
const fetch = (input, init) => {
	const url = String(input);
	if (url.includes("duckduckgo.com")) {
		return new Promise(resolve => setTimeout(() => resolve(new Response(body, { status: 200 })), ${engines.ddgDelayMs}));
	}
	if (!${engines.googleHangs}) return Promise.resolve(new Response("<html></html>", { status: 200 }));
	const pending = Promise.withResolvers();
	init?.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
	return pending.promise;
};
const authStorage = { getApiKey() { throw new Error("no keys"); } };
const response = await searchPublicWeb(
	{ query: "timer probe", authStorage, systemPrompt: "probe", fetch },
	${JSON.stringify(deadlines)},
);
console.log(JSON.stringify(response.sources.map(source => source.url)));
`;
}

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

function runProbe(code: string): { status: number | null; stdout: string; stderr: string } {
	const spawnEnv = hermeticSpawnEnv();
	cleanup = spawnEnv.cleanup;
	const run = spawnSync(process.execPath, ["-e", code], {
		encoding: "utf8",
		env: spawnEnv.env,
		timeout: SPAWN_BOUND_MS,
	});
	return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
}

describe("a finished public web search holds no timer", () => {
	it(
		"lets the process exit when every engine answers early, not when the soft deadline would fire",
		() => {
			// Both engines answer at once, so the fan-out settles long before the soft deadline.
			const result = runProbe(
				probe({ softMs: LINGER_MS, hardMs: LINGER_MS * 2 }, { ddgDelayMs: 0, googleHangs: false }),
			);
			expect(result).toEqual({ status: 0, stdout: '["https://a.example/one"]', stderr: "" });
		},
		SPAWN_BOUND_MS + 5_000,
	);

	it(
		"lets the process exit when the first result ends the extended wait, not when the hard deadline would fire",
		() => {
			// No engine has results at the 10ms soft deadline, so the fan-out waits on. DuckDuckGo's
			// result at 50ms ends that wait; the extended timer must end with it.
			const result = runProbe(probe({ softMs: 10, hardMs: LINGER_MS }, { ddgDelayMs: 50, googleHangs: true }));
			expect(result).toEqual({ status: 0, stdout: '["https://a.example/one"]', stderr: "" });
		},
		SPAWN_BOUND_MS + 5_000,
	);
});
