# Optional native Mainplane Go tools

Refs Veyyon #788/#790/#775 and Superboard #1774/#1815. Explicitly load only
mainplane-worker-bridge.ts; its transport and write modules are helpers, not
separate extensions. This requires the schema-2 Go bridge with Run/Read/Write.
No default tools, provider codecs, grants or credential refresh rules change.

Inject MAINPLANE_BRIDGE_URL and MAINPLANE_API_KEY using the existing secret flow.
Never put a key in prompts, issues, argv or versioned bundles. Each operation binds
the persisted Veyyon session/tool call to the exact native worker request. Errors
include the stable receipt key for reconciliation, never a raw network exception.

Run: nonzero shell exits and unconfirmed duplicates are error tool results.
Read: schema, worker, integer length, canonical base64, SHA-256 and UTF-8 are
validated; display truncation preserves Unicode pairs.
Write: mainplane_worker_write_text preserves exact UTF-8 and CRLF, caps bytes,
uses native Go Write/Read and requires the returned readback digest and path to
match. Both file text and remote path must round-trip exactly through UTF-8;
malformed lone-surrogate paths fail locally before any write, while valid Unicode
paths (including supplementary characters) remain unchanged. It overwrites the
specified path. Uncertain writes are never retried, and responses contain
metadata only. This is not atomic compare-and-swap against
concurrent external writers; success is readback at one instant.

The transport helper is shared by the actual Run/Read/Write callers. No legacy
aliases remain. Timeouts, byte ceilings, redirect refusal and sanitized errors
apply to all calls. Real host permissions, worker processes, central broker refresh
and T3 ACP propagation still require separate qualification. Remote CI is required.
