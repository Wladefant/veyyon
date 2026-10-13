# MCP Events draft support

MCP Events is an experimental, opt-in protocol proposal. Veyyon currently recognizes the advertised `events` capability and exposes `events/list` and single-page `events/poll` client calls. It does not yet configure subscriptions, run poll loops, handle push or webhook delivery, persist cursors, deduplicate occurrences, or route events into sessions.

Proposal: [MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md). It may change before adoption. This guide describes the proposed contract so server authors can plan; it is not a usable Veyyon configuration reference.

## Proposed delivery modes

The proposal defines `events/list` to advertise event types, their subscription `inputSchema`, their `payloadSchema`, and a non-empty subset of delivery modes. No delivery mode is required by the proposal.

- **Poll** uses repeated `events/poll` requests with a server-issued cursor. Respect the server's `nextPollMs`; the proposal's client-side polling floor is 1,000 ms. A cursor is opaque. `truncated: true` means events may have been skipped, and `eventId` supports deduplication.
- **Push** uses a long-lived `events/stream` request. The server sends event notifications and heartbeats; ending the request ends that stream subscription.
- **Webhook** uses `events/subscribe` and `events/unsubscribe`. The client registers a callback URL, supplies a `whsec_` signing secret, and refreshes before the server-granted `refreshBefore` time unless the server grants no expiry. The server signs deliveries using Standard Webhooks headers and includes `X-MCP-Subscription-Id`.

Webhook delivery requires a callback endpoint the MCP server can reach. A loopback address such as `localhost` or `127.0.0.1` names the server's own network namespace, not the coding-agent user's machine; it is not a general remote callback route. Use a reachable HTTPS endpoint with a valid certificate and an authenticated MCP principal. The draft requires HTTPS and a valid `whsec_` value. The proposal's verification errors include unreachable endpoints and failed challenges.

The secret is signing material, not an event argument. A future client configuration should accept a secret reference and resolve it through its credential facility; it must not serialize or display a generated raw secret. Veyyon does not yet implement this behavior or a secret-reference field for event subscriptions. Do not put webhook signing secrets into checked-in MCP config.

## Trust and session boundaries

Event data is untrusted input, just like MCP tool results. It may contain prompt injection or misleading instructions. The proposal does not make payload text trusted policy. Veyyon does not yet provide event-to-session routing or event deduplication.

## Implementation status

The MCP client exposes capability negotiation, paginated `events/list`, and one-page `events/poll` primitives. It does not implement runtime mode negotiation, configured subscriptions, poll scheduling, push streams, webhook registration or verification, cursor persistence, deduplication, session-scoped delivery, or subscription cleanup. The APIs are building blocks, not an end-to-end event feature. This guide is not a usable Veyyon event configuration reference.
