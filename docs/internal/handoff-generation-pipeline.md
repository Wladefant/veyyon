# `/handoff` generation pipeline

This document describes how the coding-agent implements `/handoff`: trigger path, oneshot generation, session switch, context reinjection, persistence, and UI behavior.

## Scope

Covers:

- Interactive `/handoff` command dispatch
- `AgentSession.handoff()` lifecycle and state transitions
- `generateHandoff(...)` request shape
- How old/new sessions persist handoff data differently
- UI behavior for success, cancel, and failure

Does not cover:

- Generic tree navigation/branch internals
- Non-handoff session commands (`/new`, `/fork`, `/resume`)

## Implementation files

- [`../src/modes/terminal/controllers/prompt-submission.ts`](../../packages/coding-agent/src/modes/terminal/controllers/prompt-submission.ts)
- [`../src/modes/terminal/controllers/command-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/command-controller.ts)
- [`../src/modes/terminal/controllers/composer-escape.ts`](../../packages/coding-agent/src/modes/terminal/controllers/composer-escape.ts)
- [`../src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/runtime/session-handoff.ts`](../../packages/coding-agent/src/session/runtime/session-handoff.ts)
- [`../src/session/runtime/conversation-release.ts`](../../packages/coding-agent/src/session/runtime/conversation-release.ts)
- [`packages/agent/src/compaction/compaction.ts`](../../packages/agent/src/compaction/compaction.ts)
- [`kernel/src/session/session-manager.ts`](../../kernel/src/session/session-manager.ts)
- [`../src/slash-commands/builtin-declarations.ts`](../../packages/coding-agent/src/slash-commands/builtin-declarations.ts)
- [`../src/slash-commands/builtin-registry.ts`](../../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`../src/slash-commands/builtin-context.ts`](../../packages/coding-agent/src/slash-commands/builtin-context.ts)

## Trigger path

1. `/handoff` is declared in the builtin slash command metadata (`slash-commands/builtin-declarations.ts`) with inline hint `[focus instructions]`.
2. `PromptSubmission` routes submitted text through `dispatchBuiltinSlashCommand(...)`, which runs `executeBuiltinSlashCommand(...)` (`slash-commands/builtin-registry.ts`) before normal prompt submission.
3. The builtin's TUI handler (`slash-commands/builtin-context.ts`) clears the editor and calls `handleHandoffCommand(customInstructions?)`.
4. `CommandController.handleHandoffCommand` refuses while the session streams, then performs a preflight guard using current entries:
   - Counts `type === "message"` entries.
   - If `< 2`, it warns: `Nothing to hand off (no messages yet)` and returns.

The same minimum-content guard exists again inside `AgentSession.handoff()` and throws if violated. This duplicates safety at both UI and session layers.

## End-to-end lifecycle

### 1) Start handoff generation

`AgentSession.handoff(customInstructions?)` delegates to `SessionHandoff.run()` (`session/runtime/session-handoff.ts`), which:

- Reads current branch entries (`sessionManager.getBranch()`).
- Validates minimum message count (`>= 2`).
- Streaming guards live in the explicit callers: the TUI `/handoff`, the text-mode `/handoff` in `builtin-context.ts` and the RPC `handoff` command each refuse with `Wait for the current response to finish or abort it before handing off.` Resetting the agent mid-stream would let the live turn keep emitting into the torn-down session.
- Creates the handoff abort controller and links any caller-provided abort signal to it.
- Throws when no model is selected, and resolves the current model API key through `ModelRegistry`, throwing the missing-credentials message when none resolves.
- Builds the handoff request through the **same pipeline a live turn uses**: the cache-preserving side-request path shared with `runEphemeralTurn` (`/btw`, `/omfg`):
  1. Renders the handoff prompt (`renderHandoffPrompt(...)` with optional `additionalFocus`, after obfuscating any focus instructions) and appends it as a trailing agent-attributed `user` message to a snapshot of `agent.state.messages`.
  2. Converts the snapshot with `convertMessagesToLlm(...)` (applies the session `transformContext`, extension context + steering wrap, then `convertToLlm` + obfuscation), exactly as the loop does.
  3. Builds the provider `Context` with `agent.buildSideRequestContext(llmMessages, baseSystemPrompt)`: normalized tools and `transformProviderContext` (obfuscation) matching the loop. The **base** system prompt is pinned here, not a per-turn `before_agent_start` hook override, so the new session does not inherit prompt-specific hook state.
  4. Builds stream options with `prepareSimpleStreamOptions(...)`: `promptCacheKey = agent.promptCacheKey ?? agent.sessionId`, exactly the key the live turn routed the provider cache under (it can diverge from `this.sessionId` for tan/agent/shared sessions), a unique side `sessionId` (`<sid>:side:<snowflake>`) so OpenAI/Codex append-only state never mixes with the live turn, `serviceTier`/payload hooks mirrored from the session, and `preferWebsockets: false`.
- Calls `generateHandoffFromContext(context, model, { streamOptions, completeImpl, telemetry, thinkingLevel })`, where `completeImpl` is the session's side transport (`AgentSession.sideComplete`, over `ProviderTransport.sideStreamFn`) instead of the default `completeSimple` transport.

### 2) Generate and capture output

`generateHandoffFromContext(...)` lives in `packages/agent/src/compaction/compaction.ts` next to summarization. It is the handoff request contract: it issues one `instrumentedCompleteSimple(...)` (the OTEL-instrumented `completeSimple` oneshot wrapper) against the caller-built `Context`, forcing `toolChoice: "none"` and `reasoning: resolveCompactionEffort(model, thinkingLevel)` over whatever the caller's `streamOptions` carried:

```ts
await instrumentedCompleteSimple(
  model,
  context, // system prompt + normalized tools + transformed history + trailing handoff prompt
  {
    ...streamOptions, // apiKey, signal, sessionId, promptCacheKey, serviceTier, hooks
    reasoning: resolveCompactionEffort(model, options.thinkingLevel),
    toolChoice: "none",
  },
  { telemetry, oneshotKind: "handoff", completeImpl: options.completeImpl },
);
```

If the first attempt errors and `shouldRetryHandoffWithAutoToolChoice(response)` matches (providers that reject `tool_choice: "none"`), it retries exactly once with `toolChoice: "auto"` before giving up.

(`generateHandoff(messages, …)` remains exported for downstream callers and builds a basic `Context` from `systemPrompt`/`tools`/`convertToLlm` before delegating to `generateHandoffFromContext`. `SessionHandoff` does not use it because it cannot apply the host's transform pipeline or cache routing.)

Important generation properties:

- The request shares the live provider cache prefix because the `Context` is built by the identical transform + normalization pipeline the loop uses, and routed with the same `promptCacheKey` the turn used.
- The handoff instruction is a trailing `user` message, not a developer message, so the cached prefix remains aligned with the prior turn (the trailing message is the only divergence point).
- `toolChoice: "none"` prevents intentional tool dispatch (with the one-shot `"auto"` retry above for providers that reject it).
- The returned assistant content is filtered to text blocks and joined with `\n`; stray tool-call blocks are ignored if a provider does not honor `toolChoice: "none"`.
- `stopReason === "error"` throws a generation error.
- An empty document (after trimming) throws rather than returning, so a model that emits no text cannot start a new session with nothing in it. A document that repeats one sentence until the budget runs out (`detectDegenerateRepetition`) throws the same way.
- `SessionHandoff` then expands obfuscated secrets for display and appends the deterministic `<files>` block to the returned text (`extractFileOpsFromMessages` + `computeFileLists` + `upsertFileOperations`), the same read/modified file list the summary strategy emits. It is machine-generated from the live messages and costs no extra request.

No agent-loop events are used for capture. The handoff path no longer waits for `agent_end` and no longer scans the latest assistant message.

### 3) Cancellation checks

Cancellation throws `Error("Handoff cancelled")`; an empty generated document throws a generation error.

- caller signal aborts the handoff abort controller
- `completeSimple(...)` receives the abort signal
- aborted handoff signal or the provider's `RequestAbortError` (whose `name` is still `AbortError`) is normalized to `Error("Handoff cancelled")`
- an empty generated document throws from `generateHandoffFromContext` instead of returning `undefined`

`SessionHandoff.run()` always clears its abort controller in `finally`.

### 4) New session creation

If text was generated and not aborted:

1. Emit `session_before_switch` (`reason: "handoff"`) to extensions when handlers exist; a `cancel` result aborts the switch: `handoff()` calls `options.onSwitchCancelled?.()` and returns `undefined` (no new session).
2. Flush current session writer (`sessionManager.flush()`).
3. Cancel the async jobs of this agent and of every agent it spawned (`OwnedAsyncJobs.cancelOwn()`).
4. Start a brand-new session with `parentSession` pointing at the previous session file when one exists.
5. Release what the conversation being left holds (`ConversationRelease.release()`): terminate its spawned agents, drop their IRC traffic and the standing per-tool approval grants, re-scope the agent registry so agents that wrote into the old transcript are not listed under the new conversation, and release its eval kernels. Then clear checkpoint runtime state.
6. Reset in-memory agent state (`agent.reset()`): but the steering and follow-up queues are captured immediately before the reset (`peekSteeringQueue()`/`peekFollowUpQueue()`) and restored immediately after (`replaceQueues`), so steers/follow-ups issued during handoff generation survive into the new session instead of being dropped.
7. Clear the fresh provider session id and rebind `agent.sessionId` and the request metadata resolver to the new session id (`ProviderSessions.sync()`).
8. Rekey/reset Hindsight and Mnemopi memory session tracking for the new session.
9. Clear the queued next-turn messages and the scheduled hidden next turn (`NextTurnMessages.clear()`).
10. Reset todo reminder counters and mid-run nudge state (`TodoRuntime.resetForNewContext()`).
11. After injection and context rebuild, emit `session_switch` (`reason: "handoff"`, with `previousSessionFile`) to extensions.

### 5) Handoff-context injection

The generated handoff document is wrapped by coding-agent session glue and appended to the new session as a `custom_message` entry:

```text
<handoff-context>
...handoff text...
</handoff-context>

The above is a handoff document from a previous session. Use this context to continue the work seamlessly.
```

Insertion call:

```ts
this.sessionManager.appendCustomMessageEntry(
  "handoff",
  handoffContent,
  true,
  undefined,
  "agent",
);
```

Semantics:

- `customType`: `"handoff"`
- `display`: `true` (visible in TUI rebuild)
- attribution: `"agent"`
- Entry type: `custom_message` (participates in LLM context)
- Todo phases captured before the switch are re-persisted into the new session as a `USER_TODO_EDIT_CUSTOM_TYPE` snapshot entry, the same one `/todo` writes, so a reload of the new transcript still finds them.

### 6) Rebuild active agent context

After injection:

1. `buildDisplaySessionContext()` resolves message list for current leaf.
2. `agent.replaceMessages(sessionContext.messages)` makes the injected handoff message active context.
3. Advisor runtimes are reset, and todo phases are synchronized from the new branch.
4. Method returns `{ document: handoffText, savedPath? }`.

At this point, the active LLM context in the new session contains the injected handoff message, not the old transcript.

## Persistence model: old session vs new session

### Old session

Handoff generation is a oneshot request, not a visible agent turn. The generated handoff text is not appended to the old session as an assistant message.

Result: the original session keeps its prior transcript unchanged except for data already persisted before handoff began.

### New session

After session reset, handoff is persisted as `custom_message` with `customType: "handoff"`.

`buildSessionContext()` converts this entry into a runtime custom/user-context message via `createCustomMessage(...)`, so it is included in future prompts from the new session.

Auto-triggered handoffs can additionally write a timestamped `handoff-*.md` artifact under the session artifacts directory when `compaction.handoffSaveToDisk` is enabled. Manual `/handoff` does not write that artifact.

## Controller/UI behavior

`CommandController.handleHandoffCommand` behavior:

- Refuses with a warning when `session.isStreaming` (matches `/fork` and `/move`): the user must finish or abort the response before handing off.
- Shows a status loader: `Generating handoff… (esc to cancel)`.
- Calls `await session.handoff(customInstructions)`.
- If result is `undefined`: `showError("Handoff cancelled")`.
- On success:
  - clears transient session UI and calls `renderInitialMessages()` (loads new session context, including injected handoff)
  - invalidates status line and editor top border
  - reloads todos
  - appends success chat line: `New session started with handoff context`
  - shows `Handoff document saved to: <path>` when the result carried a `savedPath`
- On exception:
  - if message is `"Handoff cancelled"` or error name is `AbortError`: `showError("Handoff cancelled")`
  - otherwise: `showError("Handoff failed: <message>")`
- Stops the loader, clears the status container, and requests render at end.

Manual `/handoff` no longer streams the generated document into chat. A cancellable loader remains visible while the oneshot request runs, and the chat is rebuilt after generation completes.

## Cancellation semantics

### Session-level cancellation primitive

`AgentSession` exposes:

- `abortHandoff()` → aborts the handoff abort controller
- `isGeneratingHandoff` → true while controller exists

When this abort path is used, the abort signal is passed to `completeSimple(...)`; `handoff()` normalizes the cancellation to `Error("Handoff cancelled")`, and command controller maps it to cancellation UI.

### Interactive `/handoff` path

`ComposerEscape` aborts the view session's maintenance on Escape: while `isGeneratingHandoff` is true, pressing Escape calls `session.abortHandoff()`, which aborts the `completeSimple(...)` request through the handoff abort controller. Compaction and a retry backoff in progress are aborted by the same press.

## Aborted vs failed handoff

Current UI classification:

- **Aborted/cancelled**
  - `abortHandoff()` path triggers `"Handoff cancelled"`, or
  - thrown `AbortError`
  - UI shows `Handoff cancelled`
- **Failed**
  - any other thrown error from `handoff()` / `generateHandoff()` / provider request path
  - UI shows `Handoff failed: ...`

Additional nuance: if an extension cancels via `session_before_switch`, `handoff()` returns `undefined` and the controller reports **cancelled**, not **failed**. An empty generated document throws inside `generateHandoffFromContext`, so it is reported as **failed**.

## Short-session and minimum-content guardrails

Two guards prevent low-signal handoffs:

- UI layer (`handleHandoffCommand`): warns and returns early for `< 2` message entries
- Session layer (`handoff()`): throws the same condition as an error

This avoids creating a new session with empty/near-empty handoff context.

## State transition summary

High-level state flow:

1. Interactive slash command intercepted.
2. Preflight message-count guard.
3. The handoff abort controller is created (`isGeneratingHandoff = true`).
4. `generateHandoffFromContext(...)` issues one `instrumentedCompleteSimple(...)` request with live system prompt, tools, message history, current thinking level, and trailing handoff prompt.
5. Assistant response text blocks are joined; tool-call blocks are discarded.
6. If the generated document is empty → generation error; if aborted → cancellation error path.
7. If present:
   - flush old session
   - cancel async jobs
   - create new empty session with previous session as parent
   - release the conversation being left (spawned agents, registry scope, IRC traffic, standing grants, eval kernels)
   - reset runtime queues/counters
   - append `custom_message(handoff)`
   - optionally save an auto-triggered handoff document under the session artifacts directory when `compaction.handoffSaveToDisk` is enabled
8. Controller rebuilds chat UI and announces success.
9. The handoff abort controller is cleared (`isGeneratingHandoff = false`).

## Known assumptions and limitations

- No structural validation checks that generated markdown follows the requested section format.
- An empty generated document surfaces as a failure in controller UX, not as cancellation.
- Manual handoff has no streaming visibility; a cancellable loader is shown until the UI updates after generation completes.
- Auto-triggered handoffs can write a timestamped `handoff-*.md` artifact when `compaction.handoffSaveToDisk` is enabled; write failure is logged and does not fail the handoff.

*Verified against `2941bcc1ab8512523b70f75c3144050d115a9fb9` on 2026-10-27.*
