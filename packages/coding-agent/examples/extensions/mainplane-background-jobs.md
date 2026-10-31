# Native background job tools

Refs Veyyon #799/#775 and Superboard #1821/#1822. The opt-in extension exposes
mainplane_worker_start_job and mainplane_worker_job_status. They call the native
Go Job/receipt API; no worker protocol, provider or scheduler is replaced.

A launch is bound to the current persisted Veyyon session and tool call. Accepted
PID/log metadata means background work was acknowledged, not that the process or
task succeeded. Status reads distinguish accepted, completed, cancelled and
uncertain. A restarted or untracked bridge reports uncertainty; the tools never
infer liveness from a PID, automatically poll, or relaunch the job.

The common receipt validator checks the deterministic job ID, owner instance,
PID/log shape, key/request identity and lifecycle semantics. Completed job output
is available through mainplane_recover_output, with the same session and artifact
integrity checks as foreground output. Explicit current-session cancellation uses
the existing Kill tool; context compaction does not call it.

Tests exercise accepted/pending semantics, duplicate uncertainty, current-session
status, malformed metadata and failed/cancelled outcomes using injected transports.
The focused remote CI runs these alongside all existing adapter tests. Actual
worker process trees, reconnection and task acceptance remain host-pilot gates.
