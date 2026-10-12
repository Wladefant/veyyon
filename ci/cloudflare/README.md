# Veyyon Cloudflare CI

Workers Builds runs the repository's TypeScript check and existing sharded test buckets, attempts the Rust checks, builds the production Linux x64 CLI binary, and uploads an isolated health Worker version. It does not deploy the Veyyon application.

## Trigger configuration

`trigger.json` records the intended Workers Builds configuration. The Git integration runs on all branches except `main` and watches all paths. Its build command is `bash ci/cloudflare/lane-tests.sh`. Its deploy command is `npx wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc`. The build token and GitHub repository connection are configured in the Cloudflare account; they are not stored in this repository.

All Workers Builds CI for all repositories runs in Cloudflare account `a0d288d1c95470cd009cc6e0df7accb7`. The account carries the Enterprise startup credits. Do not create or use Workers Builds resources in account `259beca7f28fdcd483c1ff85104c21f4`.

Use the existing user-scoped token `Cloudflare API token - polysim-builds` with Workers Builds Configuration Edit and Workers Scripts Read permissions. It is stored in the US Shared collection. Do not mint another user token. Keep its working copy outside git and do not print its value.

GitHub app connections and Workers Builds triggers are managed by the rollout tracker. Do not create a second connection or trigger.

## Build behavior

The lane reads the pinned Bun version from the root `package.json`, installs that exact version if the container differs, and installs dependencies from the frozen lockfile. It runs `node --test --test-reporter=tap ci/cloudflare/worker.test.mjs` and `bun run check:ts`. It installs missing Linux test dependencies only through non-interactive `sudo -n` when available. If package installation is unavailable, it reports that limit and still attempts the pinned native build. The test buckets run after the native addon builds; native compiler and test failures remain failures, with no bucket skipped. It installs the pinned Rust nightly under `$HOME/.cargo` if needed, then builds the Linux x64 native addon and reuses `scripts/ci-test-ts.ts` for workspace, native, repo-script, and every coding-agent bucket. It disables the external SSH rung and builds the repository's Docker test guest with `bash scripts/test-sandbox/run.sh --build` inside Workers Builds before running the suites. If no in-container isolation rung works, the build fails.

The lane installs the Rust nightly pinned by `rust-toolchain.toml` under `$HOME/.cargo` when needed, then runs `bun run check:rs`; Rust installation, compiler, formatter, or clippy failures stop the build. Only an explicitly observed unsupported Linux x64 target may be reported as a target limitation. The lane builds the Linux x64 production CLI through `scripts/ci-release-build-binaries.ts`. It uploads only the `veyyon-ci-health` Worker version and disables Workers routes and preview URLs.

Before any test bucket starts, the shared test runner removes `CLOUDFLARE_API_TOKEN` from each child process. The deployment credential is not available to test code.

The Worker responds with `ok` to health probes. A version upload does not activate or promote the version. It does not expose a public Worker URL or alter the application deployment path.
