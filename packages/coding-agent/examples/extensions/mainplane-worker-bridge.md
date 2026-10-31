# Mainplane Go worker bridge (optional Veyyon tool extension)

Refs [Veyyon #775](https://github.com/Wladefant/veyyon/issues/775) and [Superboard #1774](https://github.com/Wladefant/superboard/issues/1774).

This extension reuses Veyyon's own extension tool API and the **native Go execution bridge** staged by [Superboard PR #1800](https://github.com/Wladefant/superboard/pull/1800). It does not modify provider credentials, model calls, codecs, grants or default tools. It is explicitly loaded only for a pilot; without the Go overlay, these tools cannot run.

1. Prepare and qualify the pinned Go bridge on a separate Mainplane harness; do not overwrite a running stock server.
2. Inject `MAINPLANE_BRIDGE_URL` (the bare HTTPS origin, or loopback HTTP) and `MAINPLANE_API_KEY` into the Veyyon process from the existing approved secret mechanism. Never put the API key in the Veyyon prompt or an issue.
3. Load `mainplane-worker-bridge.ts` from the Veyyon extension path, or via the existing `--extension` flag.
4. Enable and qualify the `mainplane_worker_run` and `mainplane_run_receipt` tools within the current permission profile. The bridge is a high-privilege remote shell on owned machines; only the explicitly installed extension exposes it.
5. Verify one named worker, a refused/disconnected worker, cancellation, a lost reply, a repeated tool call and cross-host job ownership before making it part of the default agent.

The run tool derives a stable idempotency key from the persisted Veyyon session and tool-call ID and submits it to the Go bridge. The Go side reserves that key before execution. A duplicate receives the durable receipt instead of running again. On an HTTP error or network loss, the tool says the result may be uncertain and tells you to query the receipt. **No automatic retry or fallback shell execution.**

The Go bridge currently implements Run only. Background jobs, file read/write, kill and robust remote-result delivery are later slices. Session names are hashed before leaving Veyyon, and the extension never logs the API key. Tool code/output still belongs to the active Veyyon session, as any shell tool does.

Tests: `bun test packages/coding-agent/test/mainplane-go-worker-extension.test.ts`. Runtime and remote CI verification pending; no live server was accessed.
