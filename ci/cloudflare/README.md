# Veyyon Cloudflare CI

Workers Builds runs the TypeScript check and existing sharded test buckets. It builds portable Linux x64 native addons and the Linux x64 production CLI. It runs Rust checks and uploads isolated CI Worker versions. It does not deploy the Veyyon application.

## Trigger configuration

`trigger.json` records the intended Workers Builds settings.

- The Git integration runs on all branches except `main` and watches all paths.
- Build command: `bash ci/cloudflare/lane-tests.sh`.
- Deploy command: `npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc`.
- Shard 2 deploy command: `npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.shard-2.jsonc`.
- Shard 3 deploy command: `npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.shard-3.jsonc`.

The Cloudflare account stores the build token and GitHub repository connection. The repository does not.

All Workers Builds CI for all repositories runs in Cloudflare account `a0d288d1c95470cd009cc6e0df7accb7`. The account carries the Enterprise startup credits. Do not create or use Workers Builds resources in account `259beca7f28fdcd483c1ff85104c21f4`.

Use the existing user-scoped token `Cloudflare API token - polysim-builds` with Workers Builds Configuration Edit and Workers Scripts Read permissions. It is stored in the US Shared collection. Do not mint another user token. Keep its working copy outside git and do not print its value.

- The rollout tracker owns the GitHub app connection and the Workers Builds triggers. Use one repository connection. The three CI Workers each use one preview trigger. Only the protected shard-1 trigger carries the `VEYYON_RELEASE_*` variables.

## Build behavior

The lane reads the pinned Bun version from the root `package.json`. It installs that version only when needed. It then installs dependencies from the frozen lockfile. It runs `bun run check:ts` before tests.

The lane installs missing Linux test dependencies through `sudo -n` only when passwordless sudo works. If sudo is not available, the lane reports the limit and continues. Native compiler and test failures remain fatal.

The lane installs the Rust nightly pinned by `rust-toolchain.toml`, Zig `0.16.0`, and `cargo-zigbuild`. Each ordinary shard builds only its selected Linux x64 native addon variant against `x86_64-unknown-linux-gnu.2.17`: shard 2 builds `modern`, while shards 1 and 3 build `baseline`. This matches the release workflow's glibc floor.

### Shard variant mapping and source costs

Ordinary CI routes across three shards with deterministic variant and workload assignments:

- **Shard 1 (`baseline`)**: runs the health-worker suite, `packages/ai` (~76.8s), `packages/agent` (~70.6s), and `packages/utils` (~40.7s), plus the full `natives/bridge/bindings` suite in native mode.
- **Shard 2 (`modern`)**: runs `plugins/hashline` (~379s measured execution cost), plus the full `natives/bridge/bindings` suite in native mode.
- **Shard 3 (`baseline`)**: runs `tests/simulations` (~440.6s measured execution cost). Native binding suites are excluded on shard 3.

Allocating native binding tests to both shard 1 and shard 2 verifies that both `baseline` and `modern` native binaries pass all assertions. Each shard exports `VEYYON_NATIVE_VARIANT` and runs `ci/cloudflare/native-variant-proof.mjs` inside `bwrap` after bootstrap and before bucket execution. The proof dynamically imports `native/index.js`, calls `visibleWidth('abc', 4)`, asserts stdout `3`, requires the startup marker to match the canonical variant binary without modern fallback, and logs `CLOUDFLARE_NATIVE_LOADED variant=<...> sha256=<...>`.

### Native cache reader and writer

The R2 native cache separates cache reading from cache writing:

- **Cache reader (`ci/cloudflare/native-cache.mjs`)**: ordinary branch builds run in reader mode. The reader validates trusted R2 keys (`trusted/<hash>`), checks SHA256 checksums and file sizes against the remote manifest, and restores only the selected variant. On a cache miss, the reader logs the miss reason and performs a local cold build for the selected variant without uploading (`miss no write`).
- **Cache writer (`ci/cloudflare/native-cache-writer.sh`)**: runs strictly on the `main` branch after merge (`WORKERS_CI_BRANCH=main`). The writer performs a cold build of both `baseline` and `modern` variants, validates non-zero outputs, uploads validated `.node` binaries first with SHA256 checksums, and uploads `manifest.json` last.
- **Credential isolation**: secret cache credentials (`VEYYON_NATIVE_CACHE_CREDENTIALS` and `VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS`) are unset after cache restoration and before Bubblewrap bootstrap. Sandbox guests and test child processes never receive cache secrets.

The lane disables the external SSH rung and pins `VEYYON_SANDBOX_RUNG=bwrap`. It downloads and unpacks Bubblewrap and its test tools into a temporary directory when the Workers Builds image lacks them. It sets `VEYYON_SANDBOX_REPO_ROOT` to a short-lived checkout alias under `/var/tmp`, not `/tmp`. The bwrap rung binds the requested repository path verbatim; the alias stays outside both the hidden build user's home and the guest `/tmp` scanned by the test temp-directory janitor. The lane queries `pwd` inside the pinned bwrap rung and uses that mounted guest path.

The lane copies the actual Bun executable into `.cf-proof-tools/bin` inside the checkout. Each sandbox command adds the guest-visible path to the fixed sandbox PATH, then runs the existing bucket command. The wrapper also supplies that PATH to nested commands that resolve `bun` by name. The host PATH does not enter the sandbox.
The bwrap command wrapper sets `VEYYON_TEST_CONCURRENCY=2` inside the guest. The test runner defaults to one command in CI and honors this explicit override. It runs two existing package commands at once without changing the test file lists, test assertions, or per-command Bun parallelism.

This lane verifies only Linux x64. It does not build `linux-arm64`, `win32-x64`, `darwin-x64`, or `darwin-arm64`. The Windows and macOS native runner jobs were retired, and this lane makes no GitHub Actions coverage claim for those targets. Additional platform coverage, including the separately authorized Linux cross-build follow-up, remains outside this lane.

The Worker and ordinary branch tests run without `CLOUDFLARE_API_TOKEN` or any `VEYYON_RELEASE_*` value. The lane preserves every existing TypeScript test bucket, shard, and assertion, except for the one named guest-memory exclusion below. Quiet output reports actual Bun test totals (`pass`, `fail`, `skip`, and `todo`) plus chunk totals as separate values. The excluded test is not counted as skipped and does not change the test source:

- `packages/utils/test/slice-extract-fuzz.test.ts` is excluded from this Cloudflare lane only. In the Workers guest, Bun aborted when this test requested a native allocation of `17,179,869,180` bytes. The test remains unchanged. This exclusion is a Linux/GitHub-runner parity gap; it does not establish coverage on another runner.

Configure one preview trigger per Worker with the same repository, branch filters, and build command. `veyyon-ci-health` uses `wrangler.jsonc`; `veyyon-ci-shard-2` uses `wrangler.shard-2.jsonc`; and `veyyon-ci-shard-3` uses `wrangler.shard-3.jsonc`. Set `VEYYON_CI_SHARD` to `1`, `2`, or `3` on each worker and set `VEYYON_CI_SHARDS=3` on all three. Each push then runs all shards against the same commit. The lane passes the selected shard into bwrap.
The lane fails on missing or empty test summaries, a summary that disagrees with its JUnit reports, any failed test, any todo, any unlisted skip, or any stale allowlist entry for that shard. JUnit mode runs selected child chunks up to `VEYYON_TEST_CONCURRENCY` in parallel; this Cloudflare lane sets 2, while the runner defaults to 1. Every shard reports actual Bun totals (`pass`, `fail`, `skip`, and `todo`) plus child-command chunk totals separately. `ci/cloudflare/expected-skips.txt` is newline-delimited JSON. Each entry names the exact test file, qualified test name from JUnit (`classname > testcase.name`), source-visible gate class, reason, and shard. Qualified names distinguish suites that reuse a leaf name. `check-test-skips.py` prints every skipped case and compares exact identities. Unlisted skips and stale entries fail.
Allowed classes are `E2E`, `GATEWAY`, `LOCAL_SERVICE`, `PROVIDER_KEY`, `VERTEX`, and `WINDOWS`; source code must show the gate. Each skip entry includes its shard, and each build checks only that shard's entries. `check:rs` and the Linux CLI build run once on shard 1. Each successful Worker build uploads only its isolated CI Worker version through the Workers Builds deploy command. Shards 2 and 3 defer `check:rs` and the Linux CLI build. The full gate requires all three shard builds.
Cloudflare Workers Builds has a maximum build duration of 20 minutes, according to [Cloudflare's build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/). Keep each shard below 15 minutes, including setup, so the proof has time to complete.

Branches named `cf-release/*` use the release path instead of the normal CI shards. Shards 2 and 3 log `release branch: shard N skipped` and exit successfully. Shard 1 ignores test-shard selection and runs the matching `ci/cloudflare/release-linux.sh` mode when that file is present. If the release script is not in the checkout, shard 1 logs that the release path is unavailable and exits without running tests. The normal branch path unsets all known `VEYYON_RELEASE_*` variables before setup and tests. Normal branch builds never call the Veyyon release publisher. `wrangler versions upload` publishes only an isolated CI Worker version; it does not publish a Veyyon release or release asset.

The release-routing checks exercise two controls in the build log: a normal shard-1 success paired with a simulated shard-2 failure selects no release or asset upload, and a `cf-release/part-linux-x64` branch selects the unsplit release mode on shard 1 while shards 2 and 3 skip it.
The runner logs setup durations for dependency install and type-check, system dependencies, Rust/Zig tooling, native addon compilation, and bwrap bootstrap. It also logs each test bucket's elapsed seconds. Use these values to compare shard costs and find setup bottlenecks.
When Bun omits a testcase name or class for a skipped suite, the parser uses the suite name and class only when both are present and logs that fallback. A skipped case without a complete identity fails closed and cannot enter the allowlist.
`LOCAL_SERVICE` applies only when the test source checks for a local model service. Name the missing service in the allowlist reason.
The Cloudflare hashline shard sets `HASHLINE_SEED_SOAK=1` and runs the full corpus. Sampling tests select bounded mode and also run.

The existing TypeScript test map excludes `clients/python/veybot/web`, which belongs to the Python client and sits outside every Bun test bucket. This lane follows that existing exclusion and does not run `bun run test:py`.

Before each test bucket starts, the shared test runner removes `CLOUDFLARE_API_TOKEN` from each child process. The normal branch path also unsets the release variables before any dependency, build, or test command starts.

The Worker responds with `ok` to health probes. A version upload does not activate or promote the version. It does not expose a public Worker URL or alter the application deployment path.

## Shard receipt emission and partition adapter (Issue #589)

Veyyon implements shard-level `ci-receipt/v1` and `ci-manifest/v1` emission across all three Cloudflare Workers CI shards.

### Receipt emission (`ci/cloudflare/shard-receipt.mjs`)
- **Schema**: canonical `ci-receipt/v1` and `ci-manifest/v1`.
- **Counter contract**: `status="passed"` requires `executed > 0`, `passed > 0`, and `failed == 0` across all suites.
- **NO-RESULT**: suites with `executed == 0`, all skipped, xfail-only, unparseable summaries, or missing producer secrets yield explicit status `"incomplete"` (NO-RESULT), never `"passed"`.
- **Failure text fallback**: failed tests without reporter messages record `"message unavailable"`.
- **Producer transport**: uploads evidence via multipart/form-data with fields `receipt`, `manifest`, and binary artifacts.
- **HMAC signing**: signs payload using HMAC-SHA256 with key `EVIDENCE_PRODUCER_SECRET` over UTF-8 `${request_id}\n${expiry_epoch_ms}\n` concatenated with raw multipart body bytes.
- **Missing secret**: if `EVIDENCE_PRODUCER_SECRET` is unset, emits an explicit NO-RESULT receipt with `reason="missing_producer_secret"` and skips upload; never fakes PASS.
- **Aggregation**: aggregates receipts across all expected shards (1..3). Fails closed on missing shards (`REJECT_MISSING_SHARDS`), duplicate shards (`REJECT_DUPLICATE_SHARDS`), mismatched expected shard counts or candidate SHAs (`REJECT_MISMATCHED_SHARDS`), or untrusted pass claims (`REJECT_UNTRUSTED_CLAIMS`).

### Partition adapter (`ci/cloudflare/partition-adapter.mjs`)
- Partitions suites based strictly on observed execution costs from remote audit logs:
  - `plugins/hashline`: ~379.0s (Shard 2 modern)
  - `tests/simulations`: ~440.6s (Shard 3 baseline)
  - `packages/ai`: ~76.8s (Shard 1 baseline)
  - `packages/agent`: ~70.6s (Shard 1 baseline)
  - `packages/utils`: ~40.7s (Shard 1 baseline)
  - `natives/bridge/bindings`: ~25.0s (Shards 1 and 2)
  - `packages/catalog`: ~15.0s (Shard 1 baseline)
  - `health-worker`: ~4.5s (Shard 1 baseline)
- Runtime estimates are not invented. Timeout prevention is an expectation requiring remote proof on Cloudflare Workers Builds.

### Deterministic fixtures (`ci/cloudflare/fixtures/`)
- `shard-1-pass.json`, `shard-2-pass.json`, `shard-3-pass.json`: valid passing shard receipts.
- `missing-shard-receipts.json`: incomplete shard set (missing shard 3).
- `duplicate-shard-receipts.json`: duplicate shard ID (shard 1 submitted twice).
- `mismatched-shard-receipts.json`: inconsistent expected_shards (shard 1 expects 3, shard 2 expects 4).
- `no-result-missing-secret.json`: explicit NO-RESULT when `EVIDENCE_PRODUCER_SECRET` is unset.
- `no-result-all-skipped.json`: suite with zero executed and all skipped tests.
- `no-result-xfail-only.json`: suite with xfail tests only.
- `no-result-zero-executed.json`: suite with zero executed tests.
- `no-result-unparseable.json`: unparseable test runner output.
- `failed-no-reporter-text.json`: failed test with `"message unavailable"` fallback.
