import { expect, it } from "bun:test";
import { redactResponse } from "../src/auth-gateway/http";

it("redacts credential bytes split across SSE chunks and keeps cancellation", async () => {
	const encoder = new TextEncoder();
	let cancelled = false;
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode('data: {"text":"access-'));
			controller.enqueue(encoder.encode('secret refresh-secret"}\n\n'));
			controller.close();
		},
		cancel() { cancelled = true; },
	});
	const response = redactResponse(new Response(source, { headers: { "content-type": "text/event-stream", "x-debug": "access-secret" } }), ["access-secret", "refresh-secret"]);
	expect(response.headers.get("x-debug")).toBe("[REDACTED]");
	const text = await response.text();
	expect(text).toBe('data: {"text":"[REDACTED] [REDACTED]"}\n\n');
	const pending = redactResponse(new Response(new ReadableStream({ cancel() { cancelled = true; } })), ["access-secret"]);
	await pending.body!.cancel();
	expect(cancelled).toBe(true);
});

it("redacts credentials learned after a streaming response starts", async () => {
	const secrets: string[] = [];
	const response = redactResponse(new Response('data: {"error":"new-secret"}\n\n', { headers: { "content-type": "text/event-stream" } }), secrets);
	secrets.push("new-secret");
	expect(await response.text()).not.toContain("new-secret");
});
