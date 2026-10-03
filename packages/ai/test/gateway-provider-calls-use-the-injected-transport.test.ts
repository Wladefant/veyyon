// WHY: Gateway fetch injection must reach both translated and native provider calls,
// streaming or completed. A real ambient endpoint detects silent fallback to fetch.
import { expect, it } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { buildModel } from "@veyyon/catalog/build";
import { startAuthGateway } from "../src/auth-gateway/server";
import type { AuthStorage } from "../src/auth-storage";

function sse(text: string): string {
	const chunk = {
		id: "fake-id",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
	};
	return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}
it("uses injected transport for native and translated, streaming and completed calls", async () => {
	let ambientCalls = 0;
	const upstream = createServer((_req, res) => {
		ambientCalls++;
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(sse("ambient-transport"));
	});
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	const address = upstream.address();
	if (!address || typeof address === "string") throw new Error("Missing listener");
	const model = buildModel({
		id: "example-model",
		name: "Example",
		api: "openai-completions",
		provider: "openai",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	});
	let injectedCalls = 0;
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: [],
		resolveModel: () => model,
		storage: {
			getApiKey: async () => "fake-key",
			getOAuthAccountIdentity: () => undefined,
		} as unknown as AuthStorage,
		fetch: async () => {
			injectedCalls++;
			return new Response(sse("injected-transport"), { headers: { "content-type": "text/event-stream" } });
		},
	});
	try {
		for (const native of [false, true])
			for (const stream of [false, true]) {
				const body = native
					? {
							modelId: model.id,
							context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
							stream,
						}
					: { model: model.id, messages: [{ role: "user", content: "hello" }], stream };
				const response = await fetch(`${gateway.url}${native ? "/v1/pi/stream" : "/v1/chat/completions"}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(10000),
				});
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("injected-transport");
			}
		expect(injectedCalls).toBe(4);
		expect(ambientCalls).toBe(0);
	} finally {
		await gateway.close();
		upstream.close();
		await once(upstream, "close");
	}
});
