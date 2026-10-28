import { describe, expect, it } from "bun:test";
import { MCP_WEBHOOK_MAX_BODY_BYTES } from "../src/mcp/events-webhook";
import { startMCPWebhookHost } from "../src/mcp/events-webhook-host";

describe("MCP event webhook loopback host", () => {
	it("forwards the callback path, signature headers and raw bytes without rewriting", async () => {
		const raw = '{ "data": { "text": "untrusted" } }';
		const received: Array<{ path: string; signature: string | null; body: string }> = [];
		const host = startMCPWebhookHost({
			async handle(request) {
				received.push({
					path: new URL(request.url).pathname,
					signature: request.headers.get("webhook-signature"),
					body: await request.text(),
				});
				return new Response(null, { status: 202 });
			},
		}, 0);
		const url = `http://127.0.0.1:${host.port}/hooks/owner-a`;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "webhook-signature": "v1,unchanged" },
				body: raw,
				signal: AbortSignal.timeout(2_000),
			});
			expect(response.status).toBe(202);
			expect(received).toEqual([{ path: "/hooks/owner-a", signature: "v1,unchanged", body: raw }]);
		} finally {
			await host.close();
		}
		await expect(fetch(url, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
	});

	it("returns a retryable empty response when the receiver fails", async () => {
		const host = startMCPWebhookHost({
			async handle() {
				throw new Error("untrusted payload or sensitive internal error must not escape");
			},
		}, 0);
		try {
			const response = await fetch(`http://127.0.0.1:${host.port}/hooks/a`, {
				method: "POST",
				body: "{}",
				signal: AbortSignal.timeout(2_000),
			});
			expect(response.status).toBe(503);
			expect(await response.text()).toBe("");
		} finally {
			await host.close();
		}
	});

	it("rejects a delivery larger than 256 KiB at the HTTP boundary", async () => {
		const host = startMCPWebhookHost({
			async handle(request) {
				await request.arrayBuffer();
				return new Response(null, { status: 202 });
			},
		}, 0);
		try {
			const response = await fetch(`http://127.0.0.1:${host.port}/hooks/a`, {
				method: "POST",
				body: new Uint8Array(MCP_WEBHOOK_MAX_BODY_BYTES + 1),
				signal: AbortSignal.timeout(2_000),
			});
			expect(response.status).toBe(413);
		} finally {
			await host.close();
		}
	});
});
