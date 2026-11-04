# Prior-output recovery without replay

Refs #797/#775 and Superboard #1819/#1820. The optional mainplane_recover_output
tool reads a completed Run receipt belonging to the current persisted Veyyon
session, then retrieves its immutable output artifact. It never submits a command.

Every response must match the stable run key, request digest and output digest.
Canonical base64, integer byte count and SHA-256 are checked before decoding.
Output must be UTF-8 text without NUL; binary data is explicitly refused rather
than disguised as model-readable text. The native Go endpoint remains binary-safe
for a separate artifact-aware client.

Pages use Unicode code-point offsets, not UTF-16 halves. The response supplies
next_offset and output_sha256; pin the latter for subsequent pages. It labels
retrieval_only and the original execution_exit separately, so retrieving a failed
command's diagnostic output is not mistaken for the command succeeding.

This is the native bounded output tail. A larger worker spill remains named by
full_output_path and must be read separately. Corruption, unavailable artifacts,
foreign sessions and unfinished operations are explicit errors, not reasons to
rerun an uncertain side effect. No real command/output was used in the tests.

This surface remains experimental and disabled by default with the extension.
Its registered-tool demo, seeded settings differential and exact-parity bench
are still missing; see the [shared proof backlog](mainplane-worker-bridge.md#experimental-status-and-missing-proof)
and [#797](https://github.com/Wladefant/veyyon/issues/797).
