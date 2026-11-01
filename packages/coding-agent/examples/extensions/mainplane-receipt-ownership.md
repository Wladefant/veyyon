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

## Exact JSON discriminator types

The native receipt boundary also requires `operation` and `state` to be
**primitive JSON strings**, not values that happen to stringify to a known
enum member. In particular, `["run"]`, `["job"]` and `["submitting"]`
are not native receipt discriminators. Validate their runtime types before
operation-specific field checks or presenting a typed result to a tool.
The ordinary exact string values preserve their existing state and
ownership semantics; type-coerced responses fail closed before any
output or job metadata is projected. A failed GET never triggers Run,
Write, Kill or another side effect.

This is validation of synthetic, untrusted HTTP response objects, not
proof of a real Go worker or multi-host authorization. The associated
regression is in the existing `mainplane-go-background-jobs.test.ts`
suite. Executed CI and native-host acceptance are separate gates.

## Completed output UTF-8 identity

For a completed receipt, matching `output_sha256` to the UTF-8 encoding
of a projected `body` is meaningful only when that JavaScript string
round-trips through UTF-8 **without replacement**. JSON can encode an
unpaired UTF-16 surrogate as `"\\ud800"`; a permissive UTF-8 encoder
replaces it with U+FFFD, potentially giving the same SHA-256 as a different,
valid U+FFFD body. Refuse that non-round-trippable JSON text **before**
treating the digest as evidence of the displayed output. Valid U+FFFD
and supplementary Unicode remain accepted with their actual digest.

This is an untrusted-JSON response integrity check, not proof that the
worker executed a command or that the receipt is authorized. A digest match
does not attest the underlying remote process, live host, native browser
consent or deployment. Tests must exercise the exported read-only GET path
with both non-round-trippable and canonical positive response variants.
