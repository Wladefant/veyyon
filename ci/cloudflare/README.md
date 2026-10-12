# Veyyon Cloudflare CI

Workers Builds runs the repository's TypeScript check and existing sharded test buckets, attempts the Rust checks, builds the production Linux x64 CLI binary, and uploads an isolated health Worker version. It does not deploy the Veyyon application.

## Trigger configuration

`trigger.json` records the intended Workers Builds configuration. The Git integration runs on all branches except `main` and watches all paths. Its build command is `bash ci/cloudflare/lane-tests.sh`. Its deploy command is `npx wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc`. The build token and GitHub repository connection are configured in the Cloudflare account; they are not stored in this repository.

Use a Workers Builds user token with the account-level Workers Builds Configuration Edit permission and the Workers Scripts Read permission. Store it outside git in the project-specific secure store and provide its working-copy path only to the authorized activation lane. Never use the broad account token for this setup.

## Build behavior

The lane reads the pinned Bun version from the root `package.json`, installs that exact version if the container differs, and installs dependencies from the frozen lockfile. It runs `bun run check:ts`, then reuses `scripts/ci-test-ts.ts` in workspace, native, and every coding-agent bucket. It emits total test pass/fail counts and requires at least one pass and zero failures.

The lane builds the Linux x64 production CLI through `scripts/ci-release-build-binaries.ts`. It runs `bun run check:rs` when Cargo is available. Cargo failures stop the build; only a missing Cargo executable is reported as an unsupported container capability. It uploads only the `veyyon-ci-health` Worker version. It disables Workers routes and preview URLs.

The Worker responds with `ok` to health probes. A version upload does not activate or promote the version. It does not expose a public Worker URL or alter the application deployment path.
