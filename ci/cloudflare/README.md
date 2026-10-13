# Blocked: Veyyon Cloudflare CI

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

The lane disables the external SSH rung and pins `VEYYON_SANDBOX_RUNG=bwrap`. It downloads and unpacks Bubblewrap and its test tools into a temporary directory when the Workers Builds image lacks them. It copies the real Bun executable into that checkout and runs each existing test bucket through the repository's bubblewrap rung from a checkout path outside the build user's home.

The shard runner spawns child processes by the name `bun`. Each sandbox command starts through `/bin/sh` inside bwrap, adds only the checkout-mounted directory containing the copied Bun binary to the sandbox PATH, then replaces the shell with the shard runner. The host PATH does not leak into the sandbox.

This lane verifies only Linux x64. It does not build `linux-arm64`, `win32-x64`, `darwin-x64`, or `darwin-arm64`. The existing GitHub Actions release matrix covers those targets.
The Worker unit test runs with `CLOUDFLARE_API_TOKEN` unset. The lane preserves the existing CI test buckets, shards, and assertions. Quiet output reports actual Bun test totals (`pass`, `fail`, `skip`, and `todo`) plus chunk totals as separate values. It fails on missing or empty test summaries, any failed test, and any skipped or todo test. It then runs `bun run check:rs` and builds the Linux x64 production CLI through `scripts/ci-release-build-binaries.ts`. The deploy command uploads only the `veyyon-ci-health` Worker version and disables Workers routes and preview URLs.

The existing TypeScript test map excludes `clients/python/veybot/web`, which belongs to the Python client and sits outside every Bun test bucket. This lane follows that existing exclusion and does not run `bun run test:py`.

Before any test bucket starts, the shared test runner removes `CLOUDFLARE_API_TOKEN` from each child process. The deployment credential is not available to test code.

The Worker responds with `ok` to health probes. A version upload does not activate or promote the version. It does not expose a public Worker URL or alter the application deployment path.
