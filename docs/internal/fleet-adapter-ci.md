# Focused native-fleet adapter CI

Refs #792/#775. Use the existing `OVH CI` workflow dispatch. Set `target_sha` and `base_sha` to the exact source head and exact PR base. Set `test_files` to the JSON array of the Mainplane adapter test paths selected by the workflow at that source SHA, and set `fleet_adapter` to `true`. The workflow validates the complete selected set without depending on path order. This change makes no automatic-push claim.

All resource jobs retain the fixed `[self-hosted, Linux, X64, veyyon]` runner class. Dispatch cannot replace that class with a caller-supplied label. The labels do not establish capacity or sandbox admission: dispatch only after the shared pool owner has verified the required finite per-job CPU/RAM limits, atomic admission and release, and the existing bubblewrap boundary for every eligible runner.

The reducer records test identities/counts and source SHA, and retains `live_workers_tested=false` and `provider_requests=false`. The existing artifact upload includes only the scoped `.ovh-tools/fleet-ci/` report directory alongside its existing logs and receipt; hidden files are enabled so that directory is retained. Passing evidence covers injected transports only. It does not qualify live workers, native platform behavior, or provider access.
