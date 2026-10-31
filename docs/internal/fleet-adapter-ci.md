# Focused native-fleet adapter CI

Refs #792/#775. The regular OVH workflow remains manual-only. A separate,
path-scoped `Fleet adapter contracts` workflow runs only the optional Mainplane
adapter tests when those files or their test assets change on a non-main branch.
It reuses [self-hosted, Linux, X64, veyyon] and the existing pinned Bun install
composite action. It does not start another runner or enable the full repository
suite on push.

The job checks the exact source head, runs four explicit Bun test files and
records JUnit output with Bun's documented reporter:
https://bun.sh/docs/test/reporters . The Python reducer rejects missing/empty,
skip-only, failed, duplicate or unsafe reports, including suite setup failures.
It stores test identities/counts, source SHA and explicit limitations: fixtures,
no live workers/provider requests/full typecheck. Failed test exit status still
fails the job even if later receipt generation runs.

Artifacts retain the log, JUnit XML and receipt for seven days in a dedicated
nonhidden evidence directory. No provider keys, Mainplane server, T3 host or
production configuration are needed. A passing job validates adapter behavior
under injected transports; actual Windows/macOS and native worker qualification
remain separate gates.
