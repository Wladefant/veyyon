# Explicit current-session cancellation

Refs Veyyon #794 and Superboard #1817/#1818. The opt-in Mainplane extension now
registers mainplane_worker_cancel_session. The model can specify a worker only;
the remote session is derived from Veyyon's current persisted execution session.
The schema rejects an extra session selector, and execution does not read one.

This calls native Go Worker.Kill and stops the current session's interpreters and
jobs on that worker. It is destructive to that running work and should be invoked
only when explicitly intended. Compaction, timeout and reconnect handlers do not
call it. Other sessions and machines remain untouched by this tool call.

Each cancellation is request-bound and has a durable no-replay receipt. Only an
acknowledgement from the requested worker/session is success; an uncertain result
is an error. A repeated key cannot kill work started after the original action.
Inspect its receipt rather than retry with a new key after an uncertain outcome.

Focused remote CI includes the registered-tool tests and all existing Mainplane
adapter suites. No real process was stopped during authoring, and actual OS
process-tree behavior remains part of the host pilot.

This surface remains experimental and disabled by default with the extension.
Its registered-tool demo, seeded settings differential and exact-parity bench
are still missing; see the [shared proof backlog](mainplane-worker-bridge.md#experimental-status-and-missing-proof)
and [#794](https://github.com/Wladefant/veyyon/issues/794).
