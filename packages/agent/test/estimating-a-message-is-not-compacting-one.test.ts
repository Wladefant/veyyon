/**
 * Contract: asking what a message costs does not load the machinery that compacts one.
 *
 * WHAT WAS WRONG. `estimateTokens` lived in `compaction/compaction.ts`, which is the compaction ENGINE: the
 * summarizer, the cut-point search and the provider round trip. It reaches 302 modules to do that job, and it
 * should. Estimating a message needs a tokenizer and nothing else.
 *
 * Three modules in the same directory wanted only the estimate, and the marginal cost of that one import was
 * the largest edge any of them had:
 *
 *   - `shake.ts` reached 398 modules, of which 312 were this edge.
 *   - `pruning.ts` reached 398, of which 197 were this edge.
 *   - `branch-summarization.ts` took the same edge, though it needs the rest of that graph anyway.
 *
 * The estimator is defined in `compaction/token-estimate.ts`, whose whole graph is the tokenizer, and
 * `@veyyon/agent-core/compaction` exports it from there.
 *
 * WHY A RATCHET AND NOT A BEHAVIOUR TEST. Nothing fails when this is undone. Every function keeps working,
 * every test keeps passing, and one import restores the mesh. What degrades is the cold start of everything
 * downstream and the honesty of the graph, so the number is what moves and the number is what is pinned,
 * together with the edges by name so a failure says what to undo instead of printing a count.
 *
 * WHY IT MATTERS BEYOND THE NUMBER. The estimate is not a display value: it decides when compaction triggers,
 * how pruning spends its budget and what the operator's context meter reads. Keeping it in a module anyone can
 * import cheaply is what lets those three callers agree on one implementation instead of growing their own.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { packageModuleReach } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dir, "..", "src");
const REPO_ROOT = path.join(SRC, "..", "..", "..");

const { reach, reachedNames, runtimeImportsOf } = packageModuleReach(REPO_ROOT, SRC);

/**
 * RE-MEASURED 2026-08-26 at 10, down from 92. `tokenizer.ts` took `estimateTokensFromText` from the
 * `@veyyon/utils` barrel, which put all 85 of that barrel's modules behind an estimate; it names
 * `@veyyon/utils/tokens` now. What remains is the native tokenizer binding, `@veyyon/utils/json` for
 * `stringifyJson`, and the archive module, which imports nothing at all — the test below pins that, so the
 * constant's home cannot grow a graph behind this ceiling.
 */
const TOKEN_ESTIMATE_CEILING = 12;

/** RE-MEASURED 2026-08-26 at 13, down from 88. Its own graph is the estimator plus a handful of local modules. */
const SHAKE_CEILING = 16;

/**
 * RE-MEASURED 2026-08-26 at 187, down from 204. It does not reach the ceiling above because it genuinely uses
 * more of the directory: the entry helpers, the message shapes and the read-selector split. 187 is that work,
 * not a leftover edge into the engine, which is why this ceiling is not "the same as shake".
 *
 * RE-MEASURED 2026-10-06 at 196. The one new module is `ai/dialect/json-tool-call-scanner.ts`, the
 * `<tool_call>` JSON scanner the `hermes` and `qwen3` dialects share; both dialects were already on this
 * closure. It imports only `./coercion` and `./wire-tags`, both already here, so the growth is that one
 * file and no subtree.
 *
 * RE-MEASURED 2026-10-06 again at 197. The one new module is `ai/dialect/bracket-walk.ts`, the bracket
 * walk that splits call arguments, which `gemini.ts` and `gemma.ts` each spelled inline before. It
 * imports nothing, so the growth is that one file and no subtree.
 */
const PRUNING_CEILING = 197;

/**
 * The engine and the remote summarizer both took `ProviderHttpError` from the `@veyyon/ai/error` barrel,
 * which is 21 modules for one class. They name `@veyyon/ai/error/classes` now.
 *
 * RE-MEASURED 2026-08-26: engine 302, down from 316; remote summarizer 209, down from 223. These are not
 * leaf ceilings — the engine's graph is the job it does — but a ceiling here is what stops a barrel edge
 * from coming back, which is how those 14 got there.
 *
 * RE-MEASURED 2026-09-04: engine 311, remote summarizer 218. The five new modules on both closures are
 * the leaves of `contracts/model/src/` -- `effort.ts`, `model.ts`, `message.ts`, `service-tier.ts`,
 * `stream-block.ts` -- carved out of `catalog/types.ts`, `catalog/effort.ts`, `ai/types.ts` and
 * `ai/utils/block-symbols.ts`, which were already here and now re-export them. A contract imports nothing
 * in this repository, so the growth is file count and no subtree; the barrel edge is still asserted by
 * specifier below.
 *
 * RE-MEASURED 2026-09-11: engine 317, remote summarizer 220. The three new modules on the engine's closure
 * are `compaction/staged-summary.ts` and the two prompt bodies it imports as text,
 * `prompts/compaction/compaction-staged-segment.md` and `prompts/compaction/compaction-staged-merge.md` --
 * the staged summarization the engine falls back to when one request times out or cannot fit. The stager
 * imports only what the engine already reached, so the growth is those three files and no subtree.
 *
 * RE-MEASURED 2026-09-15: engine 318, remote summarizer 220. The one new module is
 * `catalog/provider-models/command-code.ts`, holding Command Code's prices, effort ladders and
 * output ceilings, split out of `provider-models/openai-compat.ts`, which this closure already
 * reached through the model metadata compaction budgets are computed from. It imports only what
 * was already here, so the growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-09-29: engine 319, remote summarizer 221. The one new module is
 * `@veyyon/utils/log-file`, the rotating profile log that replaced `winston` and
 * `winston-daily-rotate-file`. `@veyyon/utils/logger`, already on both reaches, writes through it, and
 * its imports (`node:` built-ins, `./app-identity`, `./fs-error`) were already here, so the growth is
 * that one file and no subtree.
 *
 * RE-MEASURED 2026-09-29 again: engine 320, remote summarizer 222. The one new module is
 * `catalog/compat/share.ts`, the zero-import leaf holding `shareCompat`. `catalog/build.ts`, already on
 * both reaches, returns each model's resolved compat record through it, so the growth is that one file
 * and no subtree.
 *
 * RE-MEASURED 2026-09-30: engine 322, remote summarizer 224. The two new modules are
 * `utils/prompt-precompiled.ts` and `utils/prompt-handlebars.ts`. `utils/prompt.ts`, already on both
 * reaches, reads the binary's build-time precompiled templates from the first and loads the Handlebars
 * compiler through the second only for a template with no precompiled form. The first imports one type
 * from `./prompt-variables` and the second only `handlebars/runtime`, so the growth is those two files
 * and no subtree.
 *
 * RE-MEASURED 2026-10-01: engine 322, remote summarizer 225. The one new module is
 * `catalog/catalog-spans.ts`, the zero-import leaf `catalog/models.ts` indexes each provider's span of
 * `models.json` through. The engine also lost `ai/providers/gitlab-duo-workflow.ts`, which `ai/stream.ts`
 * now registers lazily, so its count is unchanged; the remote summarizer never reached `ai/stream.ts`.
 *
 * RE-MEASURED 2026-10-03: engine 303, remote summarizer 100. The engine read the Codex compaction request
 * context from `ai/providers/openai-codex-responses.ts`, the ChatGPT Codex client; it reads it from
 * `ai/providers/openai-codex/session-state.ts` now, so the client and the 21 modules only it reached left
 * (its response handler and request transformer, `providers/openai-shared.ts` and what only it reaches,
 * `providers/grammar.ts`, the four `ai/cache/` modules, `dialect/demotion.ts`, and `utils/` `sse-debug`,
 * `provider-response`, `provider-fetch`, `first-event-budget` and `empty-completion-retry`). The engine
 * gained the session-state leaf and `providers/openai-stable-ids.ts`, the OpenAI cache-key normalizers it
 * imports. Both reaches gained `ai/providers/azure-deployment-names.ts`, the zero-import leaf holding the
 * Azure deployment map: the remote summarizer took it from `providers/openai-shared.ts`, which put the
 * bundled catalog, the dialect renderers and the schema normalizers (125 modules) behind one parser.
 *
 * RE-MEASURED 2026-10-05: engine 304, remote summarizer 101. Both reach the logger, which reads the local
 * time from `@veyyon/utils/local-time` now instead of building ICU's time zone cache through `Date`. That
 * module imports only `bun:ffi`, so the growth is the one file and no subtree.
 *
 * RE-MEASURED 2026-10-06: engine 305, remote summarizer 101. The one new module is
 * `ai/dialect/json-tool-call-scanner.ts`, the `<tool_call>` JSON scanner the `hermes` and `qwen3` dialects
 * share. It imports only `./coercion` and `./wire-tags`, both already on the engine's reach, so the growth
 * is that one file and no subtree; the remote summarizer reaches no dialect.
 *
 * RE-MEASURED 2026-10-06 again: engine 306, remote summarizer 101. The one new module is
 * `ai/dialect/bracket-walk.ts`, the bracket walk `gemini.ts` and `gemma.ts` split call arguments with.
 * It imports nothing, so the growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-10-13: engine 307. The one new module is
 * `catalog/wire/kimi-code.ts`, the Kimi Code region table the Kimi provider resolves a token's deployment
 * from. It imports only `@veyyon/utils/url`, already on the engine's reach, so the growth is that one file
 * and no subtree.
 *
 * RE-MEASURED 2026-10-15: engine 308. The one new module is `ai/registry/oauth/token-response.ts`, the
 * shared reader that requires a token endpoint's JSON to be an object, which `registry/oauth/nous-research.ts`
 * reads its token responses through. It imports only `@veyyon/utils/type-guards` and `ai/error`, both
 * already on the engine's reach, so the growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-10-18: engine 309. The one new module is `compaction/summary-source.ts`, which sizes
 * and serializes a summary span in time slices. It imports `@veyyon/utils`, `../tokenizer` and `./utils`,
 * all already on the engine's reach, so the growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-10-18 again: engine 310. The one new module is `effort-clamp.ts`, the clamp every
 * compaction request and memory pass sends its fixed effort through, which logs a moved effort once per
 * model. It imports `@veyyon/catalog/model-thinking` and `@veyyon/utils`, both already on the engine's
 * reach, so the growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-10-24: engine 311. The one new module is `catalog/wire/opencode-go.ts`, the OpenCode
 * Go endpoint rules and the envelope a Console login's key is carried in, which
 * `catalog/provider-models/openai-compat.ts` reads to send no Console token to OpenCode Go discovery. It
 * imports only `@veyyon/utils/url`, already on the engine's reach, so the growth is that one file and no
 * subtree.
 *
 * RE-MEASURED 2026-10-25: engine 313. The two new modules are `ai/prompts/tool-choice/any.md` and
 * `ai/prompts/tool-choice/named.md`, the request text that asks for a tool call a wire cannot force,
 * which `ai/prompts/registry.ts`, already on the engine's reach, registers. They import nothing, so the
 * growth is those two files and no subtree.
 *
 * RE-MEASURED 2026-10-28: engine 316, remote summarizer 103. The new modules are `utils/config-root.ts`,
 * `utils/global-config.ts` and `utils/global-config-write.ts`, split out of `utils/dirs.ts` with no code
 * added. The engine reaches all three through the `@veyyon/utils` barrel and the remote summarizer the
 * first two through `@veyyon/utils/dirs`; every module they import was already on both reaches, so the
 * growth is those files and no subtree.
 *
 * RE-MEASURED 2026-10-28: engine 317. The new module is `catalog/provider-models/ollama-native.ts`, the one
 * reader of Ollama's `/api/tags` and `/api/show` answers that the local and cloud catalogs share, which
 * `catalog/provider-models/ollama.ts`, already on the engine's reach, imports. Every module it imports was
 * already reached, so the growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-10-28: engine 318. The new module is `ai/providers/anthropic-tool-choice.ts`, the
 * Anthropic `tool_choice` mapping moved out of `ai/stream.ts`, already on the engine's reach, so the
 * providers that read it stop importing the stream dispatcher. Its only imports are types, so the
 * growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-10-29: engine 319. The new module is `utils/build-store.ts`, the per-build JSON store
 * that `catalog/identity/bundled.ts`, already on the engine's reach, reads each custom model id's bundled
 * reference through. Its imports (`atomic-write.ts`, `logger.ts`, `type-guards.ts`) were already reached,
 * so the growth is that one file and no subtree.
 *
 * RE-MEASURED 2026-10-29 again: engine 315. The Kimi request headers moved out of the Kimi login,
 * `ai/registry/oauth/kimi.ts`, into `ai/utils/kimi-headers.ts`, the one new module, so the chat client and
 * the usage probe that send them no longer load the login. The login left the reach with the four modules
 * only it brought: `ai/registry/oauth/{expiry,success-page,token-response}.ts` and `oauth.html`.
 */
// RE-MEASURED 2026-10-01 after the santhreal sync: +1 for `utils/schema/zod-core.ts` (imported by the `@veyyon/ai` barrel) and `catalog/catalog-spans.ts` (imported by `catalog/models.ts`); each is a leaf, so no subtree arrives.
// RE-MEASURED 2026-10-04 after the upstream port wave (#219): 327 -> 333 and 225 -> 227, provider definitions the `@veyyon/ai` barrel reaches.
const COMPACTION_ENGINE_CEILING = 333;
const REMOTE_SUMMARIZER_CEILING = 227;

describe("the estimator is a leaf", () => {
	it(`token-estimate reaches at most ${TOKEN_ESTIMATE_CEILING} modules`, () => {
		expect(reach("compaction/token-estimate.ts")).toBeLessThanOrEqual(TOKEN_ESTIMATE_CEILING);
	});

	/**
	 * The absences, named rather than counted. Each is a subsystem an estimate has no business loading, and
	 * each is one import away from returning: the summarizer and the remote compaction client are both
	 * reachable from `compaction.ts`, which is exactly where this module used to live.
	 */
	it("reaches neither the compaction engine nor anything it talks to", () => {
		const reached = reachedNames("compaction/token-estimate.ts");

		expect(reached).not.toContain(path.join("packages", "agent", "src", "compaction", "compaction.ts"));
		expect(reached).not.toContain(path.join("packages", "agent", "src", "compaction", "remote-summarizer.ts"));
		expect(reached).not.toContain(path.join("packages", "agent", "src", "telemetry.ts"));
		expect(reached).not.toContain(path.join("packages", "agent", "src", "prompts", "registry.ts"));
	});

	/**
	 * NON-VACUITY for the absences above: the walk really resolved this module, so "reaches none of those" is
	 * an answer about the graph and not what an empty set gives for free. The edges are named rather than
	 * counted, because a magnitude proxy stops meaning anything the moment the graph legitimately shrinks.
	 */
	it("still reaches the tokenizer, which is what an estimate is made of", () => {
		const reached = reachedNames("compaction/token-estimate.ts");

		expect(reached).toContain(path.join("packages", "agent", "src", "tokenizer.ts"));
		expect(reached).toContain(path.join("packages", "utils", "src", "tokens.ts"));
		expect(reached).toContain(path.join("natives", "bridge", "bindings", "native", "index.js"));
	});

	/**
	 * The one non-tokenizer sibling the estimator reaches is a constant with no graph of its own: its reach is
	 * itself. That is what keeps this ceiling a statement about the tokenizer, and an import added to the
	 * archive module fails here rather than spending the estimator's budget unnoticed.
	 */
	it("takes the legacy frame constant from a module that imports nothing", () => {
		expect(reachedNames("compaction/legacy-snapcompact-archive.ts")).toEqual([
			path.join("packages", "agent", "src", "compaction", "legacy-snapcompact-archive.ts"),
		]);
		expect(runtimeImportsOf("compaction/legacy-snapcompact-archive.ts")).toEqual([]);
	});

	/**
	 * It takes `stringifyJson` from the OWNER subpath, not the `@veyyon/utils` barrel.
	 *
	 * Asserted as the specifier because the two spellings compile identically and differ by 72 modules, which
	 * is most of this module's budget. A drive-by edit that reached for the barrel would cost more than the
	 * extraction saved and no other assertion here would move enough to notice.
	 */
	it("names the json owner rather than the utils barrel", () => {
		const imports = runtimeImportsOf("compaction/token-estimate.ts");

		expect(imports).toContain("@veyyon/utils/json");
		expect(imports).not.toContain("@veyyon/utils");
	});
});

describe("the three callers take the estimate from the leaf", () => {
	it(`shake reaches at most ${SHAKE_CEILING} modules`, () => {
		expect(reach("compaction/shake.ts")).toBeLessThanOrEqual(SHAKE_CEILING);
	});

	it(`pruning reaches at most ${PRUNING_CEILING} modules`, () => {
		expect(reach("compaction/pruning.ts")).toBeLessThanOrEqual(PRUNING_CEILING);
	});

	/**
	 * The edge itself, by specifier, for all three.
	 *
	 * This is the assertion that fails if someone puts the import back, and it is the useful one: the two
	 * spellings compile identically, behave identically, and differ by 312 modules for `shake.ts` alone.
	 * `branch-summarization.ts` is included even though its own ceiling would not move, because leaving one
	 * caller pointed at the engine is how the other two find their way back.
	 */
	it.each(["compaction/shake.ts", "compaction/pruning.ts", "compaction/branch-summarization.ts"])(
		"%s imports the estimate from ./token-estimate",
		relative => {
			const imports = runtimeImportsOf(relative);

			expect(imports).toContain("./token-estimate");
			expect(imports).not.toContain("./compaction");
		},
	);

	/** And neither of the two cut modules reaches the engine any more, which is the point of the ceilings. */
	it.each(["compaction/shake.ts", "compaction/pruning.ts"])("%s does not reach the compaction engine", relative => {
		expect(reachedNames(relative)).not.toContain(
			path.join("packages", "agent", "src", "compaction", "compaction.ts"),
		);
	});
});

describe("one error class does not cost an error barrel", () => {
	it(`the compaction engine reaches at most ${COMPACTION_ENGINE_CEILING} modules`, () => {
		expect(reach("compaction/compaction.ts")).toBeLessThanOrEqual(COMPACTION_ENGINE_CEILING);
	});

	it(`the remote summarizer reaches at most ${REMOTE_SUMMARIZER_CEILING} modules`, () => {
		expect(reach("compaction/remote-summarizer.ts")).toBeLessThanOrEqual(REMOTE_SUMMARIZER_CEILING);
	});

	/**
	 * Asserted as the specifier as well as the count, because the two spellings compile identically. The
	 * ceilings above are wide enough that one barrel edge returning would not necessarily break them, and
	 * this is the edge that put 14 modules behind a single `instanceof`.
	 */
	it.each(["compaction/compaction.ts", "compaction/remote-summarizer.ts"])(
		"%s names the error-class owner rather than the error barrel",
		relative => {
			const imports = runtimeImportsOf(relative);

			expect(imports).toContain("@veyyon/ai/error/classes");
			expect(imports).not.toContain("@veyyon/ai/error");
		},
	);
});

describe("the compaction entry point exports the leaf's estimator", () => {
	/**
	 * `estimateTokens` is public through `@veyyon/agent-core/compaction`, and its one definition is in
	 * `token-estimate.ts`.
	 *
	 * Asserted as function identity. A barrel that reached a second implementation would give two callers
	 * different numbers for the same message, which is the failure the extraction exists to prevent.
	 */
	it("the entry point and the leaf export the same function", async () => {
		const [fromEntryPoint, fromLeaf] = await Promise.all([
			import("../src/compaction"),
			import("../src/compaction/token-estimate"),
		]);

		expect(fromEntryPoint.estimateTokens).toBe(fromLeaf.estimateTokens);
	});
});
