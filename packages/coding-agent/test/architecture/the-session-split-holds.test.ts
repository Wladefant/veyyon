/**
 * WHY: `agent-session.ts` carried 1430 lines of module-level declarations — the
 * event union, the config record, the permission table, the queue readers, the
 * retry-fallback selector grammar, the compaction verdicts and the message-shape
 * readers — mixed in with the class that uses them. Those declarations touch no
 * instance state, so every importer of one of them pulled in the whole runtime.
 * They now live in sibling modules beside it, and the compaction policy has since
 * moved on again into `@veyyon/kernel`. Four families of instance state have left
 * too — TTSR, the todo board, the thinking level and the advisors — as collaborators
 * under `runtime/`, each owning its own fields behind a host interface it declares.
 *
 * The defect class this closes is a split that unwinds. Three shapes of it:
 * a sibling or collaborator that imports back from `agent-session.ts`, which makes
 * the pair one module with two files and neither constructible alone; a sibling
 * that grows into a second runtime; and a new concern appearing without a
 * decision. Both sets are read off the directory at run time and pinned by exact
 * equality, so adding one turns this red until it is recorded here.
 *
 * The ceilings are MEASURED, not aspirational, and they ratchet DOWN: the second
 * size test fails when a ceiling sits more than 5% above the file, so a family
 * that leaves the class must be recorded as a smaller number rather than left as
 * slack for the next one to grow into.
 *
 * What it does not catch: a sibling that stays small and wrong, a declaration
 * filed under the sibling whose name reads best rather than the concern it
 * belongs to, and a collaborator whose host interface names the whole session —
 * width is a judgement this cannot make, and a 60-member host would pass here.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { importSpecifiers, lineCount, repoPath, subdirectories } from "./helpers/module-graph";

const SESSION_DIR = repoPath("packages/coding-agent/src/session");
const RUNTIME = `${SESSION_DIR}/agent-session.ts`;
const FACADE = `${SESSION_DIR}/facade.ts`;

/**
 * MEASURED at 9456 lines. Model target selection left earlier — the role resolver, the
 * configured-target reader, the compaction candidate walk and its effort map — and provider request
 * shaping (payload redaction, the Anthropic metadata block, the tool-order permutation check) left
 * after it, because not one of those members read or wrote a field of the runtime: every input was
 * a parameter, so they sat in the class only because of where they were typed. TTSR, the todo board,
 * the thinking level, the advisor roster, the streaming-edit guard, tool discovery, the checkpoint
 * state, user shell and eval runs, the post-prompt task tracker, the IRC inbox, the retry ladder and
 * its model fallback, secret redaction, compaction with its summarizer and dead-end recovery, and
 * the prewalk and plan-yolo model handoffs, plan mode with its plan reference and decision
 * ladder, the message write queue with its persistence-key index, the context figure with its
 * prompt snapshot and rewrite anchor, the memory backend state with its delivered recall, the
 * provider session ids with the inherited prompt cache key, the tool-call loop guard with the
 * Gemini reasoning-header detector, the empty-stop and unexpected-stop retry cycles, the
 * provider usage recording with its saved-reset redeems, the history rewrites (stale-result and
 * overflow prunes, image drops, shake and dedup), the terminal `yield` record, the evidence
 * ledger with the rewind, verification and review reminders, and the approval state (the
 * auto-approve flag, the `/yolo` bypass, the kept per-tool decisions and the ACP permission proxy)
 * and the provider wire shaping (the tool-call id map, the relativization root and the bytes each
 * request left out), the extension event forwarding with its turn index, the session title refresh
 * on a re-plan, the serialized scope transitions with the cwd re-scoping they run, the in-flight
 * prompt count with the macOS power assertion, and the end-of-turn context check with its overflow,
 * incomplete-output, promoted-model retry and threshold cases left as collaborators under `runtime/`.
 * The number falls again when the next one leaves. It ratchets: slack is what it takes to not fail
 * on the next honest edit, and a ceiling left far above a shrinking file stops being a bound.
 * RE-MEASURED 2026-10-09 at 9811: the session-switch rollback record and its single-purpose
 * adoption steps (+92), the end-of-turn context check split into its recovery cases (+32), the
 * agent-event reattachment after a part-way failed transition (+24), the composer prediction hook
 * (+11) and the verification reminder's active-tool-name source (+1) grew the class in place.
 * RE-MEASURED 2026-10-16 at 9015: session-switch adoption and rollback left as the
 * `session-switch.ts` collaborator (-371).
 * RE-MEASURED 2026-10-16 at 8654: branching, the `/btw` branch and tree navigation with its
 * branch summary left as the `session-branch.ts` collaborator (-361).
 * RE-MEASURED 2026-10-16 at 8446: the handoff document and the new session it seeds left as the
 * `session-handoff.ts` collaborator (-208).
 * RE-MEASURED 2026-10-16 at 7992: the active tool set, the base system prompt with its
 * invalidation record and rebuild digest, and the MCP, RPC host, SSH and vibe registry refreshes
 * left as the `tool-activation.ts` collaborator (-454).
 * RE-MEASURED 2026-10-16 at 7834: the ephemeral side-channel turn and its history snapshot left
 * as the `agent-session-ephemeral-turn.ts` sibling (-160); it holds no instance state and reads
 * the session through a host interface.
 * RE-MEASURED 2026-10-16 at 7733: the goal todo context and the magic keyword notices left as the
 * `agent-session-turn-notices.ts` sibling (-101); it reads the session through a host interface
 * the session satisfies structurally.
 * RE-MEASURED 2026-10-17 at 7423: extension and custom slash-command resolution, and the command
 * context a session builds when no extension runner does, left as the `agent-session-commands.ts`
 * sibling (-228); it reads the session through a host interface the session satisfies structurally.
 * RE-MEASURED 2026-10-26 at 7271: IRC delivery (the incoming record, its steer, inbox, context or
 * wake-turn route, the auto-reply and the stranded-record resume and flush) left as the
 * `irc-delivery.ts` collaborator (-176); it holds the IRC inbox.
 * RE-MEASURED 2026-10-26 at 7215: the `session_stop` hook pass and its continuation chain left as
 * the `session-stop-hook.ts` collaborator (-56).
 * RE-MEASURED 2026-10-26 at 7142: the hidden next-turn queue and the turn a queued message requests
 * left as the `next-turn-messages.ts` collaborator (-73).
 * RE-MEASURED 2026-10-26 at 6962: the saved switch, the session-only switch and the Ctrl+P cycle
 * left as the `model-selection.ts` collaborator with the scoped models (-180).
 * RE-MEASURED 2026-10-27 at 6930: the session budget registration, its id-change rekey and its
 * settings listener left as `bindSessionBudget` in `cpu-limit.ts` (-32).
 * RE-MEASURED 2026-10-27 at 6769: the owned background jobs (late result delivery, the job
 * snapshot, descendant cancellation, the settle wake and the ACP delivery drain) left as the
 * `owned-async-jobs.ts` collaborator (-161).
 * RE-MEASURED 2026-10-27 at 6655: the release of what a conversation ends with (its spawned agents,
 * registry scope, IRC traffic, standing grants and eval kernels) left as the
 * `conversation-release.ts` collaborator (-114).
 * RE-MEASURED 2026-10-27 at 6459: the routing of a run that ended (the yield short-circuit, stop
 * recovery, the compaction check, the stop-time continuation passes and the `session_stop` hooks)
 * left as the `stop-settlement.ts` collaborator (-196).
 * RE-MEASURED 2026-10-27 at 6245: the steers and follow-ups on the agent's queues (queueing a user
 * or hidden developer message, the drain that starts a turn on them, the count, the chips, clear and
 * pop) left as the `queued-messages.ts` collaborator (-171 from 6416, after the unusable-credential
 * message moved to `missing-credentials.ts`).
 * RE-MEASURED 2026-10-27 at 6138: running a shell command or Python cell the user typed (the
 * `user_bash` and `user_python` extension hand-off, the run, the record and the artifact holding a
 * command's unminimized output) moved into the `user-executions.ts` collaborator (-107).
 * RE-MEASURED 2026-10-27 at 5967: the threshold checks before a prompt and between the provider
 * calls of a tool loop, and the switch to a larger-context model they share with the post-turn
 * check, moved into the `turn-context-check.ts` collaborator (-171).
 * RE-MEASURED 2026-10-27 at 5729: starting a new transcript with `/new` or `/drop` and forking one
 * with `/fork` moved into the `session-switch.ts` collaborator (-136 from 5963), then the session-state
 * block and the eager delegate reminders a turn carries ahead of its message moved into the
 * `turn-preludes.ts` collaborator (-98).
 * RE-MEASURED 2026-10-27 at 5653: the per-family service tiers, `/fast` and the tier each request
 * resolves to moved into the `service-tiers.ts` collaborator (-76).
 * RE-MEASURED 2026-10-27 at 5545: the command registries, the resolution of a typed prompt through
 * extension, custom and file-based commands and the prompt templates, and the agents a `/` command
 * grants for its turn moved into the `prompt-commands.ts` collaborator (-108).
 * RE-MEASURED 2026-10-27 at 5455: the display copy of assistant content, tool intents, streamed
 * deltas and rebuilt transcripts, with the stream decoder it holds, moved into the `display-copy.ts`
 * collaborator (-90).
 * RE-MEASURED 2026-10-27 at 5340: the latest images a tool addresses, the normalization of a
 * message's images for the active model and the description a text-only model reads in their place
 * moved into the `image-attachments.ts` collaborator (-115).
 * RE-MEASURED 2026-10-27 at 5212: the response and raw SSE interceptors every request runs with,
 * the raw SSE capture, the side stream function and the side-request option preparation moved into
 * the `provider-transport.ts` collaborator (-128).
 * RE-MEASURED 2026-10-27 at 5115: the `/move` marker nothing set was removed with its dispose step
 * (-9), and the tool start markers and the exit entry moved into the `exit-record.ts`
 * collaborator (-88).
 * RE-MEASURED 2026-10-27 at 5029: the subscriber list, the extension event forwarder and the held
 * wire-level `agent_end` moved into the `session-events.ts` collaborator, and a doc comment that
 * documented no member was dropped (-86).
 * RE-MEASURED 2026-10-27 at 4917: the scheduled `agent.continue()`, the auto-continue prompt a
 * compaction resumes with, their cancel and the recovery wait a prompt runs moved into the
 * `turn-continuations.ts` collaborator (-112).
 * RE-MEASURED 2026-10-27 at 4833: the HTML export, the copy texts, the plain-text dump and the
 * request snapshot moved into the `transcript-exports.ts` collaborator, taking the session's one
 * dynamic import with them (-84).
 * RE-MEASURED 2026-10-27 at 4755: the next-turn lease a prompt holds until the agent takes its input
 * added 11 lines (4844), then the mode blocks, the `@path` mention reads and the `before_agent_start`
 * extension input moved into the `turn-input.ts` collaborator (-89).
 * RE-MEASURED 2026-10-27 at 4692: the release at dispose of the session's jobs, owned job manager,
 * eval kernels, session-scoped resources and MCP hold moved into the `session-release.ts`
 * collaborator, and the memory backends' release into `memory-context.ts` (-63).
 * RE-MEASURED 2026-10-27 at 4548: how a custom message reaches the conversation, queued, held for
 * the next turn, run as a turn or appended, and the custom-message prompt with its keyword notices
 * moved into the `custom-messages.ts` collaborator (-144).
 */
const RUNTIME_CEILING = 4_600;

/** The one subdirectory `src/session/` holds: the collaborators. */
const RUNTIME_DIR = "runtime";

/**
 * Collaborators that own a subsystem's state, pinned by exact equality. A new
 * one fails here before it fails anywhere useful, which is the point: a
 * collaborator is a decision about where state lives, not a file drop.
 */
const COLLABORATORS = [
	"advisor-roster.ts",
	"checkpoint-runtime.ts",
	"compaction-recovery.ts",
	"compaction-runtime.ts",
	"compaction-summarizer.ts",
	"context-accounting.ts",
	"conversation-release.ts",
	"custom-messages.ts",
	"display-copy.ts",
	"exit-record.ts",
	"extension-event-forwarder.ts",
	"finalize-reminders.ts",
	"history-rewrites.ts",
	"image-attachments.ts",
	"irc-delivery.ts",
	"irc-inbox.ts",
	"loop-guards.ts",
	"max-concurrency-runtime.ts",
	"memory-context.ts",
	"message-persistence.ts",
	"model-handoff.ts",
	"model-selection.ts",
	"next-turn-messages.ts",
	"owned-async-jobs.ts",
	"plan-mode-runtime.ts",
	"post-prompt-tasks.ts",
	"prompt-commands.ts",
	"provider-sessions.ts",
	"provider-transport.ts",
	"provider-usage.ts",
	"provider-wire.ts",
	"queued-messages.ts",
	"replan-title-refresh.ts",
	"retry-fallback.ts",
	"retry-runtime.ts",
	"service-tiers.ts",
	"session-approvals.ts",
	"session-branch.ts",
	"session-events.ts",
	"session-handoff.ts",
	"session-release.ts",
	"session-scope.ts",
	"session-secrets.ts",
	"session-stop-hook.ts",
	"session-switch.ts",
	"stop-retries.ts",
	"stop-settlement.ts",
	"streaming-edit-guard.ts",
	"thinking-runtime.ts",
	"todo-runtime.ts",
	"tool-activation.ts",
	"tool-discovery.ts",
	"transcript-exports.ts",
	"ttsr-runtime.ts",
	"turn-context-check.ts",
	"turn-continuations.ts",
	"turn-input.ts",
	"turn-preludes.ts",
	"turns-in-flight.ts",
	"user-executions.ts",
	"yield-tracker.ts",
] as const;

/** MEASURED: the largest collaborator is `retry-runtime.ts` at 959 lines. */
/** RE-MEASURED 2026-10-04: `retry-runtime.ts` at 1028 lines and `advisor-roster.ts` at 1003 after the upstream port wave (#219). */
const COLLABORATOR_CEILING = 1_028;

/** MEASURED: the largest sibling is `agent-session-types.ts` at 782 lines. */
const SIBLING_CEILING = 900;

/**
 * MEASURED: the facade is 342 lines. It was also held under a twentieth of the runtime, but the
 * runtime is the file every extraction shrinks: at 6769 lines that ratio turned red with the facade
 * unchanged, so it measured the decomposition rather than the facade. The ceiling ratchets instead,
 * like the runtime's, and 345 sits under the 346 the ratio last allowed.
 */
const FACADE_CEILING = 345;

/**
 * The concerns that left the runtime and still sit beside it, pinned by exact
 * equality. An eleventh sibling, or one renamed, fails here before it fails anywhere
 * useful. The compaction policy was one of them and is no longer here: it moved to
 * `@veyyon/kernel/session/agent-session-compaction-policy` with the session spine,
 * so a copy reappearing under `src/session/` is a drift this cell reports.
 */
const SIBLINGS = [
	"agent-session-commands.ts",
	"agent-session-ephemeral-turn.ts",
	"agent-session-message-shapes.ts",
	"agent-session-model-targets.ts",
	"agent-session-permissions.ts",
	"agent-session-provider-request.ts",
	"agent-session-queue.ts",
	"agent-session-retry-fallback.ts",
	"agent-session-turn-notices.ts",
	"agent-session-types.ts",
] as const;

/** Every `agent-session-*.ts` beside the runtime, derived from the directory. */
function siblingFiles(): string[] {
	return readdirSync(SESSION_DIR)
		.filter(name => name.startsWith("agent-session-") && name.endsWith(".ts"))
		.sort();
}

/** Every module inside `runtime/`, derived from the directory. */
function collaboratorFiles(): string[] {
	return readdirSync(`${SESSION_DIR}/${RUNTIME_DIR}`)
		.filter(name => name.endsWith(".ts"))
		.sort();
}

describe("the modules the session runtime was split into", () => {
	it("are exactly the concerns that left it and stayed beside it", () => {
		expect(siblingFiles()).toEqual([...SIBLINGS]);
	});

	it("never import back from the runtime", () => {
		const offenders: string[] = [];
		for (const name of siblingFiles()) {
			for (const specifier of importSpecifiers(`${SESSION_DIR}/${name}`)) {
				const resolved = specifier.replace(/\.ts$/, "");
				if (resolved === "./agent-session" || resolved.endsWith("/session/agent-session")) {
					offenders.push(`${name} -> ${specifier}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("stay under the measured sibling ceiling", () => {
		const oversized = siblingFiles()
			.map(name => ({ name, lines: lineCount(`${SESSION_DIR}/${name}`) }))
			.filter(entry => entry.lines > SIBLING_CEILING);
		expect(oversized).toEqual([]);
	});

	it("are each smaller than the runtime they left", () => {
		const runtime = lineCount(RUNTIME);
		for (const name of siblingFiles()) {
			expect(lineCount(`${SESSION_DIR}/${name}`)).toBeLessThan(runtime);
		}
	});
});

describe("the session runtime's size", () => {
	it("stays under the measured ceiling", () => {
		expect(lineCount(RUNTIME)).toBeLessThanOrEqual(RUNTIME_CEILING);
	});

	it("has a ceiling tight enough to fail on real growth", () => {
		expect(RUNTIME_CEILING).toBeLessThanOrEqual(Math.round(lineCount(RUNTIME) * 1.05));
	});
});

describe("the facade's size", () => {
	it("stays under the measured ceiling", () => {
		expect(lineCount(FACADE)).toBeLessThanOrEqual(FACADE_CEILING);
	});

	it("has a ceiling tight enough to fail on real growth", () => {
		expect(FACADE_CEILING).toBeLessThanOrEqual(Math.round(lineCount(FACADE) * 1.05));
	});
});

describe("the session directory", () => {
	it("holds only the collaborator directory, so a sibling cannot hide in one", () => {
		expect(subdirectories(SESSION_DIR)).toEqual([`${SESSION_DIR}/${RUNTIME_DIR}`]);
	});
});

describe("the collaborators the session runtime delegates to", () => {
	it("are exactly the subsystems recorded here", () => {
		expect(collaboratorFiles()).toEqual([...COLLABORATORS]);
	});

	/**
	 * The defect that makes an extraction pointless: the collaborator declares a
	 * host interface, then reaches around it by importing the session anyway, so
	 * the pair is one module with two files and neither can be constructed alone.
	 * The declaration siblings (`agent-session-types.ts` and the rest) are fine to
	 * import — they hold no instance state, which is why they left first.
	 */
	it("never import back from the runtime", () => {
		const offenders: string[] = [];
		for (const name of collaboratorFiles()) {
			for (const specifier of importSpecifiers(`${SESSION_DIR}/${RUNTIME_DIR}/${name}`)) {
				const resolved = specifier.replace(/\.ts$/, "");
				if (resolved === "../agent-session" || resolved.endsWith("/session/agent-session")) {
					offenders.push(`${name} -> ${specifier}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("stay under the measured collaborator ceiling", () => {
		const oversized = collaboratorFiles()
			.map(name => ({ name, lines: lineCount(`${SESSION_DIR}/${RUNTIME_DIR}/${name}`) }))
			.filter(entry => entry.lines > COLLABORATOR_CEILING);
		expect(oversized).toEqual([]);
	});
});
