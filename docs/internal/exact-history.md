# Exact session evidence

The concise `history://<agent>` transcript is an overview. The optional search and
entry modes read stored records without whitespace normalization or tool-call
replay:

```text
history://Scout?q=deployment%20error
history://Scout?entry=entry-id&limit=8000
```

Search returns bounded newest-first matches on the selected branch, including an
entry ID and a revision for each match. An exact page returns the session, selected
leaf, entry ID, revision, total code-point length and next offset. Revisions bind
the stored text to its source, session and selected branch leaf. They identify the
record read, not a claim that historic pruning never happened.

## Caller-bound archived reads (explicit per-read opt-in)

Multi-conversation archived retrieval is available only through an explicit
`archived=1` query on that individual read:

```text
history://?archived=1&limit=50
history://?archived=1&offset=50&limit=50&revision=<returned-sha256>
history://Scout?archived=1&entry=entry-id&limit=8000
history://Scout?archived=1&q=deployment%20error
```

The trusted `read` tool mints a process-local opaque capability from its actual
`ToolSession` and exact owning `AgentSession`. The ToolSession's captured owner
must be the same object as the registry actor's current session; matching stable
agent/session IDs alone is insufficient. A stale ToolSession retained across
same-transcript revival cannot mint fresh authority for the replacement actor.
The capability is accepted only while the exact actor remains live, not disposing,
and non-advisor in the same global registry, and it has a nonempty attributed
root conversation scope. URL-supplied `actor`, `scope`, `session`, path or other
identity claims are not authority and are rejected.

A target must be an exact-scope-equal registered `parked` or `aborted` ref,
with `session === null` and a retained `sessionFile`. Exact reads and search use
the existing read-only scanners and retain their 12,000-code-point page,
128 MiB/100,000-entry scan, and 500-snippet bounds. The archived mode does not
expose the concise full-transcript overview. Its index lists same-scope parked
refs only; it never enumerates disk-only names. The index is limited to 100,000 refs, 100 entries and 24,000 UTF-8 bytes per page; each page carries a SHA-256 roster revision and continuation offset. A changed roster invalidates the old cursor and requires a fresh offset-zero read. IDs over 1 KiB fail closed rather than expanding the response. Unknown, foreign, live, advisor,
unscoped, or unregistered disk-only targets fail with the same unavailable
diagnostic. A case-folded alias is refused when more than one registered
identity matches; an exact ID in the caller's scope remains usable.

The index iterates the registry without copying the full roster.
It refuses the first eligible ref beyond 100,000 before sorting or hashing the collected refs.

This is a per-read capability, not a settings change or default. Ordinary
`history://` behavior and its multi-conversation refusal remain unchanged, as
do context-free completions when multiple scopes survive. The separate #780
task-record extension and its `task-record-context=false` default are
unchanged; this route does not activate compaction context, archive before
rewrite, prune history, restart a session, or change host/provider state.

## Following a page

Every subsequent page must repeat the returned `leaf` and `revision` along with
`entry`, `offset` and `limit`. A new offset without those pins is rejected. The
caller must restart from offset zero on `stale`; joining a fragment from before a
rewrite with one from after it can otherwise manufacture evidence that never
existed. A search match's revision can also pin the first exact read.

```text
history://Scout?entry=entry-id&leaf=leaf-id&revision=<returned-sha256>&offset=8000&limit=8000
```

A running agent's default leaf comes from its active session manager, including
after navigating to an earlier branch. A parked session defaults to the last
stored entry only when every record needed for branch selection was readable.
After a malformed or oversized record, an implicit branch read/search is unavailable;
an explicit leaf is required to select archived evidence. Supplying an explicit leaf
selects that branch in either case. Appending later records does not invalidate a
page pinned to the earlier leaf; changing the selected record does.

Oversized JSONL lines are discarded incrementally before their full text is
allocated. A scan reads at most 128 MiB and indexes at most 100,000 entries and reports partial/unavailable
coverage on that bound; it retains at most 500 search snippets. A missing or
unreadable file reports `unavailable`, distinct from a searched entry with no match.

Reads are read-only, bounded to 12,000 Unicode code points per page, and retain
stored wording. An exact stored record may still contain external blob references
or historic prune markers. Missing and unavailable evidence are not recovered by
guessing or by searching another conversation. Ordinary reads retain the existing concurrent-conversation scope refusal; the separate caller-bound archived mode above requires explicit per-read opt-in. Neither route changes default compaction behavior.

## Verification

`history-pages-keep-their-record-revision.test.ts` exercises rewritten records,
unrelated appends, branch navigation and invalid continuation requests through the
reader and protocol. Run with the repository's sandbox/remote test runner. Real
ACP/provider continuity and host measurements remain separate qualification work
under issue #774.
