/**
 * WHY THIS EXISTS. Prompt assembly refused an unknown `VEYYON_EVAL_PROMPTS` id by reading
 * `prompts/all-registries.ts`, the aggregate of every prompt registry in four packages,
 * whose own graph is 250 modules. `system-prompt.ts` is on the launch path, so every
 * session constructed all four registries and 197 prompt rows to validate an environment
 * variable almost no session sets: the assembler reached 718 modules with that edge and
 * 528 without it, and `main.ts` 1605 against 1576, on a bundled binary that spends about
 * 290ms initializing modules before it draws anything.
 *
 * The refusal now reads `prompts/ids.generated.ts` — the id space and no prompt text.
 *
 * THE CLASS THIS CLOSES. Not "one import was removed" but "the launch path reaches an
 * aggregate it needs at most one field of". The reach numbers below are measured on the
 * real graph, so any new edge from a launch module into the registries, the prompt-listing
 * CLI or a sibling aggregate turns this red, whoever adds it and wherever it sits.
 *
 * WHAT IT DOES NOT CATCH. A launch module that imports one directory's rows module
 * directly is invisible here and is meant to be: a module that sends a prompt has to carry
 * that prompt's text, which is most of why removing this edge cost the launch 29 modules
 * and the assembler 190. This gate is about the whole-registry aggregate, and about the
 * two totals, which is why the ceilings are here as well as the named file.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	createModuleReachCache,
	type ModuleReachResolution,
	moduleReach,
	moduleReachCount,
} from "@veyyon/utils/module-reach";
import { workspaceModuleReachResolution } from "@veyyon/utils/module-reach-workspace";

const SRC = path.join(import.meta.dirname, "..", "..", "..", "src");
const REPO_ROOT = path.resolve(SRC, "..", "..", "..");
const RESOLUTION: ModuleReachResolution = workspaceModuleReachResolution(REPO_ROOT);
const CACHE = createModuleReachCache();

/** The CLI entry a launch runs, and the assembler that used to hold the edge. */
const LAUNCH = path.join(SRC, "main.ts");
const ASSEMBLER = path.join(SRC, "system-prompt.ts");
const AGGREGATE = path.join(SRC, "prompts", "all-registries.ts");

/**
 * Measured at 1624 against the merge base's 1581. Two of the extra modules are the
 * catalog OpenCode discovery header leaf this branch absorbed with origin/main;
 * six are `contracts/model`, whose leaves (`effort`, `instrumentation`,
 * `message`, `model`, `service-tier`, `stream-block`) sit on the graph beside the
 * `ai` and `catalog` modules that re-export them; two are the shell domain's
 * message kinds, which ride on its manifest so a transcript with a `!` command
 * converts wherever the tool table loads: `tools/shell/execution-messages` and the
 * kernel's `session/message-kinds` table. One is `export/html/tool-views.generated.js`,
 * the gitignored bundle the HTML export imports as text: the walker counts a file
 * that exists and skips one that does not, so a tree where the bundle has been built
 * measures one higher than a fresh checkout. One is the kernel's settings registry,
 * `kernel/settings/schema`, which the product composer `config/settings-schema`
 * registers its domain tables into: the queries moved out of the composer into the
 * registry, so the same code is two modules where it was one. Two more are the kernel's
 * settings store, `kernel/settings/store`, and the setting signal, `kernel/settings/signal`,
 * which the product store `config/settings` subclasses and re-exports: the layered file
 * store moved out of the product module, so again the same code is two modules where it
 * was one. `contracts/host`, `contracts/session` and `contracts/tool` are reached by type
 * only and do not count. The number is modules, so a split raises it while the code the
 * launch runs is the same, and re-pinning here is the decision that growth is supposed to
 * force.
 *
 * RE-MEASURED 2026-09-11 at 1637, up from 1624: 93 modules arrived and 79 left. What left is
 * the eval kernels and their bridges (`eval/*`, 41 modules, no longer on the launch path), the
 * `@veyyon/ai` barrel and the twelve provider and auth modules only it reached, the vibe tool and
 * its runtime, `catalog/registry-snapshot`, `kernel/session/auth-storage` and `utils/html-markdown`.
 * What arrived, by group: every tool card as a view the host draws (`tools/<domain>/<tool>-view.ts`,
 * `tools/view-registry.ts`, `presentation/{read-group,tool-call-preview,tool-execution,web-tool-display}.ts`,
 * `edit/edit-view.ts`, `goals/goal-view.ts`, `task/task-view.ts`, `tools/core/{json-tree-render,list-limit}.ts`,
 * `tools/search/search-card-limits.ts`, `tools/web/read-url-target.ts`), each a sibling of a tool module
 * that was already reached; the subagent surfaces renamed to agent (`prompts/agent/*`,
 * `settings-domains/agents.ts`, the two agent tool-policy statements) plus the task modules split out
 * beside them (`task/{agent-settings,agent-stats,model-selector,outcome,repair-args,task-id}.ts`);
 * six engine leaves (`components/form.ts`, `utils/{border,hover-controller,scroll-layout,search-filter,text-layout}.ts`)
 * and three `contracts/wire` leaves (`collab-link`, `presentation/theme`, `task-result`); the hashline
 * operations table and the edit modules that read it (`plugins/hashline/src/operations.ts`,
 * `edit/hashline/{block-resolver,diff}.ts`, `edit/streaming.ts`); the product's own tool-event input
 * (`extensibility/tool-event-input.ts`, replacing the kernel's); the utils leaves the launch now reads
 * (`cli-usage-error`, `fs-tool-args`, `github-check-run`, `json-snapshot`, `tab-width`, `terminal-emulator`);
 * and the staged compaction absorbed from origin/main (`agent/compaction/staged-summary.ts` and its two
 * prompt bodies) with `ai/providers/initial-message.ts` and `catalog/discovery/failure.ts`. The rest are
 * one-file terminal and session helpers (`config/settings-signals`, `debug/session-snapshot`,
 * `internal-urls/resolve-sync`, `modes/terminal/{launch-formatting,draw/utils,utils/async-tool-state}`,
 * `components/{dialogs/plan-toc,selectors/select-list-mouse-routing,status-line/location-context}`,
 * `session/account-format`, `slash-commands/helpers/mcp-args`, `subprocess/worker-request-client`,
 * `thinking/constants`).
 *
 * RE-MEASURED 2026-09-11 at 1639, up from 1637: `@veyyon/view` grew its first value export,
 * `UNICODE_SYMBOLS`, the glyph table the terminal, the GUI host and the HTML export draw from,
 * so the walker now counts `contracts/view/src/index.ts` and `contracts/view/src/symbols.ts`,
 * which it skipped while the package was reached by type only.
 *
 * RE-MEASURED 2026-09-14 at 1642, up from 1639: three modules arrived and none left.
 * `kernel/session/session-list-index.ts` is the only one that is new code — the size-and-mtime
 * reuse index that took `listAllSessions` from 6,796ms to 89ms over 4,825 real sessions, and it
 * is on the launch graph because the session manager is. The other two are splits of bytes the
 * launch already carried, so they raise the count without adding anything for the launch to run:
 * `config/settings-migrations.ts` left `config/settings.ts` (1253 lines to 743), and
 * `session/agent-session-model-targets.ts` left `session/agent-session.ts` (18604 to 18446). That
 * is the case the paragraph above describes — the number is modules, so a split raises it while
 * the code the launch runs is the same.
 *
 * 1642 to 1545: the two hot callers of the builtin slash commands stopped importing the registry.
 * `main.ts` and the TUI input controller reach them through `slash-commands/dispatch.ts`, which
 * answers "does this name a builtin" from the declarations and loads the handlers only once a name
 * has matched. Most input that reaches that check is not a builtin, so the handlers, and the
 * application behind them, are no longer on the path that decides. The input controller is not on
 * this graph and moved 1296 to 1059 on the same edge.
 *
 * 1545 to 1546: `catalog/provider-models/command-code.ts`, the one module holding Command Code's
 * prices, effort ladders and output ceilings, split out of `provider-models/openai-compat.ts`,
 * which this graph already reaches. It is a leaf over modules already here, so the launch runs no
 * new code — the same split-raises-the-count case as the line above.
 *
 * 1546 to 1548: `ai/usage/anthropic-reset.ts`, the Anthropic usage-limit reset client, and
 * `ai/usage/claude-oauth-endpoint.ts`, the OAuth base URL and headers it shares with the Claude
 * usage report. `AuthStorage` lists and redeems resets for every provider that has them and reaches
 * the Codex reset client the same way. Both are leaves over modules already here; the usage report,
 * `ai/usage/claude.ts`, stays off this graph.
 *
 * 1548 to 1549: `session/agent-session-provider-request.ts`, the provider request shaping
 * (secret redaction, Anthropic metadata, the tool-order check) split out of
 * `session/agent-session.ts` to hold that file under its line ceiling. A leaf over modules already
 * here, so the launch runs no new code — the same split-raises-the-count case as above.
 *
 * 1549 to 1550: `goals/goal-record.ts`, which writes a goal's counters as a `goal_progress` entry
 * between the `mode_change` records that hold the whole goal, and reads the two back together. It is
 * new code on this graph because `session/agent-session.ts` records a goal after each tool call that
 * spends tokens on one; it imports only type-level kernel modules and `utils/type-guards`, both
 * already here.
 *
 * 1550 to 1552: `kernel/session/tool-result-codecs.ts`, the table of result codecs the session
 * spine applies to each line it writes and each entry it loads, and `tools/fs/read-display.ts`, the
 * read codec the filesystem manifest contributes to it. A resumed session restores its read cards as
 * it loads, before any read runs, so the codec cannot wait for the read tool; both import only
 * type-level modules and `utils/type-guards`, already here.
 *
 * 1552 to 1554: `edit/result-codec.ts`, the edit codec `tools/index.ts` registers beside the
 * domains' codecs, which rebuilds an edit's post-edit text from its pre-edit text and diff as a
 * resumed session loads, and `edit/numbered-diff-row.ts`, the numbered diff row format split out of
 * `edit/diff.ts` so the diff writer and that rebuild read one definition. The codec imports only
 * type-level modules, `utils/type-guards` and the row module, which imports nothing.
 *
 * 1554 to 1557: `tools/search/search-result-codec.ts`, `tools/shell/eval-result-codec.ts` and
 * `tools/shell/job-result-codec.ts`, the search, eval and job codecs their domain manifests
 * register, which rebuild a result's dropped display copies from its text as a resumed session
 * loads. They import `node:util`, type-level modules, `utils/type-guards`, `tools/core/output-notice`
 * and, for search, `hashline/format` and `tools/core/render-utils`, all already here.
 *
 * 1557 to 1558: `session/session-spend.ts`, the spend ledger `session/agent-session.ts` reads for
 * session stats and goal accounting, which tallies the messages a compaction summarized once per
 * boundary instead of on every read. It imports type-level modules and `tools/core/builtin-names`,
 * already here.
 *
 * 1558 to 1561: `session/runtime/advisor-roster.ts`, `session/advisor-context.ts` and
 * `session/advisor-stats.ts`, the advisor lifecycle and delivery routing, the advisor's overflow
 * compaction, and its spend and status figures, split out of `session/agent-session.ts` (18412
 * lines to 17399). Leaves over modules already here, so the launch runs no new code — the same
 * split-raises-the-count case as above.
 *
 * 1561 to 1562: `session/runtime/streaming-edit-guard.ts`, the check that stops a turn while an
 * `edit` call streams toward an auto-generated file or a patch that cannot apply, split out of
 * `session/agent-session.ts` (17399 lines to 17089). It imports the owning edit, path and
 * local-protocol modules the runtime already reached, so the launch runs no new code.
 *
 * 1562 to 1566: `session/runtime/tool-discovery.ts`, `session/runtime/checkpoint-runtime.ts`,
 * `session/runtime/user-executions.ts` and `session/runtime/post-prompt-tasks.ts`, the discovery
 * selections and search index, the checkpoint and rewind state, the user shell and eval runs, and
 * the work a turn schedules after `prompt()` returns, split out of `session/agent-session.ts` (17089
 * lines to 16629). They import `node:path`, `node:timers/promises` and modules the runtime already
 * reached, so the launch runs no new code.
 *
 * 1566 to 1567: `session/runtime/irc-inbox.ts`, the IRC records a streaming turn has not yet taken,
 * split out of `session/agent-session.ts` (16629 lines to 16575). It imports only type-level
 * modules, so the launch runs no new code.
 *
 * 1567 to 1568: `task/run-monitor.ts`, the progress, abort, soft-budget and output capture for one
 * agent run, split out of `task/executor.ts` (3497 lines to 2450). It imports modules the executor
 * already reached, so the launch runs no new code.
 *
 * 1568 to 1569: `secrets/session-runtime.ts`, the secret loader, expansion lease, reload queue and
 * tool-argument expansion a session runs, split out of `sdk.ts` (3899 lines to 3322). It imports
 * modules `sdk.ts` already reached, so the launch runs no new code.
 *
 * 1569 to 1570: `session/startup-model.ts`, the two-pass model and thinking-level selection a
 * session starts on, split out of `sdk.ts` (3322 lines to 2879). It imports modules `sdk.ts`
 * already reached, so the launch runs no new code.
 *
 * 1570 to 1571: `session/tool-session.ts`, the tool session a session's tools run against and the
 * advisor's derived view of it, split out of `sdk.ts` (2705 lines to 2524). It imports modules
 * `sdk.ts` already reached, so the launch runs no new code.
 *
 * 1571 to 1572: `session/prompt-inputs.ts`, the project inputs a session's system prompt renders
 * and their re-discovery after a working-directory change, split out of `sdk.ts` (2524 lines to
 * 2281) with the MCP startup that moved into `session/factory-mcp.ts`. It imports modules
 * `sdk.ts` already reached, so the launch runs no new code.
 *
 * 1572 to 1577: `session/startup-extensions.ts`, `session/startup-background.ts`,
 * `session/startup-records.ts`, `session/async-jobs.ts` and `secrets/request-leases.ts`, the
 * extension and custom-command load, the Codex prewarm and language-server warmup, the argot arm
 * and start records, the owned background-job manager and the secret lease each request in flight
 * was admitted under, split out of `sdk.ts` (2269 lines to 1768) with the custom tools and the
 * tool registry that moved into `session/factory-tools.ts`. They import modules `sdk.ts` already
 * reached, so the launch runs no new code.
 *
 * 1577 to 1578: `hosts/terminal/engine/src/core/paint-sequences.ts`, the escape sequence each
 * paint shape writes, split out of `core/tui.ts`. It imports `@veyyon/utils/deccara`,
 * `@veyyon/utils/math` and engine modules the root already reached, so the launch runs no new
 * code. `core/frame-plan.ts`, split out with it, is imported by type only and is not on the graph.
 *
 * 1578 to 1579: `hosts/terminal/engine/src/components/markdown-tokenizer.ts`, the block
 * tokenizer with the setext underline precheck, split out of `components/markdown.ts`. It imports
 * `marked`, which `markdown.ts` already reached, so the launch runs no new code.
 *
 * 1579 to 1620, forty-one modules, every one a file added to the tree; no module that existed at
 * 1579 joined the graph:
 *
 * - Nineteen `session/runtime/*.ts` collaborators and `session/failed-turn.ts`, split out of
 *   `session/agent-session.ts` (16447 lines to 10173): compaction runtime, summarizer and recovery,
 *   context accounting, finalize reminders, history rewrites, loop guards, memory context, message
 *   persistence, model handoff, plan mode, provider sessions, provider usage, retry fallback, retry
 *   runtime, session approvals, session secrets, stop retries and yield tracking. Each imports
 *   modules the class already reached.
 * - Thirteen `packages/ai/src/auth-storage/*.ts` modules split out of `auth-storage.ts` (7449 lines
 *   to 4794). Each imports modules `auth-storage.ts` already reached.
 * - `session/provider-replay-projection.ts`, the replayed-field comparison a same-file reload runs,
 *   split out of `session/agent-session.ts`.
 * - `kernel/src/session/session-entry-index.ts` and `kernel/src/session/session-cold-payloads.ts`,
 *   the loader's entry index and the compacted payloads a session file keeps until read. They
 *   import kernel session modules and `@veyyon/utils/type-guards`, already here.
 * - `session/top-level-sessions.ts` and `mcp/manager-lease.ts`, the disposal order of the sessions
 *   a daemon keeps and the lease a session holds on the shared MCP manager. They import modules the
 *   session factory already reached.
 * - `@veyyon/utils` `log-file.ts`, `idle-trim.ts` and `stall-sampler.ts`: the rotating profile log
 *   that replaced `winston` and `winston-daily-rotate-file` (29 npm packages off the launch), the
 *   idle code discard, and the event-loop stall profile. They import `node:` built-ins,
 *   `./app-identity`, `./fs-error`, `./logger` and `./type-guards`, all already here.
 *
 * 1620 to 1621: `catalog/compat/share.ts`, the zero-import leaf holding `shareCompat`.
 * `catalog/build.ts` and `config/model-registry.ts`, already here, return each model's resolved
 * compat record through it so equal records are held once.
 *
 * 1621 to 1623: `@veyyon/utils` `prompt-precompiled.ts`, the registry of templates the binary build
 * compiled, and `prompt-handlebars.ts`, which loads the Handlebars compiler for the first template no
 * build compiled. `prompt.ts`, already here, imports both. The first imports nothing that runs and the
 * second only the `handlebars/runtime` package entry, so a binary launch evaluates no Handlebars
 * compiler module.
 *
 * 1623 to 1624: `catalog/catalog-spans.ts`, the zero-import leaf `catalog/models.ts` reads one
 * provider's span of `models.json` through. Nine modules arrived after it and nine left, so the count
 * held. Arrived: `config/launch-facts.ts` (moved from `modes/`), `secrets/expiry.ts`, the four
 * `session/runtime/` collaborators split out of `agent-session.ts`, `kernel/src/session/session-load-cooling.ts`,
 * and `@veyyon/utils` `activity-signal.ts` and `rearming-timeout.ts`. Left: `modes/launch-facts.ts`,
 * `secrets/secret-command.ts` and `secrets/scope-move.ts` (now behind the `/secret` handler),
 * `tools/core/tool-result.ts`, `tools/core/aborted-partway.ts`, `tools/web/gh.ts`, and the
 * `@veyyon/ai` `providers/gitlab-duo-workflow.ts`, `providers/google-gemini-cli.ts` and
 * `utils/google-validation.ts` provider modules, now registered lazily.
 *
 * 1624 to 1603: the edit tool's write path, `executePatchSingle` and `LspFileSystem`, moved out of
 * `edit/modes/patch.ts` into `edit/modes/patch-execute.ts`. The streaming edit guard imports `patch.ts`
 * on every launch to preview a patch, and the write path imported the LSP writethrough, so 21 modules
 * left: fourteen under `lsp/` (the client, its server table and config, the linter clients, the edit
 * applier, the multiplexer and the view), `utils/jsonrpc-framing.ts`, `edit/snapshot-details.ts`, and
 * `tools/core/` `acp-bridge.ts`, `diagnostics.ts`, `fs-cache-invalidation.ts`, `plan-mode-guard.ts` and
 * `result-notice.ts`. `test/architecture/a-launch-loads-no-language-server-client.test.ts` pins the cut.
 *
 * 1603 to 1582: the session, its provider wire, compaction and the remote summarizer each took a constant
 * or a function from a provider client, which put the client and its subtree on the launch graph. They
 * take them from leaves split out of the clients: `providers/anthropic-session-state.ts` and
 * `providers/claude-device-id.ts` (from `anthropic.ts`), `providers/openai-codex/session-state.ts` and
 * `providers/openai-stable-ids.ts` (from `openai-codex-responses.ts` and `openai-shared.ts`),
 * `providers/google-thought-signatures.ts` (from `google-shared.ts`) and
 * `providers/azure-deployment-names.ts` (from `openai-shared.ts`). `openai-compaction.ts` loads its
 * request half on the first server-side compaction. 27 modules (691 KiB) left: the Anthropic and Codex
 * clients, `google-shared.ts`, `openai-shared.ts`, the Codex compaction window, the four `ai/cache/`
 * modules, and the stream utilities only they import; the six leaves arrived.
 * `test/architecture/a-launch-loads-no-provider-client.test.ts` pins the provider modules a launch reaches.
 *
 * 1582 to 1467: `main.ts` loads `cli/session-picker.ts` when `--resume` opens the picker instead of at
 * the top of the file. The picker imported the terminal engine root and the session selector, so every
 * launch evaluated the renderer, the editor, the markdown, mermaid and LaTeX renderers, the status line
 * and the loop watchdog: 115 modules (1695 KiB), none of which a print, RPC or ACP launch draws with. The
 * interactive mode imports the same stack behind its own `await import`.
 * `test/architecture/a-launch-outside-the-terminal-loads-no-terminal-engine.test.ts` pins the cut.
 *
 * 1467 to 1468: `ai/src/utils/schema/arktype.ts`, the module shipped source imports arktype's `type`,
 * `scope` and `Type` from. It imports `arktype` through `require` on the first schema built, so the
 * count sees one workspace module more while a launch evaluates the 115 modules of `arktype` fewer,
 * which this walk never counted. Its only static imports are type-only.
 * `test/architecture/a-launch-evaluates-arktype-only-when-a-schema-is-built.test.ts` pins the cut.
 *
 * 1468 to 1474: six modules split out of modules already here, each importing only what its source
 * did. `ai/src/dialect/json-tool-call-scanner.ts` is the `<tool_call>` JSON scanner `hermes.ts` and
 * `qwen3.ts` shared by copy. `session/startup-credential-relay.ts`, `session/startup-identity.ts`,
 * `session/startup-request-hooks.ts` and `config/openai-websockets-mode.ts` are session startup steps
 * that left `sdk.ts`, and `session/tool-discovery.ts` left `session/factory-tools.ts`. No module left
 * and none arrived through a new import.
 *
 * 1474 to 1475: `ai/src/dialect/bracket-walk.ts`, the zero-import bracket walk `gemini.ts` and
 * `gemma.ts` split call arguments with instead of each spelling it inline.
 *
 * 1475 to 1476: `catalog/wire/kimi-code.ts`, the Kimi Code region table and the API-key envelope that
 * holds a credential's deployment. `ai/src/registry/oauth/index.ts`, already here, builds a Kimi login's
 * API key through it, and its one import, `utils/src/url.ts`, was already here.
 *
 * 1476 to 1477: `prompts/side-channel/composer-prediction.md`, the prompt the composer's next-message
 * prediction sends. `prompts/side-channel/rows.ts`, already here through `session/agent-session.ts`,
 * imports every prompt in its directory as text.
 *
 * 1477 to 1478: `session/runtime/turn-context-check.ts`, the end-of-turn context check that left
 * `session/agent-session.ts`. It imports only what that code imported there, so no other module arrived.
 *
 * 1478 to 1479: `ai/src/registry/oauth/token-response.ts`, the one reader that requires a token
 * endpoint's JSON to be an object. `ai/src/registry/oauth/nous-research.ts`, already here, reads its
 * token responses through it; its imports, `utils/src/type-guards.ts` and `ai/src/error`, were
 * already here.
 *
 * 1479 to 1480: `session/runtime/session-switch.ts`, session switching and its rollback, which left
 * `session/agent-session.ts`. It imports only what that code imported there, so no other module arrived.
 *
 * 1480 to 1481: `ai/src/auth-storage/usage-reporting.ts`, the usage-report fetch, cache and header
 * ingest, which left `ai/src/auth-storage.ts`. Its imports were already here through that file.
 * Measured 2026-10-16 at 1481.
 *
 * 1481 to 1482: `session/runtime/session-branch.ts`, branching and tree navigation, which left
 * `session/agent-session.ts`. It imports only what that code imported there, so no other module
 * arrived. Measured 2026-10-16 at 1482.
 *
 * 1482 to 1483: `session/runtime/session-handoff.ts`, the handoff document and the new session it
 * seeds, which left `session/agent-session.ts`. It imports only what that code imported there, so
 * no other module arrived. Measured 2026-10-16 at 1483.
 *
 * 1483 to 1484: `session/runtime/tool-activation.ts`, the active tool set and the base system prompt
 * it renders, which left `session/agent-session.ts`. It imports only what that code imported there,
 * so no other module arrived. Measured 2026-10-16 at 1484.
 *
 * 1484 to 1485: `session/agent-session-ephemeral-turn.ts`, the side-channel turn behind `/btw` and
 * `/omfg` with its history snapshot, which left `session/agent-session.ts`. It imports only what that
 * code imported there, so no other module arrived. Measured 2026-10-16 at 1485.
 *
 * 1485 to 1486: `config/resolve-config-value-sync.ts`, the synchronous `!command` and environment
 * resolver the model registry runs for API keys and headers, which left `config/model-registry.ts`.
 * It imports only what that code imported there. Measured 2026-10-16 at 1486.
 *
 * 1486 to 1487: `session/agent-session-turn-notices.ts`, the goal todo context and the magic keyword
 * notices, which left `session/agent-session.ts`. It imports only what that code imported there, so
 * no other module arrived. Measured 2026-10-16 at 1487.
 *
 * 1487 to 1488: `config/resolved-model-stage.ts`, the codec for the registry's persisted
 * `resolved-models.json` stage, which left `config/model-registry.ts`. It imports only what that code
 * imported there. Measured 2026-10-16 at 1488.
 *
 * 1488 to 1489: `config/live-config-headers.ts`, the header object that resolves configured
 * header references on every read, which left `config/model-registry.ts`. It imports only what that
 * code imported there. Measured 2026-10-16 at 1489.
 *
 * 1489 to 1490: `config/model-patch.ts`, which applies model overrides, custom model definitions and
 * provider compat to built models, and which left `config/model-registry.ts`. It imports only what
 * that code imported there. Measured 2026-10-16 at 1490.
 *
 * 1490 to 1491: `goals/state.ts`, the goal types and `GOAL_STATUSES`, whose only import is
 * type-only. `goals/goal-record.ts`, already here, checks a recorded goal's status against that
 * tuple when a session resumes, so a status no build writes restores no goal.
 *
 * 1491 to 1492: `cli/launch-card-eligibility.ts`, the argv-only launch decisions, which `main.ts`
 * imports to tell a bare `--resume` (the session picker, no launch card) from a resume that names its
 * session. Its only import is type-only, and the shipped launch already evaluates it through
 * `commands/launch.ts`. Measured 2026-10-19 at 1492.
 *
 * 1492 to 1493: `agent/src/tool-call-preparation.ts`, which strips the intent field, repairs,
 * validates and transforms a tool call's arguments, and which left `agent/src/agent-loop.ts` so the
 * Cursor exec channel prepares the calls it runs itself exactly as the loop does. It imports only
 * what that code imported there.
 *
 * 1493 to 1494: `utils/src/fs-io.ts`, the reads and writes that open a workspace file through
 * `node:fs` so an open under an NFS lease waits for the lease to break instead of failing with
 * `EAGAIN`. It replaced `Bun.file` and `Bun.write` calls on the launch path, its only imports are
 * `node:fs/promises` and `node:path`, and its callers name it by subpath, so the `@veyyon/utils`
 * barrel does not carry it. Measured 2026-10-20 at 1494.
 *
 * 1494 to 1495: `hashline/src/line-map.ts`, which pairs the unchanged lines of two versions of a
 * file. It left `hashline/src/recovery.ts`, and `hashline/src/patcher.ts`, already here, uses it to
 * keep the lines an edit's text was displayed with under the edited version's tag. Its only runtime
 * import is `@veyyon/utils/abortable`, already here; `diff` stays a lazy `require`. Measured
 * 2026-10-20 at 1495.
 *
 * 1495 to 1496: `ai/src/providers/openai-codex/access-programs.ts`, which selects the Daybreak
 * program a Codex request carries for the account that signs it. `tools/web/image-gen.ts`, already
 * here for the image provider preference, imports it for a Codex image request. Its runtime imports,
 * the Codex discovery reader and the abort and timeout helpers, are already here. Measured
 * 2026-10-21 at 1496.
 *
 * 1496 to 1498: `ai/src/registry/opencode-go-api-key.ts`, the OpenCode Go API-key login, which
 * `ai/src/registry/registry.ts`, already here, lists beside the OpenCode Console login, and
 * `catalog/src/wire/opencode-go.ts`, the OpenCode Go endpoint rules and the envelope a Console login's
 * key is carried in, which `catalog/src/provider-models/openai-compat.ts` and
 * `ai/src/registry/oauth/index.ts`, both already here, read. Their runtime imports, the shared API-key
 * login builder and `@veyyon/utils/url`, are already here. The Console device flow stays behind
 * the registry's lazy `await import`. Measured 2026-10-24 at 1498.
 *
 * 1498 to 1501: `ai/src/prompts/tool-choice/any.md` and `ai/src/prompts/tool-choice/named.md`, the
 * request text that asks for a tool call a wire cannot force, which `ai/src/prompts/registry.ts`,
 * already here, registers, and `ai/src/utils/tool-choice.ts`, which `agent/src/agent-loop.ts`,
 * already here, imports to put that text into an in-band dialect's turn. Its runtime import is the
 * prompt registry, already here. Measured 2026-10-25 at 1501.
 *
 * 1501 to 1502: `coding-agent/src/session/runtime/irc-delivery.ts`, the session collaborator that
 * routes an arriving IRC message and sends the auto-reply. It left `session/agent-session.ts`,
 * already here, and its runtime imports (the IRC bus, the agent registry, the IRC inbox and the
 * side-channel and steering prompt rows) are already here. Measured 2026-10-26 at 1502.
 *
 * 1502 to 1504: `coding-agent/src/session/runtime/session-stop-hook.ts`, the session collaborator
 * that runs the `session_stop` hook pass and queues its continuation, and
 * `coding-agent/src/session/runtime/next-turn-messages.ts`, the collaborator that holds the hidden
 * messages queued for the next turn. Both left `session/agent-session.ts`, already here. The first
 * imports `@veyyon/utils` and `session/nudges.ts`, both already here; the second has only type
 * imports. Measured 2026-10-26 at 1504.
 *
 * 1504 to 1505: `coding-agent/src/session/runtime/model-selection.ts`, the session collaborator
 * that makes the saved switch, the session-only switch and the Ctrl+P cycle. It left
 * `session/agent-session.ts`, already here, and its runtime imports (the model equality check, the
 * agent storage, the session entry roles, the credential message and the model resolver) are
 * already here. Measured 2026-10-26 at 1505.
 *
 * 1505 to 1508: `coding-agent/src/tools/core/repair/tool-repairs.ts`, the tool-specific repairs the
 * cascade in `tools/core/repair/schema-repair.ts`, already here, runs before validation;
 * `coding-agent/src/task/repair-args.ts`, the task prose decoder its `task` entry calls, which only
 * the task tool and its renderer reached before; and `coding-agent/src/tools/core/repair/limits.ts`,
 * the zero-import leaf holding the size bound all three share. The repairs ran inside the `task` and
 * `yield` tools before; they run once on the call now, so approval and the tool receive the same
 * arguments. Their other runtime imports (`@veyyon/utils`, `@veyyon/utils/json-parse` and
 * `tools/core/builtin-names`) are already here. Measured 2026-10-27 at 1508.
 *
 * 1508 to 1509: `coding-agent/src/session/runtime/owned-async-jobs.ts`, the session collaborator
 * that delivers, lists and cancels the background jobs a session owns and holds the wake they keep
 * over a settle. It left `session/agent-session.ts`, already here, and its runtime imports (the
 * agent registry and `session/agent-session-types.ts`) are already here. Measured 2026-10-27 at
 * 1509.
 *
 * 1509 to 1510: `coding-agent/src/session/runtime/conversation-release.ts`, the session
 * collaborator that releases what a conversation ends with on `/new`, `/resume` and a handoff:
 * its spawned agents, registry scope, IRC traffic, standing grants and eval kernels. It left
 * `session/agent-session.ts`, already here, and its runtime imports (the agent lifecycle and
 * registry, the IRC bus, the owned-resource registry and `session/agent-session-types.ts`) are
 * already here. Measured 2026-10-27 at 1510.
 *
 * 1510 to 1511: `coding-agent/src/session/runtime/stop-settlement.ts`, the session collaborator
 * that routes a run that ended before extensions see its `agent_end`: the yield short-circuit,
 * stop recovery, the compaction check, the stop-time continuation passes and the `session_stop`
 * hooks. It left `session/agent-session.ts`, already here, and its runtime imports (the replay
 * policy, the error registry, the settle-continuation rules and `@veyyon/utils`) are already here.
 * Measured 2026-10-27 at 1511.
 *
 * 1511 to 1512: `coding-agent/src/session/runtime/queued-messages.ts`, the session collaborator
 * that queues steers and follow-ups on the agent, drains them into a turn on a resting session,
 * and counts, lists, clears and pops them. It left `session/agent-session.ts`, already here, and
 * its one runtime import (`session/agent-session-queue.ts`) is already here. Measured 2026-10-27
 * at 1512.
 *
 * 1512 to 1513: `coding-agent/src/session/runtime/turn-preludes.ts`, the session collaborator that
 * builds the session-state block and the eager delegate reminders a turn carries ahead of its
 * message. It left `session/agent-session.ts`, already here, and its runtime imports (the session and
 * turn-control prompt rows, `task/agent-settings.ts`, `utils/prompt-path.ts` and `@veyyon/utils`) are
 * already here. Measured 2026-10-27 at 1513.
 *
 * 1513 to 1514: `coding-agent/src/session/runtime/service-tiers.ts`, the session collaborator that
 * holds the per-family service tiers `/fast` and `tier.*` set and resolves the tier each request
 * carries. It left `session/agent-session.ts`, already here, and its runtime imports (the catalog's
 * service-tier and Fireworks model-id modules, the Anthropic session state and `config/service-tier.ts`)
 * are already here. Measured 2026-10-27 at 1514.
 *
 * 1514 to 1515: `coding-agent/src/session/runtime/prompt-commands.ts`, the session collaborator that
 * holds the command registries and resolves a typed prompt through extension, custom and file-based
 * commands and the prompt templates. It left `session/agent-session.ts`, already here, and its
 * runtime imports (`config/prompt-templates.ts`, `extensibility/slash-commands.ts`,
 * `slash-commands/helpers/parse.ts`, `session/agent-session-commands.ts` and `@veyyon/utils`) are
 * already here. Measured 2026-10-27 at 1515.
 *
 * 1515 to 1516: `coding-agent/src/session/runtime/display-copy.ts`, the session collaborator that
 * turns assistant content, tool intents, streamed deltas and rebuilt transcripts into the copy a
 * person sees, and holds the stream decoder a streamed reply runs through. It left
 * `session/agent-session.ts`, already here, and its runtime imports (`argot-wire.ts` and
 * `secrets/obfuscator.ts`) are already here. Measured 2026-10-27 at 1516.
 *
 * 1516 to 1517: `coding-agent/src/session/runtime/image-attachments.ts`, the session collaborator
 * that normalizes a message's images for the active model, has a vision model describe them for a
 * text-only one, and lists the latest images a tool addresses. It left `session/agent-session.ts`,
 * already here, and its runtime imports (`utils/image-loading.ts`, `utils/image-vision-fallback.ts`,
 * `config/model-resolver.ts`, `session/agent-session-queue.ts` and `@veyyon/utils`) are already
 * here. Measured 2026-10-27 at 1517.
 *
 * 1517 to 1518: `coding-agent/src/session/runtime/provider-transport.ts`, the session collaborator
 * that installs the response and raw SSE interceptors on the agent, holds the raw SSE capture and
 * the side stream function, and prepares the options of a side request. It left
 * `session/agent-session.ts`, already here, and its runtime imports (`@veyyon/ai/stream`,
 * `config/settings.ts` and `debug/raw-sse-buffer.ts`) are already here. Measured 2026-10-27 at 1518.
 *
 * 1518 to 1519: `coding-agent/src/session/runtime/exit-record.ts`, the session collaborator that
 * writes the redacted tool start markers and the one `session_exit` entry, and registers the process
 * teardown callback that writes it when no dispose runs. It left `session/agent-session.ts`, already
 * here, and its runtime imports (`@veyyon/kernel/session/exit-diagnostics` and `@veyyon/utils`) are
 * already here. Measured 2026-10-27 at 1519.
 *
 * 1519 to 1520: `coding-agent/src/session/runtime/session-events.ts`, the session collaborator that
 * holds the subscribers, the extension event forwarder and the wire-level `agent_end` held while a
 * prompt unwinds. It left `session/agent-session.ts`, already here, and its runtime imports
 * (`@veyyon/utils` and `runtime/extension-event-forwarder.ts`) are already here. Measured 2026-10-27
 * at 1520.
 *
 * 1520 to 1521: `coding-agent/src/session/runtime/turn-continuations.ts`, the session collaborator
 * that schedules the continuations a session starts on its own and the recovery wait a prompt runs.
 * It left `session/agent-session.ts`, already here, and its runtime imports (`@veyyon/utils` and
 * `prompts/turn-control/rows.ts`) are already here. Measured 2026-10-27 at 1521.
 *
 * 1521 to 1522: `coding-agent/src/session/runtime/transcript-exports.ts`, the session collaborator
 * behind the HTML export, the copy texts and the dumps. It left `session/agent-session.ts`, already
 * here, and its static imports (`session-dump-format.ts`, `agent-session-message-shapes.ts` and
 * `@veyyon/ai/utils/schema`) are already here; `export/html` stays behind its lazy import. Measured
 * 2026-10-27 at 1522.
 *
 * 1522 to 1523: `coding-agent/src/session/runtime/turn-input.ts`, the session collaborator that
 * builds the mode blocks, the `@path` mention reads and the `before_agent_start` input a prompt
 * carries. It left `session/agent-session.ts`, already here, and its runtime imports
 * (`edit/file-snapshot-store.ts`, `utils/file-mentions.ts`, `utils/file-display-mode.ts`,
 * `utils/image-loading.ts` and the goals and session prompt rows) are already here. Measured
 * 2026-10-27 at 1523.
 *
 * 1523 to 1524: `coding-agent/src/session/runtime/session-release.ts`, the session collaborator that
 * releases at dispose the jobs, owned job manager, eval kernels, session-scoped resources and MCP
 * hold the session ends with. It left `session/agent-session.ts`, already here, and its runtime
 * imports (`@veyyon/kernel/session/owned-resources`, `@veyyon/utils` and `async/`) are already here.
 * Measured 2026-10-27 at 1524.
 *
 * 1524 to 1525: `coding-agent/src/session/runtime/custom-messages.ts`, the session collaborator that
 * routes a custom message by the arrival state into the queues, the next turn, a turn or the
 * context, and runs one as a prompt. It left `session/agent-session.ts`, already here, and its
 * runtime imports (`@veyyon/agent-core`, `@veyyon/utils/content-text` and `session/messages.ts`) are
 * already here. Measured 2026-10-27 at 1525.
 *
 * 1525 to 1528: `utils/src/config-root.ts`, `utils/src/global-config.ts` and
 * `utils/src/global-config-write.ts`, split out of `utils/src/dirs.ts` with no code added: the config
 * root, the reader of the global `config.yml`, and its writer. The `@veyyon/utils` barrel, already
 * here, exports all three and `dirs.ts` imports the first two; every module they import is already
 * here. Measured 2026-10-28 at 1528.
 *
 * A ratchet, not a target: nothing breaks when it grows, which is exactly why it is pinned. There
 * is no margin left on purpose — the next module on this graph is a barrel someone reached for
 * and owes a line here.
 */
const LAUNCH_REACH_CEILING = 1528;

/**
 * Measured at 498, down from 538 at the merge base and 718 before the aggregate edge was cut. The
 * assembler is the module the edge was on, so this is the number that moved, and a subprocess that
 * imports it alone pays it directly.
 *
 * 520 to 521: `catalog/catalog-spans.ts`, the zero-import leaf that indexes each provider's and each
 * model's byte span of `models.json`. `catalog/models.ts`, already here, reads one span through it
 * instead of parsing the whole catalog.
 *
 * 521 to 522: `ai/src/utils/schema/arktype.ts`, for the reason the launch ceiling above records.
 *
 * 522 to 523: `utils/src/local-time.ts`, which reads local time from the C library's `localtime_r`
 * so a launch builds no ICU time zone cache. `logger.ts` and `log-file.ts`, already here, read through
 * it, and its one import is `bun:ffi`. The launch count above is unchanged: the session's local day
 * moved from `coding-agent/src/utils/local-date.ts`, which left, to the same module.
 *
 * 523 to 524: `ai/src/dialect/json-tool-call-scanner.ts`, for the reason the launch ceiling above
 * records.
 *
 * 524 to 525: `ai/src/dialect/bracket-walk.ts`, for the reason the launch ceiling above records.
 *
 * 525 to 526: `catalog/wire/kimi-code.ts`, for the reason the launch ceiling above records.
 * `catalog/provider-models/openai-compat.ts`, already here, resolves a Kimi request's endpoint through it.
 *
 * 526 to 488: re-measured. The modules that left prompt assembly since the last entry had left it
 * without lowering this line, so the slack would have admitted 38 new ones unrecorded.
 *
 * 488 to 489: re-measured at 487 before, plus `ai/src/prompts/tool-choice/any.md` and
 * `ai/src/prompts/tool-choice/named.md`, which `ai/src/prompts/registry.ts`, already here, registers.
 *
 * 489 to 492: the three modules split out of `utils/src/dirs.ts`, for the reason the launch ceiling
 * above records.
 */
const ASSEMBLER_REACH_CEILING = 492;

function reached(entry: string): string[] {
	return [...moduleReach(entry, RESOLUTION, CACHE)].map(file => path.relative(REPO_ROOT, file)).sort();
}

describe("a launch does not build every prompt registry", () => {
	it("never reaches the registry aggregate", () => {
		const files = reached(LAUNCH);
		const aggregate = path.relative(REPO_ROOT, AGGREGATE);

		expect(files, `${aggregate} is on the launch graph again`).not.toContain(aggregate);
	});

	it("never reaches it from prompt assembly either, which is where the edge was", () => {
		const files = reached(ASSEMBLER);

		expect(files).not.toContain(path.relative(REPO_ROOT, AGGREGATE));
	});

	it(`keeps the launch graph at or under ${LAUNCH_REACH_CEILING} modules`, () => {
		const total = moduleReachCount(LAUNCH, RESOLUTION, CACHE);

		expect(total, `modules reachable from main.ts:\n${reached(LAUNCH).join("\n")}`).toBeLessThanOrEqual(
			LAUNCH_REACH_CEILING,
		);
	});

	it(`keeps prompt assembly at or under ${ASSEMBLER_REACH_CEILING} modules`, () => {
		const total = moduleReachCount(ASSEMBLER, RESOLUTION, CACHE);

		expect(total, `modules reachable from system-prompt.ts:\n${reached(ASSEMBLER).join("\n")}`).toBeLessThanOrEqual(
			ASSEMBLER_REACH_CEILING,
		);
	});

	it("still reaches the id list the refusal reads, so the check did not go missing", () => {
		const files = reached(ASSEMBLER);

		expect(files).toContain(path.relative(REPO_ROOT, path.join(SRC, "prompts", "ids.generated.ts")));
	});

	it("leaves the aggregate reachable for the surfaces that want every registry", () => {
		const listing = reached(path.join(SRC, "cli", "prompt-cli.ts"));

		expect(listing).toContain(path.relative(REPO_ROOT, AGGREGATE));
	});
});
