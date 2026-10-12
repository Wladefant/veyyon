# Veyyon Cloudflare CI

Workers Builds runs the repository's TypeScript check and existing sharded test buckets, builds portable Linux x64 native addons, runs the Rust checks, builds the Linux x64 production CLI, and uploads an isolated health Worker version. It does not deploy the Veyyon application.

## Trigger configuration

`trigger.json` records the intended Workers Builds configuration. The Git integration runs on all branches except `main` and watches all paths. Its build command is `bash ci/cloudflare/lane-tests.sh`. Its deploy command is `npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc`. The build token and GitHub repository connection are configured in the Cloudflare account; they are not stored in this repository.

All Workers Builds CI for all repositories runs in Cloudflare account `a0d288d1c95470cd009cc6e0df7accb7`. The account carries the Enterprise startup credits. Do not create or use Workers Builds resources in account `259beca7f28fdcd483c1ff85104c21f4`.

Use the existing user-scoped token `Cloudflare API token - polysim-builds` with Workers Builds Configuration Edit and Workers Scripts Read permissions. It is stored in the US Shared collection. Do not mint another user token. Keep its working copy outside git and do not print its value.

GitHub app connections and Workers Builds triggers are managed by the rollout tracker. Do not create a second connection or trigger.

## Build behavior

The lane reads the pinned Bun version from the root `package.json`, installs that exact version if needed, and installs dependencies from the frozen lockfile. It runs `bun run check:ts` before any tests. It installs missing Linux test dependencies only through non-interactive `sudo -n` when available; if that is unavailable, it reports the limit and continues without suppressing native compiler or test failures.

The lane installs the Rust nightly pinned by `rust-toolchain.toml`, Zig `0.16.0`, and `cargo-zigbuild`. It builds Linux x64 native addons for both `baseline` and `modern` variants against `x86_64-unknown-linux-gnu.2.17`, matching the release workflow's glibc floor. It then disables the external SSH rung, pins `VEYYON_SANDBOX_RUNG=docker`, and builds the repository's Docker test guest with `bash scripts/test-sandbox/run.sh --rung=docker --build` inside Workers Builds. Docker test containers forward only safe CI variables and `VEYYON_TEST_CONCURRENCY`; they do not receive `CLOUDFLARE_API_TOKEN`. If Docker is unavailable or fails, the build fails instead of running tests on the build host or another rung.

This lane verifies only Linux x64. It does not build `linux-arm64`, `win32-x64`, `darwin-x64`, or `darwin-arm64`. The existing GitHub Actions release matrix covers those targets.

The Worker unit test runs with `CLOUDFLARE_API_TOKEN` unset. The lane parses each existing Bun test shard's pass and fail totals and fails on any failure or zero passes. It then runs `bun run check:rs` and builds the Linux x64 production CLI through `scripts/ci-release-build-binaries.ts`. The deploy command uploads only the `veyyon-ci-health` Worker version and disables Workers routes and preview URLs.

Before any test bucket starts, the shared test runner removes `CLOUDFLARE_API_TOKEN` from each child process. The deployment credential is not available to test code.

The Worker responds with `ok` to health probes. A version upload does not activate or promote the version. It does not expose a public Worker URL or alter the application deployment path.
