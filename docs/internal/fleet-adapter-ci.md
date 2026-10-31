# Focused native-fleet adapter CI

Refs #792/#775. Use the existing `OVH CI` workflow dispatch. Set `target_sha` and `base_sha` to the exact source head and exact PR base. Set `test_files` to the JSON array of exactly these four paths, in order: `packages/coding-agent/test/mainplane-go-worker-extension.test.ts`, `packages/coding-agent/test/mainplane-go-worker-read-text.test.ts`, `packages/coding-agent/test/mainplane-go-tool-failure.test.ts`, `packages/coding-agent/test/mainplane-go-worker-write.test.ts`. Set `fleet_adapter` to `true`. Dispatch only after the existing runner label has been admitted as unique. This change makes no automatic-push claim.

The reducer records test identities/counts and source SHA, and retains `live_workers_tested=false` and `provider_requests=false`. Passing evidence covers injected transports only. It does not qualify live workers, native platform behavior, or provider access.
