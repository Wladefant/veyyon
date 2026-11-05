# Optional native Mainplane Go tools

Refs Veyyon #788/#790/#775 and Superboard #1774/#1815. Explicitly load only
mainplane-worker-bridge.ts; its transport and write modules are helpers, not
separate extensions. This requires the schema-2 Go bridge with Run/Read/Write.
No default tools, provider codecs, grants or credential refresh rules change.

Inject MAINPLANE_BRIDGE_URL and MAINPLANE_API_KEY using the existing secret flow.
Never put a key in prompts, issues, argv or versioned bundles. Each operation binds
the persisted Veyyon session/tool call to the exact native worker request. Errors
include the stable receipt key for reconciliation, never a raw network exception.
Both native session and operation identity inputs must round-trip through UTF-8
without replacement. An unpaired UTF-16 surrogate is not a distinct persisted
session or tool-call identity: encoding it would alias the U+FFFD replacement
character and could reuse another operation's native idempotency key. Reject
such input before contacting the bridge; valid Unicode identities retain their
existing deterministic SHA-256-derived IDs. This is local identity integrity,
not a claim that malformed paths exist on a real enrolled machine.

Run: nonzero shell exits and unconfirmed duplicates are error tool results.
Read: schema, worker, integer length, canonical base64, SHA-256 and UTF-8 are
validated; display truncation preserves Unicode pairs.
Write: mainplane_worker_write_text preserves exact UTF-8 and CRLF, caps bytes,
uses native Go Write/Read and requires the returned readback digest and path to
match. Both file text and remote path must round-trip exactly through UTF-8;
malformed lone-surrogate paths fail locally before any write, while valid Unicode
paths (including supplementary characters) remain unchanged. It overwrites the
specified path. Uncertain writes are never retried, and responses contain
metadata only. This is not atomic compare-and-swap against concurrent external
writers; success is readback at one instant.

The transport helper is shared by the actual Run/Read/Write callers. No legacy
aliases remain. Timeouts, byte ceilings, redirect refusal and sanitized errors
apply to all calls. Real host permissions, worker processes, central broker refresh
and T3 ACP propagation still require separate qualification. Remote CI is required.

## Experimental status and missing proof

This extension is experimental and disabled by default. Explicitly loading
`mainplane-worker-bridge.ts` is the opt-in; leaving it unloaded exposes none of
these Mainplane tools. It adds no settings group or dependent settings knobs.

The feature-proof bar in `AGENTS.md` is not yet met. Committed end-to-end demos
under `proof/scenes/` driving the registered tools with the extension off and on,
a seeded settings differential in the PR body, and a committed exact-parity bench
are still missing. Manual extension loading does not supply the settings differential.
Injected-transport tests and remote CI do not replace these proofs. Keep this
source integration experimental and disabled by default; it is not a completed feature.

The existing open issues below carry the missing-proof backlog. Every row still
needs its registered-tool demo, seeded off/on settings differential, and bench
with the same corpus, inputs and seed. No completed proof is claimed here.

| Experimental surface | Open missing-proof backlog |
| --- | --- |
| Run/Read/Write and current-session receipts | [#775](https://github.com/Wladefant/veyyon/issues/775) |
| Current-session cancellation | [#794](https://github.com/Wladefant/veyyon/issues/794) |
| Prior-output recovery | [#797](https://github.com/Wladefant/veyyon/issues/797) |
| Fleet discovery | [#803](https://github.com/Wladefant/veyyon/issues/803) |
| Background jobs and status | [#799](https://github.com/Wladefant/veyyon/issues/799) |
