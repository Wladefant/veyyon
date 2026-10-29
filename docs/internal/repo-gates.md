# Repository gates: why each one runs where it runs

The gates themselves are listed in [`AGENTS.md`](../../AGENTS.md). This page records the job layout
and the measurements behind it, so a change to a workflow starts from the numbers rather than from
taste.

## The two public workflows

`checks.yml` is the fast gate on every push to `main` and every PR. It runs on GitHub-hosted runners
and covers workspace type checking and linting, Rust formatting and clippy, secret scanning of the
commits the change adds, changelog coherence, and the repo script gates.

`ci.yml` is the build and runtime gate on `main`, PRs and release dispatches, entirely on
GitHub-hosted runners (`ubuntu-22.04`, `macos-14`, `windows-latest`, and the OS matrix — no self-hosted dependency). It
compiles the product and native addons, runs the full test matrix and the global-state isolation
check of changed suites, and exercises the installers and CLI runtime. Pushed as a `v*` tag it also builds the per-platform binaries, verifies their
SHA-256 sidecars and runtime smoke tests, publishes the GitHub release, and redeploys
`veyyon.dev/changelog`. That is the whole published surface.

The seven TypeScript test buckets belong to `ci.yml` alone. `checks.yml` does not fire on a release
tag, so `ci.yml` has to be self-sufficient anyway, and running the workspace bucket in both meant
every push paid for it twice against a roughly 20-job account ceiling.

## The Rust gate lives in `checks.yml`

`cargo fmt --all -- --check` answers in seconds. It used to run only inside `ci.yml`'s native matrix,
behind an artifact lookup, a toolchain install and a runner queue: a rewrapped doc comment turned
`main` red about 70 minutes into a run and skipped all seven TypeScript test jobs behind it. Do not
add a second copy to a native job.

## The leak check of changed suites runs in `ci.yml`

`scripts/test-sandbox/find-test-leaks.ts` needs the native addon, because a suite that cannot load
gives no leak verdict. In `checks.yml` the job compiled the addon from scratch on every push: run
40613633477 spent 306 s of the job's 6.3 minutes on that build and one second on the check, the
longest job in that workflow. In `ci.yml` the `test_leaks` job takes the addon through
`ts-test-env`, from the run's own build or the cached artifact `native_artifact_lookup` found.

## A per-push cost must buy a per-push answer

The installer end-to-end jobs — `install_methods` on three POSIX runners and `install_ps1_e2e` on
Windows — build the product from source to prove a release artifact installs. They run on pull
requests and on the release tag, are skipped on an ordinary push to `main` where nothing publishes,
and still gate `release_binary`.

The two monitors of the release already published (`install_binary_posix`, `install_ps1_binary`) left
`ci.yml` entirely and run once a day from `published-release-monitor.yml`, which no push or pull
request can reach. One `main` run spent 635 minutes of queue wait against 82 minutes of execution,
because the account's five concurrent macOS slots were being spent four at a time on questions about
an artifact the commit had not changed. `scripts/install-methods-coverage.test.ts` fails if a monitor
comes back onto the push path.

## The coding-agent buckets run their chunks side by side

The coding-agent UI, runtime and native buckets share one runner job. Each bucket is split into
chunks of 5 or 10 files, and each chunk is its own `bun test` process. `ciChunksAtOnce` in
`codingAgentBucketPlans` (`scripts/ci-test-ts.ts`) sets how many chunk processes of one bucket CI
runs side by side: two for the UI bucket, three for the runtime and native buckets, one for the
singleton bucket.
Run 40581477474 spent 10.9 minutes on the native bucket and 4.3 on the runtime bucket, one chunk
at a time, in the longest job of the run. The UI bucket took 128 s one chunk at a time and 66 s two
at a time on four pinned CPUs, with the sum of its chunk times up 5%; at three the sum rose 33%,
which is contention a frame-timed suite should not run under. On two physical cores (four threads),
the runtime bucket took 67-72 s at two, 56 s at three and 53 s at four, and the native bucket 151 s
at two and 118 s at three with a 1.56 GB peak. In run 40827326956 the bucket job was the longest of
the run at 507 s, 221 s of it the native bucket and 106 s the runtime bucket, both at two. The width
multiplies the job's peak RSS, never one process's.
`scripts/no-coding-agent-bucket-runs-as-one-process.test.ts` fails when a mode that reaches the
singleton bucket runs more than one chunk at a time.

## Why the changelog gate is push-based

`bun run changelog:check` runs on the direct-to-main push (base: the branch tip before the push) as
well as on PRs, because changes land directly on `main` here. A PR-only gate would never fire and
shipped source would reach releases undocumented. The gate is what makes a release safe to cut at any
time: a change cannot land without reaching the changelog.

A publishable package with no `CHANGELOG.md` used to be skipped, so its source shipped with nothing
checking it, and two packages sat that way for several releases. The gate now fails and names the
file to create.

## Why there is no changelog escape hatch

`[skip changelog]` used to waive a change, and a bare marker waived the entire push, so one throwaway
housekeeping commit switched the gate off for every package beside it. The scoped spelling failed
differently: it was easier to type than a sentence, so it became the standing answer to "this is only
a refactor", and thousands of commits reached releases with a changelog that does not describe them.

## Why root changelog entries are refused

The repo-root `CHANGELOG.md` is generated by `bun run changelog:root` from every package changelog. It
is the file a reader opens first and it reads as hand-written, which is why entries kept being written
there; 23 entries across several packages were written into it and would have been deleted by the next
render. The write path now refuses when the root holds an unreleased entry the render does not
produce, and names each one.

## The handbook is generated at build time, not committed

`docs/handbook/book` is gitignored build output. The `Docs` workflow builds the handbook with pinned
mdbook v0.5.2, verifies search assets and links, and checks source contracts against the generated
HTML. The `Site` workflow builds the handbook before deploying to Cloudflare Pages.

The mdbook version is pinned to v0.5.2. A different version renders content-hashed filenames
differently, so CI and local builds use the same pinned version.
*Verified against `fb7537bc9` on 2026-10-28.*
