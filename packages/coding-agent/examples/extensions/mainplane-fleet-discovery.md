# Discover the actual native worker fleet

Refs [Veyyon #803](https://github.com/Wladefant/veyyon/issues/803) and [Superboard #1832](https://github.com/Wladefant/superboard/issues/1832).

The existing optional Mainplane extension now registers `mainplane_fleet_status`. It reads `GET /fleet/workers` through the same bounded, authenticated, no-redirect transport as other bridge operations. Server dependency: [Superboard PR #1834](https://github.com/Wladefant/superboard/pull/1834).

Use this tool before selecting a remote worker or interpreter rather than inventing machine names or assuming PowerShell/Bash availability. The response is the current native pool, not an inventory of every enrolled machine. Refused entries remain refused; absent machines can simply be disconnected. Discovery does not reserve a worker, schedule work or prove desktop/browser permissions.

The client requires the reviewed upstream source and schema, rejects duplicate/malformed/oversized records, and projects only names, connection state, OS, architecture, version and interpreters. Unknown fields are discarded. Provider credentials, scratch paths, drive settings and refusal text are not part of the tool result. No endpoint is contacted unless the explicitly loaded extension tool is invoked.

Focused remote CI discovers `mainplane-*.test.ts`; this change adds `mainplane-fleet-discovery.test.ts`. Live fleet discovery and machine enrollment remain separate acceptance evidence.
