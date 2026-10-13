# Veyyon Cloudflare CI

Workers Builds runs the TypeScript check and the existing sharded test buckets. It builds portable Linux x64 native addons and the Linux x64 production CLI. It runs the Rust checks and uploads an isolated health Worker version. It does not deploy the Veyyon application.

## Trigger configuration

`trigger.json` records the intended Workers Builds settings.

- The Git integration runs on all branches except `main` and watches all paths.
- Build command: `bash ci/cloudflare/lane-tests.sh`.
- Deploy command: `npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc`.

The Cloudflare account stores the build token and GitHub repository connection. The repository does not.

All Workers Builds CI for all repositories runs in Cloudflare account `a0d288d1c95470cd009cc6e0df7accb7`. The account carries the Enterprise startup credits. Do not create or use Workers Builds resources in account `259beca7f28fdcd483c1ff85104c21f4`.

Use the existing user-scoped token `Cloudflare API token - polysim-builds` with Workers Builds Configuration Edit and Workers Scripts Read permissions. It is stored in the US Shared collection. Do not mint another user token. Keep its working copy outside git and do not print its value.

The rollout tracker manages GitHub app connections and Workers Builds triggers. Do not create a second connection or trigger.

## Build behavior

The lane reads the pinned Bun version from the root `package.json`. It installs that version only when needed. It then installs dependencies from the frozen lockfile. It runs `bun run check:ts` before tests.

The lane installs missing Linux test dependencies through `sudo -n` only when passwordless sudo works. If sudo is not available, the lane reports the limit and continues. Native compiler and test failures remain fatal.

The lane installs the Rust nightly pinned by `rust-toolchain.toml`, Zig `0.16.0`, and `cargo-zigbuild`. It builds Linux x64 native addons in both `baseline` and `modern` variants against `x86_64-unknown-linux-gnu.2.17`. This matches the release workflow's glibc floor.

The lane disables the external SSH rung and pins `VEYYON_SANDBOX_RUNG=bwrap`. It downloads and unpacks Bubblewrap and its test tools into a temporary directory when the Workers Builds image lacks them. It sets `VEYYON_SANDBOX_REPO_ROOT` to a short-lived checkout alias under `/var/tmp`, not `/tmp`. The bwrap rung binds the requested repository path verbatim; the alias stays outside both the hidden build user's home and the guest `/tmp` scanned by the test temp-directory janitor. The lane queries `pwd` inside the pinned bwrap rung and uses that mounted guest path.

The lane copies the actual Bun executable into `.cf-proof-tools/bin` inside the checkout. Each sandbox command adds the guest-visible path to the fixed sandbox PATH, then runs the existing bucket command. The wrapper also supplies that PATH to nested commands that resolve `bun` by name. The host PATH does not enter the sandbox.
The bwrap command wrapper sets `VEYYON_TEST_CONCURRENCY=2` inside the guest. The test runner defaults to one command in CI and honors this explicit override. It runs two existing package commands at once without changing the test file lists, test assertions, or per-command Bun parallelism.

This lane verifies only Linux x64. It does not build `linux-arm64`, `win32-x64`, `darwin-x64`, or `darwin-arm64`. The Windows and macOS native runner jobs were retired, and this lane makes no GitHub Actions coverage claim for those targets. Additional platform coverage, including the separately authorized Linux cross-build follow-up, remains outside this lane.

The Worker unit test runs with `CLOUDFLARE_API_TOKEN` unset. The lane preserves every existing TypeScript test bucket, shard, and assertion, except for the one named guest-memory exclusion below. Quiet output reports actual Bun test totals (`pass`, `fail`, `skip`, and `todo`) plus chunk totals as separate values. The excluded test is not counted as skipped and does not change the test source:

- `packages/utils/test/slice-extract-fuzz.test.ts` is excluded from this Cloudflare lane only. In the Workers guest, Bun aborted when this test requested a native allocation of `17,179,869,180` bytes. The test remains unchanged. This exclusion is a Linux/GitHub-runner parity gap; it does not establish coverage on another runner.

Configure three Workers Builds triggers or CI Workers with the same repository, branch filters, and build command. Set `VEYYON_CI_SHARD` to `1`, `2`, or `3` on each worker and set `VEYYON_CI_SHARDS=3` on all three. Each push then runs all shards against the same commit. The lane reads these build variables and passes the selected shard into bwrap. Keep the release trigger and its `VEYYON_RELEASE_*` variables separate.
The lane fails on missing or empty test summaries, a summary that disagrees with its JUnit reports, any failed test, any todo, any unlisted skip, or any stale allowlist entry for that shard. JUnit mode runs selected child chunks up to `VEYYON_TEST_CONCURRENCY` in parallel; this Cloudflare lane sets 2, while the runner defaults to 1. Every shard reports actual Bun totals (`pass`, `fail`, `skip`, and `todo`) plus child-command chunk totals separately. `ci/cloudflare/expected-skips.txt` is newline-delimited JSON. Each entry names the exact test file, qualified test name from JUnit (`classname > testcase.name`), source-visible gate class, reason, and shard. Qualified names distinguish suites that reuse a leaf name. `check-test-skips.py` prints every skipped case and compares exact identities. Unlisted skips and stale entries fail.
Allowed classes are `E2E`, `GATEWAY`, `LOCAL_SERVICE`, `PROVIDER_KEY`, `VERTEX`, and `WINDOWS`; source code must show the gate. Each skip entry includes its shard, and each build checks only that shard's entries. `check:rs`, the Linux CLI build, and Worker upload run once on shard 1. Shards 2 and 3 mark these gates as deferred. The full gate requires all three shard builds.
Cloudflare Workers Builds has a maximum build duration of 20 minutes, according to [Cloudflare's build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/). Keep each shard below 15 minutes, including setup, so the proof has time to complete.
The runner logs setup durations for dependency install and type-check, system dependencies, Rust/Zig tooling, native addon compilation, and bwrap bootstrap. It also logs each test bucket's elapsed seconds. Use these values to compare shard costs and find setup bottlenecks.
When Bun omits a testcase name or class for a skipped suite, the parser uses the suite name and class only when both are present and logs that fallback. A skipped case without a complete identity fails closed and cannot enter the allowlist.
`LOCAL_SERVICE` applies only when the test source checks for a local model service. Name the missing service in the allowlist reason.
The Cloudflare hashline shard sets `HASHLINE_SEED_SOAK=1` and runs the full corpus. Sampling tests select bounded mode and also run.

The existing TypeScript test map excludes `clients/python/veybot/web`, which belongs to the Python client and sits outside every Bun test bucket. This lane follows that existing exclusion and does not run `bun run test:py`.

Before any test bucket starts, the shared test runner removes `CLOUDFLARE_API_TOKEN` from each child process. The deployment credential is not available to test code.

The Worker responds with `ok` to health probes. A version upload does not activate or promote the version. It does not expose a public Worker URL or alter the application deployment path.
