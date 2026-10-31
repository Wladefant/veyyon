# Session-owned Mainplane operation receipts

Refs [Veyyon #805](https://github.com/Wladefant/veyyon/issues/805), parent #775; [Superboard #1798](https://github.com/Wladefant/superboard/issues/1798).

The optional `mainplane_run_receipt` tool must inspect **only the current
persisted Veyyon execution session's** native Mainplane receipts. The caller
supplies a run identifier, not a session identity. Before its bounded
`GET /fleet/runs/:id`, the client requires the current session file through
`ctx.sessionManager` and calculates the existing `remoteSessionId`.
The response must pass the existing digest/schema checks **and** match that
current session. A foreign response, even with a valid idempotency digest,
is refused without projecting any of its body, worker, paths or output.

This invariant also applies to the exported TypeScript receipt reader, not
only the tool registration. Missing or ephemeral sessions fail closed before
transport. Failed ownership does not automatically retry, execute, cancel or
change any native job; failure text gives no foreign body. A receipt from the
current session preserves the existing completed, accepted, submitting,
uncertain and cancelled semantics. Run/Job status stays observation, not a
claim of successful execution or liveness.

The Go bridge still authenticates the request separately via its existing
bearer key. This client-side session fence is **defense in depth**, not a
substitute for server authorization. No Go server, credential broker, ACP,
installer, provider, native consent or browser route changes are included.

Offline regression cases: a valid foreign Run receipt with output is not
exposed; no persisted session performs zero network calls; a valid owned Run
receipt and an owned pending Job receipt remain inspectable. The registered
tool is exercised, not just the helper. Production receipt confidentiality
and real multi-host behavior still require an explicitly authorized host
acceptance and independent review; fixtures alone do not establish them.
