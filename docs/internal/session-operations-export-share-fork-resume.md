# Session Operations: export, dump, share, fresh, fork, resume/continue

This document describes operator-visible behavior for session export/share/fork/resume operations as currently implemented.

## Implementation files

- [`packages/coding-agent/src/modes/terminal/controllers/command-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/command-controller.ts)
- [`packages/coding-agent/src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts)
- [`kernel/src/session/session-manager.ts`](../../kernel/src/session/session-manager.ts)
- [`packages/coding-agent/src/export/html/index.ts`](../../packages/coding-agent/src/export/html/index.ts)
- [`packages/coding-agent/src/export/custom-share.ts`](../../packages/coding-agent/src/export/custom-share.ts)
- [`packages/coding-agent/src/main.ts`](../../packages/coding-agent/src/main.ts)

## Operation matrix

| Operation                               | Entry path                | Session mutation                      | Session file creation/switch                                                       | Output artifact                                                 |
| --------------------------------------- | ------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/dump`                                 | Interactive slash command | No                                    | No                                                                                 | Clipboard text plus persistent temp LLM-request JSON sidecar                       |
| `/export [path]`                        | Interactive slash command | No                                    | No                                                                                 | HTML file                                                       |
| `--export <session.jsonl> [outputPath]` | CLI startup fast-path     | No runtime session mutation           | No active session; reads target file                                               | HTML file                                                       |
| `/share`                                | Interactive slash command | No                                    | No                                                                                 | Encrypted share link (gist or share server); temp HTML only for custom handlers |
| `/fresh`                               | Interactive slash command | Yes (provider-facing in-memory id/state only) | No; keeps current session file/header                                               | None                                                            |
| `/fork`                                 | Interactive slash command | Yes (active session identity changes) | Creates new session file and switches current session to it (persistent mode only) | Copies artifact directory to new session namespace when present |
| `--fork <id\|path>`                     | CLI startup               | Yes after session creation            | Creates a new session fork from the selected source into current cwd/session dir   | None                                                            |
| `/resume [id]`                          | Interactive slash command | Yes (active in-memory state replaced) | Switches to selected or named existing session file; another profile's session relaunches in that profile | None                                                            |
| `--resume`                              | CLI startup picker        | Yes after session creation            | Opens selected existing session file                                               | None                                                            |
| `--resume <id\|path>`                   | CLI startup               | Yes after session creation            | Opens existing session in its recorded directory; a match whose directory is gone re-roots into the current project; another profile's session forks into a pinned profile | None                                                            |
| `--continue`                            | CLI startup               | Yes after session creation            | Opens terminal breadcrumb (re-roots it if its dir was moved) or most-recent session; creates new one if none exists   | None                                                            |
| `--continue <UUID>`                     | CLI startup compatibility | Yes after session creation            | Normalizes to explicit resume of that session; non-UUID positional text remains an initial prompt | None                                                            |

## Export and dump

### `/export [outputPath]` (interactive and ACP)

Flow:

1. Both surfaces read the argument through `parseExportTarget` (`src/slash-commands/builtin-share.ts`): trimmed, outer double quotes stripped, spaces kept, the way `/move` and `/cwd` read their paths.
2. The TUI passes the parsed path to `CommandController.handleExportCommand`; ACP and print mode call `session.exportToHtml` directly.
3. `AgentSession.exportToHtml()` delegates to `TranscriptExports.toHtml` (`src/session/runtime/transcript-exports.ts`), which calls `exportSessionToHtml(sessionManager, state, { outputPath, cwd, palette, obfuscator })` with the session's working directory as `cwd`. `finishExport` resolves a given path against that directory (`~` expands). Without a path the generated `veyyon-session-<session>.html` is written to that directory. The returned path is absolute.
4. On success the TUI shows the path and opens the file in the browser; ACP prints it.

Behavior details:

- `--copy`, `clipboard`, and `copy` arguments are rejected with a warning to use `/dump`.
- Export embeds session header/entries/leaf plus current `systemPrompt` and tool descriptions from agent state.
- Agent transcripts stored next to the session file (`<session>/<AgentId>.jsonl`, recursively for nested spawns) are embedded as `subSessions` (`collectSubSessions` in `src/export/html/index.ts`; disable with `includeSubSessions: false` in `ExportOptions`). In the page, agent ids in task tool cards open a breadcrumbed sub-session overlay.
- Tool calls render through the `<vey-tool-view>` web component using projected `ToolExecutionDisplay` values and the React components in `packages/tool-render/src/`, prebuilt into `src/export/html/tool-views.generated.js` by `bun run gen:tool-views`.
- No session entries are appended during export.
- With an obfuscator, export redacts configured secrets in primary and embedded transcripts, including both model fields of provider fallback transitions.
- The process working directory is not consulted. An ACP server holds several sessions, and its working directory is at most one of theirs.

### `--export <inputSessionFile> [outputPath]` (CLI)

Flow in `main.ts`:

1. Handled early (before interactive/session startup).
2. Calls `exportFromFile(inputPath, outputPath?)`.
3. `exportFromFile` stats the input first, then `SessionManager.open(inputPath)` loads entries, and HTML is generated and written.
4. Process prints `Exported to: ...` and exits 0.

Behavior details:

- A missing input fails with `Error: Session file not found: <path>`; a path that is not a regular file fails with `Error: Not a session file: <path>`. Both print to stderr, write nothing, and exit non-zero. The check runs before the open because the loader reads a missing file as an empty session.
- This path does not create an `AgentSession` and does not mutate any running session.

### `/dump` (interactive clipboard export)

Flow:

1. `CommandController.handleDumpCommand()` calls `session.formatSessionAsText()`.
2. If empty string, it reports `No messages to dump yet.`
3. Otherwise it calls `session.dumpLlmRequestToTmpDir()` and, on success, appends the sidecar path plus a raw-context/secrets warning to the formatted transcript.
4. It copies the transcript to the clipboard through native `copyToClipboard`.
5. Status output reports the clipboard copy and either the sidecar path or a separate sidecar error. A sidecar failure does not prevent the clipboard copy.

Dump content includes:

- System prompt
- Active model/thinking level
- Tool definitions + parameters
- User/assistant messages
- Thinking blocks and tool calls
- Tool results and execution blocks (except `excludeFromContext` bash/python entries)
- Custom/hook/file mention/branch summary/compaction summary entries

Dumping does not append session entries or switch the session. The LLM-request JSON sidecar does persist in the operating system's temp directory and can contain raw context or secrets; treat it as sensitive.

## Share

`/share` publishes an end-to-end encrypted snapshot of the session and prints
a viewer link. Implementation: [`packages/coding-agent/src/export/share.ts`](../../packages/coding-agent/src/export/share.ts).

### Phase 1: custom share handler (if present)

`loadCustomShare()` checks the resolved active agent directory from `getAgentDir()` for the first existing candidate:

- `share.ts`
- `share.js`
- `share.mjs`

Requirements:

- Module must default-export a function `(htmlPath) => Promise<CustomShareResult | string | undefined>`.

If present and valid, the legacy contract is preserved: the session is
exported to a temp HTML file (`${os.tmpdir()}/${Snowflake.next()}.html`),
the handler receives its path, and the temp file is removed afterwards.
Handler result interpretation:

- string => treated as URL, shown and opened
- object => `url` and/or `message` shown; `url` opened
- `undefined`/falsy => generic `Session shared`

Critical fallback behavior:

- If custom handler exists but loading fails, command errors and returns.
- If custom handler executes and throws, command errors and returns.
- In both failure cases, it **does not** fall back to the default flow.
- The default flow runs only when no custom share script exists.

### Phase 2: default encrypted share

Only when no custom share handler is found (`shareSession()`):

1. Builds the session snapshot (`header`, `entries`, `leafId`, plus current
   `systemPrompt` and tool descriptions from agent state).
2. If `share.redactSecrets` is enabled (default) and secrets are configured
   (`secrets.*`), the secret obfuscator deep-walks every string in the
   snapshot, replacing configured/discovered secrets with placeholders. The
   obfuscator comes from `session.providerRedactor`, not `session.obfuscator`:
   the second is the expansion authority and is undefined after a
   `/secret disable` or a cwd move, which would make `share.redactSecrets`
   silently do nothing on an upload to a public URL.
3. The JSON is gzipped and sealed with a fresh AES-256-GCM key
   (`[12B IV][ciphertext+tag]`).
4. Upload target is chosen by `share.store`:
   - **Share server** (default, `store: "blob"`): `POST <share.serverUrl>`
     (default `https://share.veyyon.dev/s`) with the raw blob, capped at 1 MB.
     Oversized snapshots are trimmed until they fit: inline images first,
     then long strings (32 KB → 8 KB → 2 KB → 512 B caps), then oldest
     entries.
   - **Secret gist** (`store: "gist"`): when `gh` is installed and
     authenticated, the sealed blob is pushed base64-encoded as
     `session.veyyonshare.txt` (budget 5 MB sealed; gist raw fetches cap at
     10 MB), falling back to the share server when `gh` is unusable.
5. The link is `<share.serverUrl>/<id>#<base64url key>` in both cases. The
   viewer page served there fetches the blob (hex ids via the GitHub gist
   API, anything else from the server's blob store) and decrypts it
   client-side; the key lives only in the URL fragment and never appears in
   any HTTP request.

The UI reports the share URL (plus the underlying gist URL and a truncation
note when applicable). Headless `/share` prints the same lines. Unlike
`/export`, `/share` works for in-memory (`--no-session`) sessions: the
snapshot is built from live entries, no session file required.

Cancellation/abort semantics in share:

- Loader has `onAbort` hook that restores editor UI and reports `Share cancelled`.
- The upload itself is not aborted mid-flight; cancellation is UI-level and
  checked after the upload returns.

## Fresh

`/fresh` resets provider-facing session state and keeps the transcript. It runs in the TUI and in text mode (headless, ACP). `AgentSession.freshSession()`:

1. Returns `undefined` while streaming. The TUI warns `Wait for the current response to finish or abort it before refreshing provider state.`; text mode prints the same line.
2. Closes every provider session (`closeAll("fresh session")`), mints a new provider session id, and routes the agent under it.
3. Rekeys memory and invalidates the append-only context, so the next request rebuilds its prefix.
4. Returns the previous and new ids and the number of provider states closed. The TUI shows `Fresh provider session started (N provider states pruned).`

The session file, header and entries are unchanged. A later `/fork` or session switch drops the fresh id.

## Fork

Interactive `/fork` creates a new session from the current one and switches the active session identity.

### Preconditions and immediate guards

- If the agent is streaming, `/fork` is rejected with `Wait for the current response to finish or abort it before forking.`
- UI status/loading indicators are cleared before operation.

### Session-level flow

`AgentSession.fork()` delegates to `SessionSwitch.fork` (`session/runtime/session-switch.ts`), which:

1. Emits `session_before_switch` with `reason: "fork"` (cancellable).
2. Flushes pending writes.
3. Calls `SessionManager.fork()`.
4. Copies artifacts directory from old session namespace to new namespace (best-effort; non-ENOENT copy failures are logged, not fatal).
5. Drops any `/fresh` provider id, routes the agent under the new session id, and inherits the new header's provider prompt-cache key unless an explicit key is already pinned. Memory is rekeyed and the memory context is reset for the new transcript.
6. Emits `session_switch` with `reason: "fork"`.

`SessionManager.fork()` behavior:

- Requires persistent mode and existing session file.
- Creates new session id and new JSONL file path.
- Rewrites header with:
  - new `id`
  - new timestamp
  - `cwd` unchanged
  - `parentSession` set to previous session id
  - `providerPromptCacheKey` set to the previous header's inherited key, or the previous session id when none was pinned
- Keeps conversation/history entries in the new file, but removes source-incarnation `session_lifecycle` and `session_checkpoint` telemetry before starting a fresh lifecycle interval when instrumentation permits it.

### Non-persistent behavior

- In-memory session manager returns `undefined` from `fork()`.
- `AgentSession.fork()` returns `false`.
- UI reports `Fork failed (session not persisted or cancelled)`.

### CLI `--fork <id|path>`

Startup `--fork` is resolved before normal session creation:

1. `--fork` with `--no-session` fails with `Error: --fork requires session persistence`.
2. Values that name a session file (`/`, `\`, or a session file name) call `SessionManager.forkFrom(path, cwd, sessionDir)`.
3. Other values resolve via `resolveResumableSession(...)`: local sessions first; then, when `sessionDir` is not forced, every session under the profile's sessions root (agent transcripts included); then other profiles. Matching accepts lowercased session id prefixes, full JSONL filename prefixes, and timestamp-stripped filename id suffixes. No match fails with `Error: Session "<id>" not found.` plus a hint to run `veyyon --resume` without an argument.
   Before any of this, an unpinned launch activates the profile that owns the source (`cli/resume-profile.ts`), so the fork is written under that profile.
4. The forked file is created in the current cwd/session-dir scope and becomes the active session manager for startup.
5. Full-context forks automatically seed `providerPromptCacheKey` from the source header's inherited key, falling back to the source session id. Startup drops that automatic inheritance when `--model`, `--thinking`, `--system-prompt`, `--append-system-prompt`, `--tools`, or `--no-tools` is given, or a `--models` scope selects the start model, since each changes the provider route or prompt/tool shape.
6. As with an interactive fork, source `session_lifecycle` and `session_checkpoint` entries stay with the source. The startup fork begins fresh lifecycle telemetry when enabled.

Use `--prompt-cache-key <key>` to pin the provider prompt-cache identity explicitly and independently from both the Veyyon session id and `--provider-session-id`. `--provider-session-id` continues to control provider session/routing headers and sticky credential selection; `--prompt-cache-key` controls the OpenAI Responses `prompt_cache_key` payload where supported.

## Resume and continue

## Interactive `/resume [id]`

Flow without an argument:

1. Opens the session selector in current-folder scope, populated via `SessionManager.list(currentCwd, currentSessionDir)`.
2. On selection, `SessionFlows.handleResumeSession(sessionPath)` (`modes/terminal/controllers/session-flows.ts`) runs. A session that `/new` left running in the background is reattached as a live object rather than replayed from its file, and reports `Resumed a session that is still running` while it streams. Any other session goes through `session.switchSession(sessionPath)`.
3. UI clears/rebuilds chat and todos, then reports `Resumed session` (or `Resumed session in <dir>` when the resumed session belongs to another project, in which case the process cwd and cwd-derived caches are re-pointed via `applyCwdChange`).

With an argument, `/resume <id>` resolves the id through `resolveResumableSession(..., { allowGlobalFallback: true })`, so a forced session directory still falls back to the global root. No match shows `Session "<id>" not found`. A match in another profile relaunches the process in that profile with `--resume <id>` (as `/profile` does) instead of switching in place; `switchSession` itself throws on another profile's file. Any other match runs the flow from step 2.

Notes:

- The picker always starts in current-folder scope, even when that list is empty.
- Tab toggles to all-projects scope, lazily loading `SessionManager.listAll()` on the first toggle and caching it afterwards.

## CLI `--resume`

### `--resume` (no value)

- `main.ts` lists sessions for the current cwd/sessionDir and opens the picker in current-folder scope. If that list is empty, it can preload `SessionManager.listAll()` to detect a globally empty state and make the first Tab instant, but it does not switch the initial scope. `No sessions found` is printed only when the global list is also empty.
- Selected path is opened with `SessionManager.open(selectedPath)` before session creation. Selecting a session from another project first switches the process into that project's directory and reloads cwd-scoped settings/caches.

### `--resume <value>`

`createSessionManager()` resolution order:

1. If the value names a session file (`/`, `\`, or a session file name), open it directly. A file inside another profile's sessions directory is forked into the active profile instead (see below).
2. Else `resolveResumableSession(...)` searches:
   - current scope (`SessionManager.list(cwd, sessionDir)`)
   - every session under the profile's sessions root, agent transcripts included, only when no explicit `sessionDir` was provided
   - other profiles' sessions roots
3. Matching accepts case-insensitive session id prefixes, full JSONL filename prefixes, and the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.
4. No match fails with `Error: Session "<id>" not found.` and a hint to run `veyyon --resume` without an argument.

An unpinned launch activates the profile that owns the id before any of this (`cli/resume-profile.ts`), so the match is normally in the active profile.

Cross-project id match behavior:

- **Another profile** (reached only when the launch pinned a profile): `SessionManager.forkFrom` creates a new session in the pinned profile whose history is the source's, at the session's recorded directory when it exists and the launch directory otherwise, and prints `Session <id> belongs to profile "<owner>"; forked into profile "<active>" as <new id>.` The source file is untouched.
- **Recorded directory gone (moved/renamed, e.g. `git worktree move`)**: CLI asks `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`.
  - On yes (default): `SessionManager.open(match.path, ..., { initialCwd: <recorded cwd> })` then `manager.moveTo(cwd)` re-roots the existing session into the current directory (no duplicate file).
  - On no: startup prints `Resume cancelled: the session's directory no longer exists.` and exits 0. On non-TTY: startup fails with `Error: Session "<id>" belongs to a directory that no longer exists (...); run interactively to move it into the current project.`
- **Recorded directory still exists (another project)**: the session opens in place, with no prompt. Before the session is built, startup switches the process into the recorded directory and reloads cwd-scoped settings, plugin roots and capabilities (`enterResumedSessionProject`). An explicit `--cwd` instead re-roots the session at the launch directory and records a `cwd_changed` entry.

## CLI `--continue`

### Explicit UUID compatibility form

When the sole positional value immediately after `--continue` or `-c` is UUID-shaped, `main.ts` removes it from initial prompt messages, normalizes it to `resume=<id>`, and resolves it with the explicit resume behavior above. A non-UUID positional value remains an initial prompt and bare-continue behavior still applies.

### Bare `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`:

1. Resolves session dir for current cwd.
2. Reads the terminal-scoped breadcrumb. A breadcrumb naming another profile's transcript is ignored, and one naming an agent's transcript resolves to its interactive root session.
3. If the breadcrumb points at a session recorded under a different cwd whose directory is absent (moved/renamed) **and** the current directory has no sessions of its own, re-roots that session into the current directory via `moveTo` instead of starting fresh. A directory that exists but cannot be read is not treated as absent.
4. Otherwise, if the breadcrumb's cwd matches the current cwd, uses the breadcrumb session; else falls back to the most recently modified session file.
5. Opens the found session; if none exists, creates a new session.

The `autoResume` setting runs the same `continueRecent` on a launch with no session flags.

This is startup-only behavior; there is no interactive `/continue` slash command.

## How session switching actually mutates runtime state

`AgentSession.switchSession(sessionPath)` delegates to `SessionSwitch.switchTo` (`session/runtime/session-switch.ts`), which runs after every scope transition already started:

1. Throw when `sessionPath` is another profile's transcript; the message names the `--resume` command that continues it in that profile and the `--profile ... --resume` command that forks it into this one.
2. Emit `session_before_switch` with `reason: "resume"` and `targetSessionFile` (cancellable; returns `false`).
3. With agent events detached: abort in-flight work and flush current session manager writes.
4. Capture rollback state: session manager state, agent messages, queued steering/follow-up messages, session fields, model, thinking selector, MCP selections, tools, system prompt, provider session id and prompt-cache keys, checkpoint state, and path roots.
5. Clear queued steering/follow-up/next-turn messages.
6. `sessionManager.setSessionFile(sessionPath)`, then adopt the recorded cwd when it is reachable. When the cwd changes, the cwd-scoped runtime is rescoped to it.
7. When switching files, drop the fresh provider id and the inherited prompt-cache key, then adopt the target header's key. In every case, route the agent under the session id and rekey memory.
8. Build session context from loaded entries, restore MCP selections/tools for the target session, and rehydrate checkpoints.
9. Emit `session_switch` with `reason: "resume"`.
10. Replace agent messages from context and sync todos.
11. Close provider sessions when switching files, or when same-file reload changed replay messages.
12. Restore the newest recorded model still available in the registry.
13. Append a terminal assistant record when the transcript's last process exit left its turn open.
14. Restore or initialize the thinking selector and service tier.
15. When switching files: reset the memory context and end the previous conversation.
16. Reattach agent events, then run the registered session-switch reconciler, if any (interactive mode registers `#reconcileModeFromSession()` via `setSessionSwitchReconciler` to re-enter persisted modes such as plan); reconciler errors are logged, not fatal.

If any step from 6 through 15 fails, `switchSession()` restores the captured state, including the cwd-scoped runtime, and rethrows. A failure to restore the scope or the MCP selections joins the original error in an `AggregateError`.

No new session file is created by `switchSession()` itself.

## Where session files live after a cwd move

`SessionManager.moveTo(newCwd, targetSessionDir?)` changes the session cwd and,
usually, relocates the session file and its artifacts. Where they land is
decided in this order.

1. An explicit `targetSessionDir` wins. The caller asked for a specific
   destination and gets it.
2. A **pinned** directory stays put. A directory is pinned when the caller
   passed an explicit `sessionDir` to `create`, `forkFrom`, `open`, or
   `continueRecent`. That is a statement about where this session's files go,
   and changing directory does not revoke it.
3. Anything else is derived storage and follows the cwd:
   - a directory inside a sessions root (its basename is the encoded cwd) is
     re-derived under that same root, so the session lands beside its siblings;
   - a session opened from an arbitrary file path re-roots into the default
     directory for the new cwd. This is what lets `--resume` adopt a session
     whose project directory was moved or renamed.

The pin is recorded at construction, not inferred from the path. An earlier
version guessed at it by checking whether the directory's basename was the
encoded cwd, which cannot tell case 2 from case 3, and the two want opposite
things. Pinned directories lost that coin flip: their sessions were redirected
to the global sessions root with nothing logged, which is how an SDK test ended
up writing into a real profile directory.

Loading a session file whose recorded cwd differs from the manager's cwd and
still exists clears the pin: the manager adopts that cwd and the file's own
directory (`setSessionFile`, the path `/resume` takes). `open` with an explicit
`sessionDir` keeps the pin, because it constructs the manager at the recorded
cwd.

## Event emissions and cancellation points

### Switch/fork lifecycle hooks

For `newSession`, `fork`, and `switchSession`:

- Before event: `session_before_switch`
  - reasons: `new`, `fork`, `resume`
  - cancellable by returning `{ cancel: true }`
- After event: `session_switch`
  - same reason set
  - includes `previousSessionFile`

`ExtensionRunner.emit()` returns early on the first cancelling before-event result.

### Custom tool `onSession` behavior

SDK bridges extension session events to custom tool `onSession` callbacks:

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

The same bridge forwards auto-compaction and auto-retry events under their own reasons.

These callbacks are observational; they do not cancel switch/fork.

### Other cancellation surfaces relevant to this doc

- `/fork` is blocked while streaming (user must wait/abort current response first).
- `/resume` selector can be cancelled by user closing selector.
- Cross-project `--resume <id>` whose recorded directory is gone can be cancelled by declining the move prompt.
- `/share` has a UI abort path (`Share cancelled`); the upload itself is not killed mid-flight.

## Non-persistent (in-memory) session behavior

When session manager is created with `SessionManager.inMemory()` (`--no-session`):

- Session file path is absent.
- `/export` fails with `Cannot export in-memory session to HTML` (propagated to command error UI). The default `/share` still works: the snapshot is built from live entries. A custom share script fails, since it receives an HTML export.
- `/fork` fails because `SessionManager.fork()` requires persistence.
- `/dump` still works because it serializes in-memory agent state.
- CLI resume/continue semantics are bypassed if `--no-session` is set, because manager creation returns in-memory immediately.

## Known implementation caveats (as of current code)

- `SessionFlows.handleResumeSession()` does not check the boolean result from `session.switchSession(...)`; a hook-cancelled switch still proceeds through the UI "Resumed session" repaint/status path.
- `/share` custom-share failures do not degrade to the default encrypted share flow; they terminate the command with `Custom share failed: ...`.

*Verified against `980793ac4160be113a4855f3b052a629d16f4b62` on 2026-10-27.*
