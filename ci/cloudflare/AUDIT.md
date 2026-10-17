# Status: Remote proof pending

Status: configuration and remote proof remain in progress.

## Scope

This audit covers Wladefant/veyyon on Cloudflare accounts
`a0d288d1c95470cd009cc6e0df7accb7` and `259beca7f28fdcd483c1ff85104c21f4`.
Other repositories' triggers remain read-only.

Docs read:

- https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-image/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-caching/
- https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/
- https://bun.sh/docs/test

Account history: [Cloudflare accounts, keys and CI map](https://github.com/Wladefant/superboard/issues/951).

## Constraints

Workers Paid permits six concurrent builds per account, not per repository.
Other repositories share these slots.
The [plan receipt](https://github.com/Wladefant/superboard/issues/951#issuecomment-6233916936)
records Workers Paid subscriptions for both accounts.
The current build-limits API returned `{}` for both accounts.
The audit's subscription read returned HTTP 403, so it did not independently confirm billing.

Each build has a 20-minute limit, 8 GB RAM, 20 GB disk, and four Paid-plan vCPUs.
The default build image uses Ubuntu 24.04 on x86_64.
Its documented tools include Bun 1.2.15 and build-essential, but do not list Rust.
Tool absence does not prove Cloudflare rejects tool installation.

Workers Builds accepts user-owned build tokens, not account-owned build tokens.
The build command runs before the deploy or preview command.
New preview builds default to `wrangler preview`.
Cloudflare does not support reversing a switch to Worker Previews.
This change must not make that switch or promote product code.

The build cache stores Bun's `.bun/install/cache`, not an arbitrary Cargo target directory.
Each project receives 10 GB, with seven-day retention after the last read.
Cache enablement requires confirmation in each CI Worker's build settings.
A warm cache is not proof that a native binary matches the checked-out source.

## Existing veyyon state

Workers API inventory refreshed on 2026-10-18 for both authorized accounts. This audit made no Worker, trigger, binding, or repository-connection writes.

| Account | Worker | Worker ID/tag | Trigger UUID | State |
| --- | --- | --- | --- | --- |
| PolySimulator `a0d288d1c95470cd009cc6e0df7accb7` | `veyyon-ci-health` | `cb6da4cf733546059ab6139cd97e4de7` | `a2dd8733-d34a-4789-8bea-a752ae2925e2` | Existing health trigger; read-only |
| PolySimulator | `veyyon-ci-shard-2` | `1ee4cc2a778e40b2a8cb65f4ddaf0494` | `43eae546-6bd6-45cf-9271-645de160013a` | Foreign owner unknown; read-only |
| PolySimulator | `veyyon-ci-shard-3` | `9b3c594460ad44a280ab7a5f753c7917` | `bb0605b2-8271-49a8-a972-de71c3ad68e8` | Foreign owner unknown; read-only |
| PolySimulator | `veyyon-native-cache` | `a2d4c5101f7a4de1a8220c4a196b6984` | `0138e77b-69b6-467e-935f-91163d60c465` | Existing native-cache trigger; read-only |
| PolySimulator | `veyyon-checkpoints` | `2732faf271bf4333911a3a0eaa150c69` | — | No build trigger |

The existing health trigger matches all branches except `main`, with no meaningful path filter. Its build command is `bash ci/cloudflare/lane-tests.sh`.
Its deploy command is `npx --yes wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc`.

Its build-cache setting is enabled. The connection UUID is `24200420-a2fc-4292-a246-19ad740fab16`. The user build-token UUID is `d01c37aa-f331-440b-9e92-5ecd9e68a435`.
Successful health builds uploaded Worker versions. This is a working historical command pattern, not proof that a new Worker uses upload-only behavior.
The listed PolySimulator Workers have no routes or custom domains, and their workers.dev and preview URLs are disabled.

The shard-2 and shard-3 triggers match all branches except `main` and have no meaningful path filters.
They run the lane test script with one-based `VEYYON_CI_SHARD` and `VEYYON_CI_SHARDS` values.
Their deploy commands target shard-specific Wrangler files. This lane did not change those foreign triggers.
The native-cache trigger runs `bash ci/cloudflare/native-cache-writer.sh`. Its two recent builds failed because that script was absent, not because a cache directory proved or disproved cache enablement.

The personal account `259beca7f28fdcd483c1ff85104c21f4` currently lists eight Workers and no `veyyon` Worker or trigger.
Its successful clone build `d3ffc5af-5800-4cda-8e7e-fbf0bc3d78b9` belongs to Shipnovo, not veyyon, so it does not prove a veyyon connection.
CfDashBind owns dashboard binding. TriggerPrep owns the authorized veyyon-only repository upsert.
This audit made no personal binding or repository-connection changes. The existing Shipnovo connection and its provider IDs remain untouched.

The authorized plan is six fresh shard Workers per account, named `veyyon-ci-s0` through `veyyon-ci-s11`, with `CF_SHARD_COUNT=12`.
Use `CF_SHARD_INDEX=i CF_SHARD_COUNT=12 bash ci/cloudflare/lane-tests.sh`, where `i` is the zero-based shard index.
Include only `cf-ci/*` branches, exclude `main`, and apply no path filter.
Use `npx wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc --name veyyon-ci-sI` for the per-shard upload command.
The personal half remains conditional on a current veyyon repository connection and a successful exact-head build.

No pilot has yet proven the new Worker's upload-only behavior. Create one dedicated pilot only after the runner is pushed, then verify its build settings and live log.
The trigger API does not expose `preview_command`. New preview builds default to `wrangler preview`.
Do not guess at a setting or make the irreversible Worker Previews switch.

Confirm cache enablement in each new Worker's build settings.
Do not infer it from a cache directory or an existing native-cache Worker.

## Recent veyyon failures

The shard-2 and shard-3 audit covers 100 builds and 83 failures. Complete logs classified 73 missing-runner failures, five trusted native-cache HTTP 404 misses, four test-assertion failures, and one install-stage termination.
The missing-runner failures show `bash: ci/cloudflare/lane-tests.sh: No such file or directory`.
The `cf-ci/*` branch filter prevents ordinary feature branches from invoking the runner.

The five cache-miss builds produced no test results. Their UUIDs are listed below.
Native cache misses require a trusted artifact and are not test failures:

- `0b826b50-8405-4c46-bbdd-85a3fcef29bb`
- `07c5bfe9-f256-488a-9fab-6611e13e3a9d`
- `876f7945-c4fb-4944-9f83-4106310d8e96`
- `063fd98a-daed-40d6-b1ad-a8624aada846`
- `09e2438a-f197-474d-ac03-6aec8ea0114b`

The four test failures were in `packages/coding-agent/test/session/quota-refusals-belong-to-the-failed-request.test.ts`.
Builds `a6de5ca8-856c-4a80-ac5c-161af9a3b187` and `932a70c8-4e40-43ce-80d0-e3b2e68e9068` each reported nine passes and one failure at SHA `469f7e9091a30daf4ebdcf29fc60d8caeb65ef11`.
Builds `f5d16331-c1f9-4057-ae72-3a2258d49515` and `7bf6aa89-c0a3-4cb7-a88d-120a9fb872cd` each reported one pass and nine failures at SHA `0de94c1db94bd9efe59f56d10e520ed94424baf7`.
These are test failures, not evidence of a CI transport defect.

The install-stage failure `338e69b2-e180-4901-b9bc-89a68a9f1816` took 47.679 seconds and reached no user command or test.
The logs do not identify the platform cancellation actor or explain why installation ended.
The cause remains unknown. This audit did not chase that build further.

The health Worker's full 50-build audit is independently verified from complete cursor-paginated logs and API events:

| Outcome | Count | Proven classification |
| --- | ---: | --- |
| Failed | 41 | 37 missing runner; two native-cache cold misses; two test failures |
| Cancelled | 4 | Two queued in `initializing`; one during clone; one during build compiling `cargo-zigbuild` |
| Skipped | 1 | Superseded in queue by a newer commit |
| Success | 4 | Full build and upload logs inspected |

Health missing-runner builds fail because the branch lacks `ci/cloudflare/lane-tests.sh`. The two native misses are `476be99e-089d-4133-83c4-2d32f92a9284` and `789047a3-779f-41ba-95a1-52571bb345f4`.
The two test failures are `58dbcd27-a33f-458b-97d9-b628f25f433f` and `942ad642-4858-44f5-8cfc-df7f34a4f7fd`.
Both fail the quota-refusal test.

The four cancelled builds are `cbc129f6-36f8-4c43-b8fb-d89ab57f0e0b`, `d180e439-dddf-4923-bfe9-2d90f0b130b2`, `0c467766-d2d0-4613-804d-d0b2017619c5`, and `4a7c0f86-86c6-48d0-b715-cd9d03163e0b`.
The skipped build is `eb16c920-4f56-4b45-9454-35b5cee097b7`. The full 50-row UUID, stage, duration, and root-cause register is in the session artifact `local://veyyon-health-build-log-audit.md`.

The health audit's four successful build records appear in the baseline section.
Three contain intentional red-branch assertions. Build status alone does not certify all assertions passed.

## Baseline and comparison rules

Existing shard-2 successes took 7m23s–8m38s from initialization to stop. Existing shard-3 successes took 7m28s–14m18s.
The four health successes report queue times separately from execution times.
Execution averaged 11m46s (7m53s–14m33s). Total elapsed averaged 13m27s (8m09s–16m48s).

| Build UUID | Queue | Execution | Total | Tests reported | Upload |
| --- | ---: | ---: | --- | --- |
| `8b2a14e8-03e6-425f-98a6-586cb5b126ee` | 3m23.3s | 13m24.4s | 16m47.6s | quota 0/9 pass, 9 fail; stream retry 1/0; device 2/0 | Uploaded |
| `774de255-d3aa-4e82-82c9-2cd3ded26f08` | 2m57.7s | 11m05.3s | 14m03.0s | quota 9/0; stream retry 1/0; device 2/0; total 12/0 | Uploaded |
| `c0681c1b-36c0-4740-b20e-ffd5d42608a3` | 16.2s | 7m52.9s | 8m09.1s | quota 0/9 pass, 9 fail; stream retry 1/0; device 2/0 | Uploaded |
| `3ab32b8d-9a31-43a5-bea0-2afa8e380f3d` | 3.3s | 14m33.5s | 14m36.8s | quota 0/9 pass, 9 fail; stream retry 1/0; device 2/0 | Uploaded |

These records are a before baseline, not an equivalent-workload comparison. A valid comparison must use the same SHA, discovered test corpus, and native artifact identity.
Record each shard's UUID, account, index, queue time, initialization-to-stop time, exact files, passes, failures, and skips.
Do not report aggregate success unless every shard completes and its file set forms an exact partition.

## Verification boundary

No local test, build, type check, lint, Docker run, or VPS check is allowed.
Only exact-head remote logs can establish a passing gate.
A green deployment status without parsed assertion counts does not establish test success.
Missing native prerequisites must fail closed rather than silently exclude native-dependent suites.

Deleted: none
Not run: remote proof and comparable before/after benchmark remain pending.
