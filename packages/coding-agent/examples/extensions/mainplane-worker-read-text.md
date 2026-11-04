# Native Mainplane read-text byte contract

Refs [Veyyon #775](https://github.com/Wladefant/veyyon/issues/775), existing [PR #787](https://github.com/Wladefant/veyyon/pull/787), and [Superboard #1798](https://github.com/Wladefant/superboard/issues/1798).

The requested path must be non-empty, contain no NUL, fit within 4096 UTF-8
bytes, and survive UTF-8 encoding and decoding unchanged. Reject unpaired UTF-16
surrogates before authenticated HTTP: Go's JSON decoder otherwise replaces them
with U+FFFD and can read a different path. Valid Unicode, including emoji and a
literal U+FFFD replacement character in a filename, remains unchanged.

The optional `mainplane_worker_read_text` tool is a **text-only** view of an authenticated
native Go worker's file read. It must check the source byte count and SHA-256 before
decoding with fatal UTF-8. A byte stream with embedded `0x00` is binary for this
contract even though U+0000 is technically valid UTF-8; refuse it with the
existing binary-aware-artifact guidance rather than projecting a NUL-containing
string to the model. This matches the existing completed-run output-recovery
boundary. Legitimate UTF-8, including Unicode and line breaks, remains readable
and retains the existing text truncation metadata. A NUL past the displayed
50,000-character slice is still disqualifying: validate the whole verified read.

The request is initiated only when the opt-in tool is explicitly invoked.
It does not grant new worker access, enable provider credentials, change Go
server protocol, rewrite files, retry remote operations or attach a personal
browser. Tests use injected, digest-valid synthetic responses; no actual host
or file is accessed. Source fixtures do not prove multi-PC or browser acceptance.
Normal admitted exact-head CI and independent review are required before merge.
