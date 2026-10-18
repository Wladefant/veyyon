# Status: Twelve Shards Configured, Remote Test Execution Not Yet Proven

Status: Twelve dedicated Workers and triggers are configured, but current remote test execution remains unproven. Build `c4f3b664-d3cb-4077-aeea-1f8196e0647d` on commit `8c3d00014b059c6744bf81c98523742bd6e1b9f8` selected `bwrap` and failed before tests with `_: 1: exec: bun: not found`. No tests ran, and no pass counts exist.

## Scope

This audit covers `Wladefant/veyyon` across Cloudflare accounts `a0d288d1c95470cd009cc6e0df7accb7` and `259beca7f28fdcd483c1ff85104c21f4`. Other repositories remain read-only.

## Documentation Read

- https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-image/
- https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/
- https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/update/
- https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/methods/cancel/
- https://developers.cloudflare.com/workers/versions-and-deployments/

## Trigger State and Filter Correction

- All 12 dedicated shard triggers still have branch includes `["*"]` and branch excludes `["main"]`. Their path includes are `["*"]`, with no excluded paths.
- Two PATCH attempts against trigger `bbc69b64-d598-4be3-a9ea-7d6bf654a5d9` returned HTTP 400, error 12002, `Invalid request body`. The second identical failure ended retries. No filter update succeeded.
- Six personal-account builds for commit `b00fb5afb7c1f615b750970ff762532a56e1a8dc` were cancelled. Their final status was `stopped` with outcome `cancelled`:
  - `30bb6326-d0c2-4646-bb9e-d93b75e6139c`
  - `71d6e2e7-c476-48ea-a58d-460f063ab799`
  - `24e1aa0c-b168-4d07-9f18-770b27e88df1`
  - `ee61d524-4058-4fcd-994a-bfc6a53a8633`
  - `5a9a09fc-9495-4a01-bb16-913f5f17a6fe`
  - `b2d9131c-a183-41a8-890c-d2ba6234cfde`
- The six listed build UUIDs have logs with environment initialization only. None ran checkout, build commands, or uploads.
- Trigger attempts, cancellation responses, and all 12 live filter readbacks are recorded in `ci/cloudflare/TRIGGER_CORRECTION_AND_CANCELLATIONS_EVIDENCE.json`.

## Remote Test Execution

- Build UUID `c4f3b664-d3cb-4077-aeea-1f8196e0647d` ran at commit `8c3d00014b059c6744bf81c98523742bd6e1b9f8` on shard 12.
- Its log shows `bwrap` selected, followed by `_: 1: exec: bun: not found`. Tests did not start, and the build produced no pass counts.
- Build UUID `c4f3b664-d3cb-4077-aeea-1f8196e0647d` failed before the file-only Bun mount correction ran. Main reviewed that mount by inspection. No remote build has exercised it.
- Configured build and deploy commands do not prove that a remote test ran or establish the effective preview command.

## Legacy Worker Safety

- The read-only inventory found 16 Workers connected to this repo: 15 known Workers plus the extra `veyyon-native-cache` Worker.
- The resource matrix reports zero bindings, routes, and custom domains for all 16 Workers.
- The 12 shard triggers and three legacy triggers (`veyyon-ci-health`, `veyyon-ci-shard-2`, and `veyyon-ci-shard-3`) use catch-all branch includes `["*"]` and exclude `["main"]`.
- Sanitized records verify 12 version-upload builds by UUID, four each on three legacy Workers:
  - `veyyon-ci-health`: `8b2a14e8-03e6-425f-98a6-586cb5b126ee`, `774de255-d3aa-4e82-82c9-2cd3ded26f08`, `c0681c1b-36c0-4740-b20e-ffd5d42608a3`, `3ab32b8d-9a31-43a5-bea0-2afa8e380f3d`
  - `veyyon-ci-shard-2`: `83e82dc7-71f8-4db2-83e0-f6c74cdce09d`, `f53c8235-b5ff-4b59-90a3-83cfbc3408d7`, `35d4b996-7230-455d-b5ef-2c95bab1cb4c`, `cf1bf9f4-8392-4643-9d8a-52592cbda5fe`
  - `veyyon-ci-shard-3`: `6facdffd-91d8-4bef-adc3-94fe45501c0f`, `47d08a26-b47b-4be7-a6cd-a71e0ef9ad59`, `37174ac6-e851-4ec2-a618-43ff475e3528`, `a68fd102-3fe0-4093-bd71-b0b81bbb43e6`
- `agent://CfBuilds2.LegacyAudit` reported 13 upload-command observations across 415 `cf-ci` logs, but no sanitized artifact links the thirteenth to a build UUID. Keep it unverified.
- A version upload creates a Worker version. A deployment controls active traffic. Uploads alone do not prove traffic promotion.
- The effective preview setting and preview command remain unknown for the legacy Workers. A configured deploy command does not prove the effective preview command.
- At main SHA `5646799e6ea503953b5029f414ff85cd39fb8e4b`, `ci/cloudflare/lane-tests.sh` and `ci/cloudflare/wrangler.jsonc` were absent.
- Legacy inventory evidence: `agent://CfBuilds2.LegacyAudit`. Detailed upload evidence: `local://cf-poly-recovery.json`, `local://veyyon-shard2-build-log-audit.md`, and `local://veyyon-health-build-log-audit.md`.

## Verification Boundary

No local tests, builds, type checks, lint, Docker, or VPS checks ran. The operator prohibits those checks. Build UUID `c4f3b664-d3cb-4077-aeea-1f8196e0647d` failed before tests, so it does not prove test execution.

Deleted: none
Not run: local tests, builds, type checks, lint, Docker, VPS checks, and a corrected-head remote test run
