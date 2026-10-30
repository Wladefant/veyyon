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
stored entry because no live branch selection exists. Supplying an explicit leaf
selects that branch in either case. Appending later records does not invalidate a
page pinned to the earlier leaf; changing the selected record does.

Oversized JSONL lines are discarded incrementally before their full text is
allocated. A scan reads at most 128 MiB and indexes at most 100,000 entries and reports partial/unavailable
coverage on that bound; it retains at most 500 search snippets. A missing or
unreadable file reports `unavailable`, distinct from a searched entry with no match.

Reads are read-only, bounded to 12,000 Unicode code points per page, and retain
stored wording. An exact stored record may still contain external blob references
or historic prune markers. Missing and unavailable evidence are not recovered by
guessing or by searching another conversation. Concurrent conversations retain the
existing scope refusal. This route does not change default compaction behavior.

## Verification

`history-pages-keep-their-record-revision.test.ts` exercises rewritten records,
unrelated appends, branch navigation and invalid continuation requests through the
reader and protocol. Run with the repository's sandbox/remote test runner. Real
ACP/provider continuity and host measurements remain separate qualification work
under issue #774.
