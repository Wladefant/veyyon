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

The lane disables the external SSH rung and pins `VEYYON_SANDBOX_RUNG=bwrap`. It downloads and unpacks Bubblewrap and its test tools into a temporary directory when the Workers Builds image lacks them. It keeps the checkout at its real path when possible. The repository sandbox runner relocates checkouts under the build user's home to `/srv/veyyon`; the lane queries the runner for that guest path instead of creating a checkout alias under `/tmp`. Test-owned temporary homes remain under `/tmp`, but the repository and its source files do not.

The lane copies the actual Bun executable into `.cf-proof-tools/bin` inside the checkout. Each sandbox command adds the guest-visible path to the fixed sandbox PATH, then runs the existing bucket command. The wrapper also supplies that PATH to nested commands that resolve `bun` by name. The host PATH does not enter the sandbox.

This lane verifies only Linux x64. It does not build `linux-arm64`, `win32-x64`, `darwin-x64`, or `darwin-arm64`. The Windows and macOS native runner jobs were retired, and this lane makes no GitHub Actions coverage claim for those targets. Additional platform coverage, including the separately authorized Linux cross-build follow-up, remains outside this lane.

The Worker unit test runs with `CLOUDFLARE_API_TOKEN` unset. The lane preserves every existing TypeScript test bucket, shard, and assertion, except for the one named guest-memory exclusion below. Quiet output reports actual Bun test totals (`pass`, `fail`, `skip`, and `todo`) plus chunk totals as separate values. The excluded test is not counted as skipped and does not change the test source:

- `packages/utils/test/slice-extract-fuzz.test.ts` is excluded from this Cloudflare lane only. In the Workers guest, Bun aborted when this test requested a native allocation of `17,179,869,180` bytes. The test remains unchanged. This exclusion is a Linux/GitHub-runner parity gap; it does not establish coverage on another runner.

The lane fails on missing or empty test summaries, any failed test, and any skipped or todo test. It then runs `bun run check:rs` and builds the Linux x64 production CLI through `scripts/ci-release-build-binaries.ts`. The deploy command uploads only the `veyyon-ci-health` Worker version and disables Workers routes and preview URLs.

The existing TypeScript test map excludes `clients/python/veybot/web`, which belongs to the Python client and sits outside every Bun test bucket. This lane follows that existing exclusion and does not run `bun run test:py`.

Before any test bucket starts, the shared test runner removes `CLOUDFLARE_API_TOKEN` from each child process. The deployment credential is not available to test code.

The Worker responds with `ok` to health probes. A version upload does not activate or promote the version. It does not expose a public Worker URL or alter the application deployment path.
