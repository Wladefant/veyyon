# Focused native-fleet adapter CI

Refs #792/#775. Use the existing `OVH CI` workflow dispatch. Set `target_sha` and `base_sha` to the exact source head and exact PR base. Set `test_files` to the complete JSON array of regular files matching `packages/coding-agent/test/mainplane-*.test.ts` at the selected `target_sha`, only at that directory's top level. Order does not matter; duplicates, omitted suites, extra paths, fewer than four suites, more than 30 suites, and paths resolving outside the repository are rejected. Set `fleet_adapter` to `true`. Dispatch only after the existing runner label has been admitted as unique. This change makes no automatic-push claim.

The reducer records test identities/counts and source SHA, and retains `live_workers_tested=false` and `provider_requests=false`. Passing evidence covers injected transports only. It does not qualify live workers, native platform behavior, or provider access.
