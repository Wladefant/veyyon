# MCP Events (draft)

Veyyon implements opt-in support for the experimental [MCP Events design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md). The proposal may change. No subscription starts unless `events.enabled` is `true` and the server has at least one configured subscription. Each subscription uses a mode advertised for that event type.

## Configure an event subscription

Add an `events` object to a server entry in the active profile's `mcp.json`. For example, poll a server event:

```json
{
  "mcpServers": {
    "alerts": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "events": {
        "enabled": true,
        "subscriptions": [
          {
            "name": "incident.created",
            "mode": "poll",
            "arguments": { "severity": "P1" }
          }
        ]
      }
    }
  }
}
```

Each subscription needs `name` and `mode` (`poll`, `push`, or `webhook`). `arguments` is optional and must match that event's advertised `inputSchema`. Event discovery and subscription only happen when the server advertises Events, the event exists, and it advertises the configured mode. Unsupported or unadvertised subscriptions do not start. An absent or false `events.enabled`, or an empty subscriptions list, disables event requests.

Poll mode follows server `nextPollMs` with a minimum interval of 1,000 ms; if omitted, the client waits 30 seconds. The client persists opaque cursors and deduplicates repeated event IDs. Push opens a long-lived stream and ends it with the subscription. Neither requires a webhook receiver.

## Webhook receiver and relay

Webhook mode needs an HTTPS callback URL reachable by the MCP server and a local receiver port. The receiver binds only to `127.0.0.1`; the public callback address does not bind the local listener to a public interface. Configure a trusted HTTPS relay (such as a reverse proxy or tunnel) to forward the callback URL's exact path to `http://127.0.0.1:<listenPort>/<same-path>`. Preserve the request method, path, headers, and raw body; signature verification covers the raw bytes. Keep the relay access-controlled and expose only the intended callback route.

```json
{
  "mcpServers": {
    "alerts": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "events": {
        "enabled": true,
        "subscriptions": [
          {
            "name": "incident.created",
            "mode": "webhook",
            "arguments": { "severity": "P1" },
            "webhook": {
              "callbackUrl": "https://events.example.net/mcp/alerts/incidents",
              "listenPort": 8787,
              "secretRef": "$MCP_ALERTS_WEBHOOK_SECRET"
            }
          }
        ]
      }
    }
  }
}
```

`callbackUrl` must use HTTPS and must not include URL credentials or a fragment. Its path must be unique among active webhook subscriptions in the session. `listenPort` selects the local loopback receiver port; use the same port in the relay's upstream mapping. A generic callback URL has no fixed port requirement; the HTTPS front end and relay determine the public endpoint.

**Cloudflare-specific constraint:** for the Cloudflare webhook event, use a public dotted HTTPS hostname on port 443. That event is webhook-only. Do not generalize this requirement to other MCP webhook servers. See the [Cloudflare event bridge source](https://github.com/cloudflare/mcp-server-cloudflare/blob/e85737947299bbb9b5858fc9ae6bc6d1e6f9a3ba/src/events/ans-bridge.ts). Cloudflare Containers are reached through HTTP requests routed by Workers and Durable Objects, not direct inbound TCP/UDP to a container; see [Containers request lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/#lifecycle-of-a-request).

The server registers/refreshes a webhook subscription with a suggested 30-minute TTL and refreshes it before the granted deadline. The receiver verifies Standard Webhooks signatures and timestamp, accepts JSON events and control messages, and rejects malformed, expired, oversized, or invalidly signed deliveries. Disconnect or session cleanup unregisters the subscription and closes unused local listeners.

## Signing secret setup

Veyyon accepts only an explicit environment-variable reference in `webhook.secretRef`: `$NAME` or `${NAME}`. Set that variable in the environment available to the Veyyon process. Secret resolution is manual; Veyyon does not generate a key or provision Bitwarden entries.

Generate a cryptographically random Standard Webhooks `whsec_` signing key using your trusted secret-management process, store it in Bitwarden US, and inject its value into the named environment variable when starting Veyyon. Configure only the variable reference. Never place the raw key in `mcp.json`, source control, command-line arguments, or logs. Do not use a `vault:` string as `secretRef`; current event config resolution supports environment references only. Keep the same key provisioned on the server side so both sides verify/sign the same webhook deliveries.

## Event handling and session safety

Poll, push, and webhook occurrences are delivered to the session that owns the MCP manager and subscription. Event IDs are deduplicated per subscription; cursors and delivery journal state are persisted with that session for resume/replay handling. Session teardown stops event streams, unregisters webhook subscriptions, closes unused local receiver hosts, and detaches event callbacks.
Event delivery requires a persistent session journal. Sessions without a session file fail closed: delivery is not acknowledged until Veyyon can ensure the journal is on disk and flush it, so the server can retry rather than lose an event. Run event subscriptions in a session with a persistent journal to receive and resume delivery.


Event payloads remain untrusted data. They can contain prompt injection or misleading instructions and must be treated like untrusted MCP tool output, never as policy or system instructions. The event's `data` fields are content, not authorization to run tools or change settings.

## Protocol notes

`events/list` advertises event names, input and payload schemas, and supported delivery modes. Poll uses `events/poll` with the saved cursor; `truncated: true` indicates skipped history. Push uses a long-lived `events/stream` request and event notifications. Webhook uses only `events/subscribe` and `events/unsubscribe`; delivery is signed with Standard Webhooks headers and carries `X-MCP-Subscription-Id`. See the linked draft for cursor, gap, termination, and schema-evolution details.
