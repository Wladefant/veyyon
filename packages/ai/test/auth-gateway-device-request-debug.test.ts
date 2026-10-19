import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@veyyon/catalog/build";
import { withLogRedaction } from "@veyyon/utils/logger";
import { startAuthGateway } from "../src/auth-gateway/server";
import type { AuthGatewayServerHandle } from "../src/auth-gateway/types";
import type { AuthStorage } from "../src/auth-storage";
import { createRequestDebugSession, isRequestDebugEnabled, wrapFetchForRequestDebug } from "../src/utils/request-debug";

it("disables raw request and response dumps for device-mode provider calls even when request debug is enabled", async () => {
	const cwd = process.cwd();
	const previous = Bun.env.VEYYON_REQ_DEBUG;
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-private-dumps-"));
	let gateway: AuthGatewayServerHandle | undefined;
	try {
		process.chdir(directory);
		Bun.env.VEYYON_REQ_DEBUG = "1";
		expect(isRequestDebugEnabled()).toBe(true);
		await withLogRedaction(() => "private diagnostics withheld", async () => {
			expect(isRequestDebugEnabled()).toBe(false);
			await expect(createRequestDebugSession({ protocol: "http2", method: "POST", url: "https://example.invalid", body: "private-request" })).rejects.toThrow("disabled for private gateway requests");
		});
		const model = buildModel({
			id: "example-model", name: "Example", api: "openai-completions", provider: "openai",
			baseUrl: "https://example.invalid/v1", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
		});
		let calls = 0;
		const transport = wrapFetchForRequestDebug(async () => {
			calls++;
			const chunk = { id: "private", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "private-response" }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		});
		gateway = startAuthGateway({
			bind: "127.0.0.1:0", bearerTokens: [], resolveBearerTokens: () => ["device-bearer"], resolveModel: () => model,
			storage: { getApiKey: async () => "provider-secret", getOAuthAccountIdentity: () => undefined } as unknown as AuthStorage,
			fetch: transport,
		});
		const response = await fetch(`${gateway.url}/v1/chat/completions`, {
			method: "POST", headers: { "content-type": "application/json", authorization: "Bearer device-bearer" },
			body: JSON.stringify({ model: model.id, messages: [{ role: "user", content: "private-request" }], stream: false }),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("private-response");
		expect(calls).toBe(1);
		expect(await fs.readdir(directory)).toEqual([]);
	} finally {
		await gateway?.close();
		process.chdir(cwd);
		if (previous === undefined) delete Bun.env.VEYYON_REQ_DEBUG;
		else Bun.env.VEYYON_REQ_DEBUG = previous;
		await fs.rm(directory, { recursive: true, force: true });
	}
});
