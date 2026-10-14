import { MCP_WEBHOOK_MAX_BODY_BYTES, type MCPWebhookReceiver } from "./events-webhook";

export interface MCPWebhookHost {
	readonly port: number;
	close(): Promise<void>;
}

/** Bind only loopback; the configured HTTPS relay must preserve the callback path and raw body. */
export function startMCPWebhookHost(receiver: MCPWebhookReceiver, port: number): MCPWebhookHost {
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("MCP webhook listener port must be an integer from 0 to 65535");
	}
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		maxRequestBodySize: MCP_WEBHOOK_MAX_BODY_BYTES,
		idleTimeout: 10,
		fetch(request) {
			return receiver.handle(request);
		},
		error() {
			return new Response(null, { status: 503 });
		},
	});
	server.unref();
	return {
		port: server.port,
		async close() {
			await server.stop(true);
		},
	};
}
