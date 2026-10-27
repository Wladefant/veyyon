# Autonomous agent workflow: working the repo and shipping updates

How an autonomous coding agent works this codebase continuously and ships work.
The rules of the road live in [`AGENTS.md`](../../AGENTS.md).
Release and deploy mechanics live in [`releasing.md`](./releasing.md) and [`deployment.md`](./deployment.md).
This page describes the loop: queue → change → gate → ship → verify.

## The work queue

GitHub Issues are the **single task authority** (`AGENTS.md`).
Every task, feature, refactor, dependency update, and bug fix requires an issue first.
Settle scope on the issue before work exists:

- File or claim a GitHub issue before writing code.
- Record every finding on an issue immediately. That includes agent discoveries, test failures, and doc drift. A finding that lives only in chat context is lost work.
- `BACKLOG.md` at the repo root is an optional machine-local scratch note. Git ignores it, and it never serves as an authoritative task ledger or roadmap.
- There is one issue queue and one plan. Never keep a competing roadmap.

An agent starting a session reviews assigned or open GitHub issues, claims a task, and implements it.

## The change loop

1. **Read before editing.** Open the actual code. Never patch from a guess or a summary. Search definitions and duplicate candidates before adding any helper, constant, or list. If an owner exists, import it.
2. **Edit in batches.** Land a coherent unit (a refactor, a module, or a test suite), not one-line changes. Batch edits, then run gates.
3. **Gate.** Run the touched package's `check:types` script (`bun --cwd=packages/<name> run check:types`). Next run the targeted test slice, then the repo gate (`bun run check`). `bun run check` covers type checks, `cargo fmt --check`, and clippy. Run `bun run check:tools` to prevent formatting or import-order failures. Website changes pass the `bun run site:build` brand check. [testing.md](./testing.md) states how suites run. New behavior gets proving tests that assert real values. A failing contract test is a finding, never a test to weaken.
4. **Run long gates in the background.** Start builds and tests with background execution. Keep editing the next non-colliding unit. Reconcile results when the run finishes.
5. **Record.** Update the issue with progress or findings. Put user-visible changes under the affected package's `## [Unreleased]` changelog section as part of the same unit. The release flow finalizes entries in that section. An unrecorded change ships undocumented.

## Shared-tree discipline

Multiple agent sessions and humans work this repository concurrently.
Dirty files and unfinished edits belong to someone. Treat them as live work:

- **Short-lived feature branches.** Work happens on short-lived pushed feature branches that merge into `main` through a pull request (`AGENTS.md`). Never commit directly to `main` without explicit assignment. Use dedicated git worktrees branched from `origin/main` to keep sessions isolated.
- **Additive git only.** Stage exactly the paths you touched (`git add <paths>`, never `git add -A`). Never revert, hard-reset, clean, or discard edits you did not author in this session.
- **Lane splits.** If a surface belongs to another lane (such as TUI visuals), record findings on an issue for that owner.

## What ships autonomously vs. what needs the human

The boundary is **instruction authorization and safety policy**.
User instructions constitute approval for the actions they request (`AGENTS.md`).
Agents execute requested tasks without redundant per-action confirmation prompts.
Never act uninstructed: no unsolicited comments, issues, or reviews on external repositories.

| Autonomous / Instruction-approved | Operator-gated (explicit approval needed) |
| --- | --- |
| Reading, editing, and staging exact paths | Release cuts (`bun run release <bump>`), which require global policy approval |
| Local typechecks, tests, and builds | Production data, DDL, or database mutations |
| Creating feature branches, committing, and pushing for instructed work | Modifying secrets or Bitwarden vaults |
| Opening and updating pull requests (`Refs #N`) and issues when instructed | Unsolicited public repository issues, comments, or reviews |
| Updating changelog `[Unreleased]` sections | Direct third-party registry publication (npm, crates.io, Homebrew) |

When an instruction requests an action, that instruction is the approval.
Write the text, push the branch, or open the pull request, then report what was done.
Sensitive production changes remain gated on operator confirmation through Telegram.

## Shipping an update to production

Production has three coordinated surfaces (see [`deployment.md`](./deployment.md)):

**CLI binaries.** Keep `main` release-ready: `bun run check` green and each publishable change documented under its package's `[Unreleased]` section. A push publishes nothing on its own. Nothing cuts a release on its own: no green run and no waiting `[Unreleased]` entry produces a tag. Only a tag publishes. `ci.yml` refuses to publish unless that tag names a commit that reached `main`.

`bun run release:dry <bump>` writes nothing.
`bun run release <bump>` pushes `main` and cuts the tag.
Release approval belongs to the operator's global policy (`AGENTS.md`).
The interactive script prompt is only a terminal confirmation, not the approval.
The prompt fails without a TTY.
[`releasing.md`](./releasing.md) states what each half does.

**Website and install scripts.** Run `bun run site:build` locally at will because the brand check is part of the gate. A matching push to `main`, and every release, deploys both `veyyon.dev` and `get.veyyon.dev`. With approval, run both `bun run site:deploy` and `bun run site:deploy:get` for an out-of-band deployment. If handbook sources changed, run `mdbook build` in `docs/handbook` first.

## Verify like a user, not like a builder

Verify a release by the **shipped install path**, never a local `bun` or `cargo` artifact.
In a clean environment, uninstall any prior copy.
Run `curl -fsSL https://get.veyyon.dev | sh` (or `install.ps1`).
Exercise the installed binary, subcommands, output formats, and error paths.
Checksum verification, PATH wiring, and shell completions are product surfaces.
A dev build proves none of them.
File install-flow friction on an issue like any other bug.

## When something breaks

- Release failures: open the tagged `ci.yml` run in Actions. Recovery procedures live in [`docs/internal/runbooks/`](./runbooks/README.md).
- Roll a bad deploy or release forward with a fix and a new cut. Never force-push. Published tags and assets are immutable.
- Anything an agent cannot fix locally (expired credentials, runner outages, account-level platform state) is a blocker. Record what you tried on the issue. Report the blocker instead of stopping silently.

*Verified against `35071ec9a3b8211c8b5d3c5eb6ad0a12da3c8cee` on 2026-10-27.*
