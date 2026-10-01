# Upstream and fork credits

Veyyon is a source fork of **oh-my-pi** (`can1357/oh-my-pi`), MIT licensed.

```
Veyyon     https://github.com/santhreal/veyyon.git
oh-my-pi   https://github.com/can1357/oh-my-pi.git
```

## Where the legal notices live

- `LICENSE` — Veyyon's license (MIT), which is also the license under which
  oh-my-pi's incorporated MIT code is used.
- `NOTICE` — third-party attribution for code vendored or adapted under
  licenses other than plain MIT-via-`LICENSE` (Apache-2.0 wire types,
  Apache-2.0 generated bundles), plus pointers to crate-level notices.
- `natives/shell/NOTICE` — crate-scoped attribution for an adapted
  algorithm (RTK, MIT), next to the code it describes.
- `natives/vendor/*/LICENSE` — per-crate upstream license files for vendored
  Rust dependencies, authoritative for that code.
- `docs/handbook/src/acknowledgements.md` — the credits page for handbook
  readers.

What was forked, what diverged since, the port pipeline, and how to review a
candidate port: [porting guide](docs/internal/porting-from-pi-mono.md).

## Keeping Wladefant/veyyon current

This fork of santhreal/veyyon has two upstreams, in a line:

```
oh-my-pi (can1357/oh-my-pi) --snapshot 79faf94f2651--> santhreal/veyyon --git history--> Wladefant/veyyon
```

santhreal's root commit `6dbf3350c2e8` imported one oh-my-pi tree and renamed it, so git shares
history with santhreal and none with oh-my-pi. The fork gets santhreal by merging it; oh-my-pi
commits arrive only as ports, matched by the SHA a port cites or by their added lines.

```sh
git remote add upstream https://github.com/santhreal/veyyon.git   # once
git remote add omp https://github.com/can1357/oh-my-pi.git         # once
git fetch upstream && git fetch omp --no-tags                      # the first omp fetch takes minutes
bun run upstream:status                                            # a few minutes: it diffs every omp commit
```

`scripts/upstream-status.ts` prints the santhreal gap, how many oh-my-pi commits since the snapshot
each carrier already has (`cited-*` by a SHA or pull request a message or fork PR names, `content-*`
by 70% of added lines), and the missing follow-ups: oh-my-pi commits that rewrite a line of a commit
already carried. `--format tsv` lists every commit with its class for triage.

The order, every time:

1. **Merge santhreal first**, as its own pull request: `git merge --no-ff upstream/main`. santhreal
   ports oh-my-pi itself, so everything it carries stops being a candidate. A sync or conflict-only
   merge gets no review; it merges on green checks.
2. **Port the missing follow-ups** of commits already carried, before anything new. A port without
   its follow-up ships the defect upstream already fixed.
3. **Triage the rest** by area from the TSV: take as is, take with rework, or leave out with a reason.

A port pull request cites the oh-my-pi commit as `oh-my-pi <full sha>` in its body, so the next
status run counts it, and carries the follow-ups the report lists for that commit or says why not.
An automated review finding on the final head is answered in its thread, fixed or rejected with a
reason, before merge; a gate (size ratchet, spy ledger) is never raised to turn a port green.

### Automated

`bun run upstream:sync` does the bookkeeping of this order once a day and never ports anything. It
fetches both upstreams and, from the watermark kept on the `upstream-sync-data` branch
(`state.json`, plus the living backlog `omp-backlog.tsv`, seeded from
`docs/internal/upstream-sync/omp-gap-backlog-2026-09-30.tsv`):

- appends each new oh-my-pi commit the fork lacks to the backlog with a mechanical first-pass verdict
  (confidence `low`, policy in `scripts/upstream-port-policy.json`) and comments one digest on
  [#107](https://github.com/Wladefant/veyyon/issues/107);
- when santhreal is ahead and the merge is conflict-free, pushes `sync/santhreal-<tip>` as a real
  merge commit and opens the sync pull request. A conflicting merge is only reported.

It is dry-run by default (`--live` posts and pushes), never pushes to an upstream remote, never
merges, and a rerun adds and posts nothing twice. The watermark moves only after the digest is out.
A scheduled task runs it daily on the operator's workstation.

