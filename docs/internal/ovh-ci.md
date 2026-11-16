# OVH CI: draft and ready pull requests

The existing `.github/workflows/ovh-ci.yml` owns the focused OVH test path. Draft status
is checked at the **job** boundary, before GitHub allocates a self-hosted runner.

## Automatic execution and admission

The workflow subscribes to `opened`, `synchronize`, `reopened`, and `ready_for_review`
pull-request events. It has no push trigger. A same-repository PR that is ready
runs the existing dependency-based test selector, changed-file lint, applicable
package typechecks, and the existing serial shard plan **only after automatic
runner admission has been activated**.

| Event or state | Result |
| --- | --- |
| Open or update a draft | All OVH jobs skip before runner allocation. |
| Open a ready PR, mark ready, update, or reopen it | Related-test path is eligible when admission is activated. |
| Fork PR | All OVH jobs skip, including after activation. |
| Admission variable missing or not accepted | All automatic OVH jobs skip. |
| Controlled manual dispatch | Existing focused test and explicit full-typecheck modes remain available under the operational admission policy. |

The activation variable is the repository Actions variable
`OVH_CI_PR_ADMISSION`. Its accepted value is `verified`. An unset or different
value fails closed. It is an acknowledgement of an accepted runner-admission
receipt, **not** an implementation of resource isolation or a substitute for
per-job admission hooks.

**Activation is still blocked by [issue #676](https://github.com/Wladefant/veyyon/issues/676).**
Before setting the variable, the CI owner must attach and accept evidence that
every runner eligible for the fixed `[self-hosted, Linux, X64, veyyon]` labels
provides a total 4 GiB memory limit, 1.5 CPU limit, atomic admission before each
job, and release after success, failure, cancellation, or timeout. A verified
shared pool used for one bounded source-verification job does not by itself
qualify the dedicated Veyyon label pool. Do not change labels or enable legacy
workflows to evade this hold.

After that receipt, set the variable to `verified` and use one ready-for-review
event or one controlled dispatch to verify the exact checkout, runner identity,
selected test paths, and parsed nonzero pass / zero failure counts. A variable
change does not retrigger old skipped runs. For an existing ready PR, an ordinary
update or a deliberate rerun provides the next evaluation; do not churn every
PR through draft just to create duplicate runs. Remove or change the variable
to close admission for future automatic jobs if the runner guarantee is lost.

GitHub reports skipped jobs as successful for merge protection purposes. A skip
while the admission gate is closed is **not test evidence** and must not be
reported as green CI. The source rollout and activation receipt are separate
deliverables.

## Source identity and work selection

Automatic runs check out and assert `pull_request.head.sha`, not GitHub's synthetic
merge commit. Selection uses `pull_request.base.sha` and records both that pinned
base and its merge base with the checked-out head in the preparation receipt.
The existing dependency selector chooses changed tests and tests related to
changed modules. This change adds no whole-repository default test run.

Controlled dispatch preserves the existing inputs:

- `target_sha` selects the exact source, or defaults to the workflow commit.
- `base_sha` is required for explicit focused test paths.
- `test_files` is a JSON array of existing relative test paths. Empty uses
  dependency selection. Focused mode keeps lint and package typecheck skipped.
- `native` and `cargo_packages` retain their current meanings. Leave
  `cargo_packages` empty to skip Cargo; `[]` is not the empty input.
- `typecheck=true` runs only the explicit full workspace typecheck job.

Runner labels, job deadlines, one-at-a-time shards, process-group cleanup, and
`cancel-in-progress: false` stay unchanged. Moving a PR back to draft suppresses
future draft updates; it does not cancel an already admitted running job.

## Focused validation

`scripts/validate-ovh-pr-workflow.ts` is a standalone read-only configuration
validator. It parses the actual workflow using Bun's built-in YAML parser and
checks event subscriptions, draft and admission conditions, same-repository
trust, manual modes, failed preparation, exact source/base selection, and its
own narrowly scoped workflow step. It imports only Node's filesystem reader,
assertions, and expression evaluator, with no app modules or package dependencies.

The prepare job runs it only when the workflow or validator changed, after Bun
is available. Explicit focused-test dispatches and the separate full-typecheck
mode keep their existing selection semantics. This configuration check uses
`bun scripts/validate-ovh-pr-workflow.ts`, not the Bun test runner. Application
test suites retain their mandatory sandbox and tripwire preloads.

Run the validator on an admitted verification route against the exact published
source SHA:

```sh
bun scripts/validate-ovh-pr-workflow.ts
```

Its final `OVH_WORKFLOW_VALIDATION` line reports actual case, pass, failure, and
assertion counts. A failure or an empty result exits nonzero. The optional
workflow-path argument supports a negative control against an older workflow
without changing the checked-out candidate:

```sh
bun scripts/validate-ovh-pr-workflow.ts /path/to/baseline-ovh-ci.yml
```

When a separately owned admitted shared-pool workflow verifies Veyyon source,
record its controller SHA, the Veyyon source SHA, actual runner admission
receipt, selected command, and decoded counts separately. A controller run ID
alone is not proof of the source commit tested. No package install, native
build, or application test suite is needed for this configuration validator.

## GitHub references

- [Pull-request event activity types](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
- [Job conditions and skipped checks](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-jobs-with-conditions)
- [Context availability and missing variables](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)

