# Task-record context pilot

Refs #774. This is an experimental, explicitly loaded extension. It is not registered in the
default extension set, and its `task-record-context` boolean flag defaults to `false`.
The policy replaces a local compaction summary with a small, operator-supplied task record
and a recovery reference. It does not start another execution session or call a model to
produce a summary. The normal compaction path still chooses the cut, keeps the recent tail,
commits the compaction entry, and rebuilds the active context.

## Run a controlled pilot

From a checkout containing this change:

```sh
bun packages/coding-agent/src/cli.ts \
  --extension ./packages/coding-agent/src/extensibility/extensions/task-record-context.ts \
  --task-record-context
```

After the user task has been recorded in a persisted session, capture schema-1 JSON using
`/context-record`. This command accepts JSON directly, not a filename. A complete example:

```text
/context-record {"version":1,"objective":"Verify the existing build result.","constraints":["Do not start the build again."],"facts":["The build was started before this record."],"completed":[{"id":"build-start-1","summary":"Started the build once.","evidence":["history://<session>/<entry>"]}],"pending":[],"nextActions":["Read the existing build result and verify the acceptance checks."]}
```

Replace example evidence references with real ones. When work is still running, include its
real ID, `kind` (`tool`, `job`, or `subagent`), and the current execution session's
`ownerSessionId` in `pending`. The extension validates ownership labels; it does not discover,
create, poll, transfer or authenticate those jobs. These records are pilot inputs supplied
by the operator or harness. No automatic task-state extraction is claimed.

Then use the ordinary `/compact` action or wait for the ordinary compaction trigger. A
successful pass gives the model structured JSON containing the task record, the task-record
entry ID, and a recovery object identifying the execution session, branch leaf, archive URL,
and SHA-256. The model-visible JSON applies the existing provider redaction transform to
strings before JSON escaping. The local archive keeps unmodified evidence, including media.

Use `/context-record off` to disable the policy for this execution session for the rest of
the current process. Capturing another record re-enables an explicitly flagged invocation.
Omitting `--task-record-context` or omitting the extension restores the ordinary path.
The flag's default is unchanged by a saved record or session resume.

## Conditions and refusal behavior

- The task record is at most 12 KiB of UTF-8 JSON. Field and list limits are enforced. Unknown
  fields, duplicate completed/pending action IDs, and foreign pending-work owners are rejected.
- The record is a custom entry on the current branch, bound to the execution session, its
  immediately preceding entry, and the latest user message. A sibling's state is not selected.
- A newer user message requires a refreshed record. Any newly discarded work after the record
  also requires a refresh; newer work that stays in the retained tail is preserved normally.
  A keep-nothing boundary is valid only when the record covers the entire discarded branch.
- The policy archives the exact branch entries before returning a replacement. Results already
  elided by preparation are reconstructed from their original messages in the preparation.
  The archive uses the recovery envelope `{version, operation, sessionId, branchLeafId, entries}`.
- The serialized archive must fit the 8 MiB pilot ceiling. It is intentionally conservative.
  Serialization and hashing scan the branch; the temporary serialization of a single existing
  entry is not a strict memory bound. No latency or memory improvement is claimed without
  measurement. Larger sessions remain outside this initial pilot.
- A missing archive ID/path, write failure, cancellation, timeout, branch change, same-leaf
  evidence rewrite, or changed session cancels this compaction attempt. The archive timeout
  is 10 seconds, before the extension runner's normal 30-second budget. A late successful
  write may leave an unused recovery artifact; it cannot return a context replacement.
- Provider models advertising native server compaction, preserved provider state, chained
  provider windows, an unknown model, and explicit summary instructions use the existing
  compaction path. The extension does not interpret or replace opaque provider state.
- An empty or invalid opted-in record cancels compaction with an operator notice. It is not
  silently treated as a successful task-state transition. Refresh the record or disable the
  pilot before continuing past the context limit.

The returned result preserves the normal `firstKeptEntryId` and `tokensBefore`. It never calls
session creation, session switching, abort, shutdown, worker steering or job scheduling APIs.
Existing in-flight work and pending-message ownership stay with the same session runtime.
This is a context policy; it is not a new runtime, scheduler or handoff mechanism.

## Recovery and qualification

The archive is stored by the existing SessionManager artifact store. `artifact://<id>` is
relative to the source execution session, and the recovery object explicitly identifies
that session and branch. Use it in that session. Cross-session lookup must use the scoped
artifact support in the other #774 recovery PRs; do not resolve a bare numeric ID in a
different session. Earlier pruning markers remain references to their earlier archives.
This policy does not claim to reconstruct evidence that was lost before it ran.

The regression target is:

```sh
bun test packages/coding-agent/test/session/task-record-context-policy.test.ts
```

It drives the real extension loader and runner, file-backed session persistence, context
rebuild and artifact storage. Cases cover the disabled/enabled paths, command capture/off,
exact result recovery after reload, owner and freshness checks, unknown fields and size
limits, multimodal tail recovery, concurrent history changes, cancellation, and storage
failures. The only injected failures are at the artifact storage boundary.
The runtime cases also drive the real `/context-record` command, `AgentSession.compact()`,
and a continuation prompt with the policy off and on. Only their provider transport is
stubbed. They verify the ordinary summary call off, no summary call on, exact archived
entries, execution-session identity and pending-owner data in the next provider request.
The pending job is supplied trace data, not a running job or ACP continuity proof.

Run the focused regression target through the repository's required kernel sandbox and
execution policy. These tests do not replace a live end-to-end demo. Keep the feature off
by default until exact-head checks and live qualification are complete.
The #774 A/B/C comparison must hold frozen task/trace/tools/provider inputs constant, test
running jobs and delayed results across the transition, and measure correctness, transition
time, first useful action, total task time, retrieval, cache state, CPU and memory. Superboard
#1790 supplies the receipt contract, not the measurements. No adoption decision is made here.
