# Optional native Mainplane Go tools

Refs Veyyon #788/#775 and Superboard #1774/#1811. Requires the **schema-2 Go
bridge overlay** on a separate authorized Mainplane pilot. This file is not a
default extension and changes no provider codec, grant, registration or broker.

Inject MAINPLANE_BRIDGE_URL and MAINPLANE_API_KEY through the existing approved
secret flow, then explicitly load mainplane-worker-bridge.ts with --extension.
Do not put keys in prompts, issues, command arguments or a versioned bundle.

Run requests use a stable session/tool-call key and the same length-framed UTF-8
SHA-256 contract as Go. Responses must match that key, request, worker and session.
Old schemas, mismatched identities and contradictory terminal data are errors.
A completed process with a nonzero exit is an **error** tool result. Uncertain or
submitting duplicate receipts are also errors and must not be blindly replayed.
A duplicate completed receipt may lack the original output; output_available is
explicit and the command is not re-executed to recover it.

Requests have independent finite deadlines, strict byte ceilings and no redirects.
Reader overflow cancels the stream. Network exceptions are sanitized, not echoed.
Text reads require schema/worker identity, integer lengths, canonical base64 and
SHA-256. Invalid UTF-8 is refused and display truncation preserves surrogate pairs.
These checks are integrity/error semantics, not a replacement for runtime grants.

Tests include Go/TypeScript digest fixtures and execution of the registered tool
with a simulated nonzero exit. Real workers, broker refresh, cancellation of a
remote process tree, T3 session propagation and live binary compatibility still
need separate qualification. Remote CI is required before adoption.
