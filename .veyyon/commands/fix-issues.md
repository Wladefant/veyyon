# Fix Issues Command

Diagnose, reproduce, and (when reproducible) fix open GitHub issues in parallel — each in its own clean worktree, with build artifacts symlinked so nothing recompiles.

## Arguments

- `$ARGUMENTS` — optional. Either:
  - a space- or comma-separated list of issue numbers / URLs, OR
  - GitHub-search qualifiers (`is:open`, `label:bug`, `author:foo`, ...) and/or a relative time window like `3d`, `2w`, `12h`.

If no issues and no flags are passed, default to **all open issues opened in the last 3 days**.

## Steps

### 1. Resolve the issue set

Parse `$ARGUMENTS`.

- If explicit issue numbers/URLs given, use them verbatim.
- Otherwise call the `github` tool with `op: search_issues`. Default (no args):

  ```
  github { op: "search_issues", query: "is:open", since: "3d", limit: 50 }
  ```

  Pass any user-supplied qualifiers verbatim through `query` (combine with `is:open` if not already present). Use `since` for the time window (`3d`, `2w`, `12h`, ISO date — see the `github` tool docs); set `dateField: "updated"` instead of the `created` default only when the user explicitly asks for recently-touched issues.

Print the resolved set before fanning out so the user can confirm scope.

### 2. Fan out one agent per issue

Use **`task` with parallel agents** — one task per issue. Pass the issue number, title, body summary, and the workflow below as the assignment. Agents work in isolation; coordinate via `irc` only when two issues clearly touch the same file.

Each agent **MUST** follow this exact workflow:

#### a. Read everything

1. Read `issue://<N>` (or `issue://<owner>/<repo>/<N>` for cross-repo) — fetches the issue body plus comments; comments often carry the real repro and fix hints. Append `?comments=0` only if you explicitly want to skip them.
2. `gh search prs` for the issue number to see if a fix is already in flight.
   - If a PR exists and looks reasonable → switch tracks: review that PR per `.veyyon/commands/review-prs.md` instead, and report back as `existing-pr`. Do **not** open a competing fix.

#### b. Diagnose & try to reproduce — **in the current cwd, on `main`**

Reproduce **here first**, before touching any worktree. The point is to confirm the bug is real on current main before investing in a fix branch.

1. Read the relevant source paths in this checkout. Form a concrete hypothesis (one or two sentences) about the failure.
2. Write a focused test file under the package the bug lives in. Naming: `repro-issue-<N>-<slug>.test.ts` (or `.rs`, etc.) — unique, greppable, deletable.
3. Run **only that test file**, not the suite. Confirm it fails for the reason in the issue.

Outcomes:
- **Reproduced** → continue to (c).
- **Not reproduced** → stop. Delete the test file. Report `unreproduced` with: hypothesis tried, evidence it doesn't fail, and what info would unblock (versions, OS, config, repro snippet from author). Do **not** create a worktree or commit.
- **Out of scope / not a bug** (e.g. user config error, intended behavior, dup) → stop. Report `not-a-bug` with the explanation suitable for posting to the issue.

#### c. Create a worktree off main

Only after a confirmed local repro:

```bash
MAIN="$(git rev-parse --show-toplevel)"
ENC="$(printf '%s' "$MAIN" | sed 's|[/\\:]|-|g')"
WT="$HOME/.veyyon/wt/${ENC}/fix-issue-<N>"

git -C "$MAIN" fetch origin main
git -C "$MAIN" worktree add -B "fix/issue-<N>" "$WT" origin/main
```

Branch naming: `fix/issue-<N>` (or `fix/issue-<N>-<slug>` if you'll open multiple). Path under `~/.veyyon/wt/<encoded-main-path>/...` matches the convention `pr_checkout` uses.

#### d. Link build artifacts safely (no MSYS deep-copy)

From the new worktree, link build outputs from `$MAIN` so `bun check` / `cargo build` / native loaders skip rebuilds.

**Safety rules:**
- On Windows (Git Bash / MSYS2), bare `ln -snf` silently deep-copies directories unless `MSYS=winsymlinks:nativestrict` is set. **NEVER** run unguarded `ln -snf` on Windows.
- **NEVER** run raw `rm -rf "$WT"` or unguarded recursive deletion on a worktree that contains true symlinks or NTFS junctions; tear down only through the canonical scoped removal engine (`veyyon worktree clear`) or unlink `target`, `node_modules`, and `*.node` links (`rmdir` for junctions, `rm -f` for symlinks) before `git worktree remove`.
- Keep `@veyyon/*` workspace links pointing inside `$WT` (not `$MAIN`), matching `.githooks/pre-push`'s `link_node_modules` overlay, so workspace imports never resolve stale code from `$MAIN`.

```bash
cd "$WT"
link_dir() {
  if [ -n "${MSYSTEM:-}" ] || [ "${OS:-}" = "Windows_NT" ]; then
    MSYS=winsymlinks:nativestrict ln -snf "$1" "$2" 2>/dev/null || \
      cmd //c mklink /J "$(cygpath -w "$2")" "$(cygpath -w "$1")" >/dev/null
  else
    ln -snf "$1" "$2"
  fi
}

link_dir "$MAIN/target" "$WT/target"

# Overlay node_modules so third-party packages are linked and @veyyon/* workspace
# members resolve inside $WT rather than leaking back to $MAIN.
mkdir -p "$WT/node_modules/@veyyon"
for entry in "$MAIN/node_modules"/* "$MAIN/node_modules"/.[!.]*; do
  [ -e "$entry" ] || continue
  name=${entry##*/}
  [ "$name" = "@veyyon" ] && continue
  if [ -d "$entry" ]; then
    link_dir "$entry" "$WT/node_modules/$name"
  elif [ -n "${MSYSTEM:-}" ] || [ "${OS:-}" = "Windows_NT" ]; then
    MSYS=winsymlinks:nativestrict ln -snf "$entry" "$WT/node_modules/$name" 2>/dev/null || ln -f "$entry" "$WT/node_modules/$name"
  else
    ln -snf "$entry" "$WT/node_modules/$name"
  fi
done
for pkg in "$MAIN"/packages/* "$MAIN"/contracts/* "$MAIN"/hosts/* "$MAIN"/plugins/*; do
  [ -f "$pkg/package.json" ] || continue
  name=$(basename "$pkg")
  rel=${pkg#"$MAIN"/}
  [ -d "$WT/$rel" ] && link_dir "$WT/$rel" "$WT/node_modules/@veyyon/$name"
done

# Only the .node binaries are expensive to rebuild. The rest of
# natives/bridge/bindings/native/ is tracked by git, so folder-level symlinks would
# shadow real source files and break the fix.
for f in "$MAIN"/natives/bridge/bindings/native/*.node; do
  [ -e "$f" ] || continue
  dst="$WT/natives/bridge/bindings/native/$(basename "$f")"
  if [ -n "${MSYSTEM:-}" ] || [ "${OS:-}" = "Windows_NT" ]; then
    MSYS=winsymlinks:nativestrict ln -snf "$f" "$dst" 2>/dev/null || ln -f "$f" "$dst"
  else
    ln -snf "$f" "$dst"
  fi
done
```

Use absolute paths — the worktree lives outside the main checkout.

#### e. Move the repro test in & fix

1. Move (don't copy) the failing test file from the main checkout into the same path inside the worktree. Delete it from main so the original cwd is left clean.
2. Confirm it still fails inside the worktree on the current branch.
3. Implement the fix in source. Match existing patterns (see `AGENTS.md`); fix at the source, not at the symptom; no stubs, no mocks added to product code.
4. Re-run the repro test until it passes.
5. Add or adjust adjacent unit/contract tests where the fix changes a real contract — not just plumbing. Run **only** the affected test files; no full-suite runs from agents.
6. Run `bun fmt` over the union of files edited.

#### f. Commit

Conventional commit, one logical change per commit, with `Fixes #<N>`:

```bash
git add -A
git commit -m "fix(<scope>): <one-line summary>

<short body explaining root cause and the fix>

Fixes #<N>."
```

Do **not** push. The human pushes / opens the PR.

#### g. Report back

Each agent returns a short structured report:

```
Issue #<N>  <title>
Status:    fixed | unreproduced | not-a-bug | existing-pr (#<M>)
Repro:     <test path inside worktree>            (if applicable)
Worktree:  ~/.veyyon/wt/.../fix-issue-<N>            (if created)
Branch:    fix/issue-<N>                          (if created)
Commits:   <shas + one-liners>                    (if any)
Notes:     <root cause in one sentence; or what info is missing>
```

### 3. Aggregate

After all agents finish, print a single summary table:

```
| # | Title | Status | Branch / Notes |
|---|-------|--------|----------------|
```

Group worktree paths by status (`fixed` first), so the user can `cd` and push the ready ones in one pass.

## Rules

- **MUST** reproduce on `main` in the current cwd **before** creating any worktree. No worktree until repro is confirmed.
- **MUST** use parallel agents — one per issue.
- **MUST** check for an existing PR first; if one exists and is reasonable, divert to `review-prs` flow instead of duplicating work.
- **MUST** link `target`, the `node_modules` overlay (with `@veyyon/*` pointing inside `$WT`), and the native `*.node` binaries using strict native links or NTFS junctions (never bare MSYS `ln -s`, which deep-copies). **MUST NOT** symlink the whole `natives/bridge/bindings/native/` directory that would shadow tracked source files, and **MUST NOT** tear down linked worktrees with raw `rm -rf` (use `veyyon worktree clear` or unlink links before `git worktree remove`).
- **MUST** use conventional commits with `Fixes #<N>` in the body.
- **MUST NOT** push, open PRs, or comment on issues. Human handles delivery.
- **MUST NOT** ship stubs, mocks-as-product-code, or "TODO: implement" placeholders as a fix.
- **MUST NOT** expand scope: fix the reported bug, not adjacent code smells.
- If repro fails, delete the temporary test file from cwd before yielding — leave the original checkout clean.
