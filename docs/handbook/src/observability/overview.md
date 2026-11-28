# Observability

## Interactive and CLI usage

- Status line token and cost segments during interactive sessions
- `veyyon stats` (CLI) and `/usage` (TUI) via `@veyyon/stats` when enabled
- Structured logging in the coding-agent logger
- Telegram delivery tracing for delivery lifecycle events across terminal and agent sessions

## OpenTelemetry

When `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set, the process exports agent-loop traces over OTLP/protobuf. See [Soundness and telemetry](../repair/soundness.md) and `packages/coding-agent/src/telemetry-export.ts`.

## Telegram delivery tracing

Telegram deliveries record tracing metadata across five pipeline stages:

1. `session_acceptance`: The socket interface accepts the delivery request for the target session.
2. `terminal_delivery_start`: Terminal control begins routing the delivery to the interactive session or active stream.
3. `turn_consumption`: The message enters the runtime turn from idle prompt or queue drain.
4. `provider_call_start`: The agent loop initiates the first provider stream for the turn.
5. `delivery_outcome`: The socket delivery promise settles with a terminal status or error.

Trace records are emitted through `@veyyon/utils` logger with fixed message `Telegram delivery trace`.
Allowlisted metadata includes `traceId` (`${chatId}:${updateId}:${messageId}`), `stage`, `wallTimeMs`, `monotonicMs`, `processId`, `bootId`, and `sessionId`.
Prompt text, tokens, and credentials are never included in trace records or serialized to transcripts.

## Session debugging

`/dump`, `/context`, `/debug`, and standalone tool CLIs such as `veyyon grep` for inspecting what the agent would see.

## Supervised child stderr

The supervisor writes new stderr segments to the profile's
`logs/session-stderr/retained-v1/`. Each child run has its own files, even when
another run used the same PID. A segment holds up to 1 MiB. The supervisor seals
it before the next write would exceed that limit, on the next write after 24
hours, or when capture ends.

The profile can retain up to 384 segments and 128 MiB of logical stderr data.
An active segment reserves its full capacity until it seals. When opening a
new segment, the supervisor removes only managed, sealed segments at least
seven days old. If the new segment still does not fit, capture stops for that
child, but stderr forwarding continues. Unexpected-exit reports include the
capture error and paths to retained segments.

The budget does not cover old PID logs outside `retained-v1/`. The supervisor
leaves them alone. Unsealed files from interrupted capture and files that
cannot be deleted remain charged. Save evidence that must outlast the seven-day
window to the approved evidence store.

## Automatic rejected-request dumps

For provider HTTP 400 and 413 responses, Veyyon can record one JSON file per
rejected request under the profile's `logs/http-400-requests/retained-v1/`.
The error message gives the path. Keep these files private: credential headers
are redacted, but request bodies can contain sensitive data.

Each profile holds up to 256 new dumps and 64 MiB of dump data. On a new
eligible rejection, Veyyon removes managed dumps at least seven days old.
If the new dump still does not fit, Veyyon reports that it could not save it.
It does not evict a dump within its seven-day window, alter the provider error,
or remove files written outside `retained-v1/`. Save incident evidence you need
to keep longer to your approved evidence store.

## Recording raw provider traffic

When a model behaves in a way you cannot explain from the transcript, record the
exact HTTP exchange. Set `VEYYON_REQ_DEBUG=1` before starting veyyon:

```sh
VEYYON_REQ_DEBUG=1 veyyon
```

Every request writes two files into the directory you started veyyon from:

- `rr-session-N.json`, the request: method, URL, headers, and body. A JSON body
  is stored parsed under `body`; anything else is stored as `bodyText`, or as
  `bodyBase64` when it is not valid UTF-8.
- `rr-session-N.res.log`, the response: the status line and headers, then the
  raw body bytes as they arrived, including every streaming chunk.

`N` counts up from 1 each time veyyon starts, and existing files are never
overwritten, so a second run in the same directory continues past the numbers
already there.

The files land in your
working directory rather than a cache directory, next to the project you were
working in; they are created readable by
you alone, and the repo `.gitignore` already covers `rr-session-*` so a stray
`git add` cannot pick one up. And a dump is the request as it went on the wire,
including file contents and whatever a provider echoed back, so treat it as
sensitive and delete it when you are done.

Credential headers do not go in. `Authorization`, `Cookie`, any header whose
name contains `api-key`, `auth-token`, `access-token` or `secret`, and their
response-side counterparts are written as `<redacted N chars>`: you can still
see that the header was sent and how long the value was, which is what a
debugging session needs, without the key itself sitting in a file you might
attach to a bug report. Bodies are recorded verbatim, so an OAuth token
exchange still puts a refresh token in the file.

Recording never interferes with the session it records. If a log cannot be
written, because the disk is full or the directory is read-only, veyyon logs an
error stating the file and the cause, stops recording that response, and lets the
response through untouched. You get your answer and a truncated log, not a
failed request.

Each file stops at 32 MiB. Past that the response log writes a line stating the
ceiling, then a final line stating how many bytes it recorded and how many it
omitted; a request body that ran past the ceiling contains the same counts under
`bodyCapture`, and the body itself is stored as `bodyText` rather than parsed
JSON. The response you get is unaffected: the ceiling bounds the recording, not
the request. Raise or lower it with `VEYYON_REQ_DEBUG_MAX_BYTES`, in bytes; a
value that is not a positive integer is a typo rather than a request for no
ceiling, so veyyon warns and keeps the default. An omitted count of `null` on a
request body means the sender declared no length, so the bytes past the ceiling
were never counted.
