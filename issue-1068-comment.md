State: PR ready for review.

Prepared changelog PR [PR #1070](https://github.com/Wladefant/veyyon/pull/1070) for merged [PR #1059](https://github.com/Wladefant/veyyon/pull/1059).

Post-merge release intake verified:
- Release lock: free (`.release.lock` not held).
- Merged PR #1059: merge commit `fccaf3bdcdbff6749dd2b0f3d8f344f0788d2066` is fetched and confirmed on `origin/main`.
- Package changelog entry for PR #1059 was absent under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md`.
- Per release policy (`assertReleaseIsDocumented`), prepared missing package changelog entry via PR #1070.

Ready for merge:
- PR: https://github.com/Wladefant/veyyon/pull/1070
- Full head: `e03c159e881b196f0ef46b6aa5ff19c98f6d49af`
- Branch: `docs/changelog-1059`
- Base: `main`
