/**
 * Contract: the modules that only need a helper stop at the module that declares it.
 *
 * TWO EDGES, ONE SHAPE. Both were found by ranking import edges by MARGINAL cost, which is
 * `reach(file) - |{file} ∪ reach(every OTHER target of file)|`, rather than by how much a file
 * reaches in total. A reached total says nothing: cutting one of three paths to a heavy module moves
 * nothing, and a file that reaches 400 modules through an edge worth 5 is not the problem it looks
 * like.
 *
 *   - `diagnose.ts` runs schema and integrity checks over the database. It took `initBeam` from
 *     `core/beam`, the engine barrel, which reaches 402 modules: the recall path, consolidation, the
 *     episodic graph, the annotation store, the LLM tiers behind them. `initBeam` is declared in
 *     `core/beam/schema.ts`, which reaches ONE. 403 modules -> 92.
 *   - `core/local-llm.ts` took three runtime names and four types from the `@veyyon/ai` entry point
 *     in one clause. The entry point re-exports the package; the types are erased and free. 369 -> 306,
 *     and `core/extraction.ts` behind it 370 -> 307.
 *
 * WHY LOCAL-LLM KEEPS THE ENGINE, and why that is not a failure of the cut: it calls
 * `completeSimple`. A module that runs a completion has to load the thing that runs completions. What
 * changed is that `withAuth` and `assistantText` no longer arrive with the whole package attached.
 *
 * WHY A RATCHET. Nothing fails when either import comes back. The code works and the tests pass; only
 * cold start and the honesty of the graph move, so the numbers are pinned along with the specifiers,
 * because a count cannot say WHY a file grew and a specifier cannot catch a file that grew otherwise.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
	moduleSpecifiersIn,
	typeOnlyModuleSpecifiersIn,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

function reach(relative: string): number {
	return moduleReachCount(path.join(SRC, relative), RESOLUTION, CACHE);
}

function reachedNames(relative: string): string[] {
	return [...moduleReach(path.join(SRC, relative), RESOLUTION, CACHE)]
		.map(file => path.relative(REPO_ROOT, file))
		.sort();
}

function runtimeImportsOf(relative: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(path.join(SRC, relative), "utf-8"));
}

/**
 * A path inside THIS package, repo-relative. Pinned as a literal, every row below asserted about a
 * directory rather than about this package: the negatives passed for free once the package moved,
 * and the non-vacuity rows -- the ones that make the negatives mean anything -- went red.
 */
function own(...segments: string[]): string {
	return path.relative(REPO_ROOT, path.join(SRC, ...segments));
}

describe("the diagnostics run without the memory engine", () => {
	/** Measured at 15: the config, the database helpers, the datetime and sqlite utilities. */
	it("diagnose reaches at most 25 modules", () => {
		expect(reach("diagnose.ts")).toBeLessThanOrEqual(25);
	});

	/**
	 * The absences, NAMED rather than counted, because a ceiling cannot say which subsystem came
	 * back. Each of these is one import away and none of them is needed to ask whether a table exists.
	 */
	it("reaches none of the engine it used to carry", () => {
		const reached = reachedNames("diagnose.ts");

		expect(reached).not.toContain(own("core", "beam", "index.ts"));
		expect(reached).not.toContain(own("core", "beam", "recall.ts"));
		expect(reached).not.toContain(own("core", "extraction.ts"));
		expect(reached).not.toContain(path.join("packages", "ai", "src", "stream.ts"));
	});

	/**
	 * NON-VACUITY: the walk really resolved this module, so the absences above are a fact about the
	 * graph rather than what an unresolvable path gives for free. The edges are named rather than
	 * counted, because a magnitude proxy stops meaning anything the moment the graph legitimately
	 * shrinks. The schema owner is the edge that has to survive, since a diagnostic that cannot
	 * initialise a schema cannot check one, and it opens that schema through the sqlite helpers.
	 */
	it("still reaches the schema owner it initialises with", () => {
		const reached = reachedNames("diagnose.ts");

		expect(reached).toContain(own("core", "beam", "schema.ts"));
		expect(reached).toContain(own("db.ts"));
		expect(reached).toContain(path.join("packages", "utils", "src", "sqlite.ts"));
	});

	/**
	 * Asserted as SPECIFIERS, which is the assertion that names the fix. `./core/beam` and
	 * `./core/beam/schema` export the same `initBeam` under the same name, compile identically and
	 * behave identically; they differ by 109 modules and nothing else here would notice the swap.
	 */
	it("names the schema owner and neither barrel", () => {
		const imports = runtimeImportsOf("diagnose.ts");

		expect(imports).toContain("./core/beam/schema");
		expect(imports).toContain("@veyyon/utils/type-guards");
		expect(imports).not.toContain("./core/beam");
		expect(imports).not.toContain("@veyyon/utils");
	});

	/**
	 * And it is the SAME function, compared by identity across the two spellings. A barrel that
	 * re-exported a different implementation would satisfy every case above and hand two callers
	 * different schemas, which is the one failure this cut must not introduce.
	 */
	it("the barrel and the owner export one function", async () => {
		const [barrel, owner] = await Promise.all([import("../src/core/beam"), import("../src/core/beam/schema")]);

		expect(barrel.initBeam).toBe(owner.initBeam);
	});
});

describe("asking whether a model is configured is not calling one", () => {
	/**
	 * THE CASCADE, pinned at every hop. `core/local-llm.ts` handles two concerns in one module:
	 * configuration and prompt text, which is lightweight, and the round trip through
	 * `completeSimple`, which is the streaming engine. `core/extraction.ts` reads the configuration
	 * on every path, `core/beam/consolidate.ts` sits behind extraction, and `core/beam/index.ts` sits
	 * behind consolidate.
	 *
	 * Measured after replacing the `@veyyon/utils` barrel with direct subpath imports: the config
	 * half 9, extraction 14, consolidate 99, the beam engine 110, the MCP server 114. The barrel
	 * edge is gone, each module specifies the utils owner it uses, and the count reflects mnemopi's
	 * own graph rather than the utils barrel size. Every ceiling below is pinned with a small
	 * headroom above the measured value.
	 */
	it.each([
		["core/local-llm-config.ts", 16],
		["core/extraction.ts", 22],
		["core/beam/consolidate.ts", 108],
		["core/beam/index.ts", 120],
		["mcp-server.ts", 125],
	])("%s reaches at most %i modules", (relative, ceiling) => {
		expect(reach(relative)).toBeLessThanOrEqual(ceiling);
	});

	/**
	 * The calling half keeps the engine, because calling a model requires the streaming engine.
	 * Measured at 203 at a731819167a766190b7d6958cff5e4da6c239af0 (the commit that also set 215).
	 * Static attribution of the growth since then, module and introducing commit, 203 -> 222 at HEAD:
	 *   + packages/utils/src/backoff.ts                        cfc7fb6a44dd9732aaaac5eabb0455dfcfd24bb3 (stream.ts:21)
	 *   + packages/utils/src/local-time.ts                     dd058dd817406518965f2aaa7a679cd38e21f91f (logger.ts:17)
	 *   + packages/utils/src/log-file.ts                       4b93b43081fb4acc82248009d90324042c8afeca (logger.ts:18)
	 *   + packages/utils/src/ansi.ts                           668d5b967b675a24f5ebb0341206bbabd154eeba (sanitize-text.ts:15)
	 *   + packages/catalog/src/catalog-spans.ts                3e36ec07281752a4eb1e33f839238b9d2a55eca1 (models.ts:5)
	 *   + packages/catalog/src/types.ts                        f3bc816b7a6c1c535ea614c24d534f0313ca0854 (models.ts:8)
	 *   + packages/catalog/src/compat/share.ts                 20d1928c75bec5d9e1c29fa1810156b199156b21 (build.ts:17)
	 *   + packages/catalog/src/discovery/chatgpt-web.ts        a96b3dac0e43c8ea565a6957067be95c2bcb98ee
	 *   + packages/catalog/src/provider-models/chatgpt-web.ts  a96b3dac0e43c8ea565a6957067be95c2bcb98ee
	 *   + packages/catalog/src/provider-models/command-code.ts ca5c55df9540c9d2c25b17be97970a8170e9d309
	 *   + packages/catalog/src/provider-models/models-dev-policies.ts 21600d65d941613a48aa832a16a2010ee10ec23b
	 *   + packages/catalog/src/discovery/failure.ts            084973bfe48f929c629124cf46781a394e1af22a
	 *   + packages/catalog/src/discovery/typesafe.ts           5fcd8e4a24c6d8b2b0c76ef040a8881d852fe0a7
	 *   + packages/catalog/src/wire/opencode-headers.ts (and package.json) 731fdd71c34861a4dd69d1ed13c8cbdce6755a5b
	 *   + packages/catalog/src/provider-models/codex-subscription.ts d789b0c361168ea9f1054619a2465ba6974dada5
	 *   + packages/ai/src/dialect/bracket-walk.ts              90dbb499bf5e48d76b1e868520b1defdf4ab9f5a (gemini.ts:3)
	 *   + packages/ai/src/dialect/json-tool-call-scanner.ts    a9a2cf98de439846f195a453b604b4aedfc9081e (hermes.ts:2)
	 *   + contracts/model/src/{service-tier,effort,model,stream-block}.ts fbc069ac221bee7968fe5b0f8bcc9cf4a3d2c4d7
	 *   - removed: ai/providers/gitlab-duo-workflow.ts, ai/utils.ts, ai/utils/first-event-budget.ts
	 * +1 at the working tree: the interactive-host leaf that ReachRepairs added (utils env.ts re-export).
	 * 223 total. The growth is deliberate. stream.ts importing `discardAttemptUsage` from the catalog
	 * models registry adds no reach and is not credited. `models.ts` is already eagerly reached through
	 * `emptyUsage` in `providers/pi-native-client.ts` and `providers/register-builtins.ts`, both imported
	 * eagerly by stream.ts (since 9f62a780cd, 2026-07-19). The stream edge itself came later, in
	 * 7bc6222b79 (2026-08-10). Moving the helper therefore removes no module, so no ceiling is cut for it.
	 */
	it("local-llm reaches at most 223 modules", () => {
		expect(reach("core/local-llm.ts")).toBeLessThanOrEqual(223);
	});

	/**
	 * The absences that make the ceilings meaningful, NAMED. Extraction must not reach the engine or
	 * the calling half statically; if it does, the deferral was undone and only the number moved.
	 */
	it("extraction reaches neither the engine nor the calling half", () => {
		const reached = reachedNames("core/extraction.ts");

		expect(reached).not.toContain(path.join("packages", "ai", "src", "stream.ts"));
		expect(reached).not.toContain(own("core", "local-llm.ts"));
	});

	/**
	 * NON-VACUITY: it still reaches the CONFIG half, which is what it asks its questions of. Without
	 * this, deleting the import entirely would satisfy every absence above.
	 */
	it("extraction still reaches the configuration it reads", () => {
		expect(reachedNames("core/extraction.ts")).toContain(own("core", "local-llm-config.ts"));
	});

	/**
	 * THE DEFERRAL ITSELF, by specifier, in both spellings. A reach count cannot tell a deferred edge
	 * from a deleted one, and `import(x)` and `import ... from x` name the same path, so the static
	 * form is asserted absent and the dynamic form present. Without the second half, a change that
	 * dropped the LLM call entirely would pass everything above.
	 */
	it("loads the calling half dynamically, and only dynamically", () => {
		const source = fs.readFileSync(path.join(SRC, "core", "extraction.ts"), "utf-8");

		expect(runtimeImportsOf("core/extraction.ts")).not.toContain("./local-llm");
		expect(source).toContain('import("./local-llm")');
		expect(source).toContain("llmClient()");
	});

	/**
	 * NON-VACUITY, and the case that keeps the ceiling honest: the engine is still reached, because
	 * this module calls it. A "cut" that lost `completeSimple` would pass the ceiling above and break
	 * every remote completion.
	 */
	it("still reaches the streaming engine it calls", () => {
		expect(reachedNames("core/local-llm.ts")).toContain(path.join("packages", "ai", "src", "stream.ts"));
	});

	/** The three owners named, and the entry point absent. */
	it("names three owners rather than the package entry point", () => {
		const imports = runtimeImportsOf("core/local-llm.ts");

		expect(imports).toContain("@veyyon/ai/stream");
		expect(imports).toContain("@veyyon/ai/auth-retry");
		expect(imports).toContain("@veyyon/ai/utils/message-text");
		expect(imports).not.toContain("@veyyon/ai");
	});

	/**
	 * The types still come from the entry point, on purpose: `import type` is erased at compile time,
	 * so the barrel is the right place to take a type from. This is what distinguishes a cut made by
	 * moving value imports from one made by deleting things.
	 */
	it("still takes its types from the entry point, which is free", () => {
		const source = fs.readFileSync(path.join(SRC, "core", "local-llm.ts"), "utf-8");

		// Both halves. The scan this replaced was `toContain('from "@veyyon/ai"')`, which a RUNTIME
		// import satisfies just as well, so it could not tell "free" from the thing it forbids.
		expect(typeOnlyModuleSpecifiersIn(source)).toContain("@veyyon/ai");
		expect(moduleSpecifiersIn(source)).not.toContain("@veyyon/ai");
	});

	/**
	 * No module on the beam graph imports the `@veyyon/utils` barrel. Every util comes
	 * from its owning subpath, so the barrel edge cannot be pulled back onto the reach.
	 */
	it("no module on the beam graph imports the utils barrel", () => {
		const reached = moduleReach(path.join(SRC, "core/beam/index.ts"), RESOLUTION, CACHE);
		const barrelImporters: string[] = [];

		for (const file of reached) {
			if (!file.endsWith(".ts") && !file.endsWith(".js")) continue;
			const source = fs.readFileSync(file, "utf-8");
			if (moduleSpecifiersIn(source).includes("@veyyon/utils")) {
				barrelImporters.push(path.relative(REPO_ROOT, file));
			}
		}

		expect(barrelImporters).toEqual([]);
	});
});
