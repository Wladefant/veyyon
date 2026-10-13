import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { startAuthGateway } from "@veyyon/ai/auth-gateway";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";
import * as logger from "@veyyon/utils/logger";
import { streamPiNative } from "@veyyon/ai/providers/pi-native-client";

async function harness(initial: string[], resolve?: () => readonly string[] | Promise<readonly string[]>) {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-device-auth-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("openrouter", "provider-secret");
	const mock = createMockModel({ provider: "openrouter", id: "mock/device-auth" });
	const gateway = startAuthGateway({
		bind: "127.0.0.1:0", bearerTokens: initial, resolveBearerTokens: resolve,
		storage, resolveModel: () => mock.model,
	});
	return { url: gateway.url, mock, close: async () => {
		await gateway.close(); storage.close(); await fs.rm(dir, { recursive: true, force: true });
	} };
}
const endpoint = "/v1/chat/completions";
const payload = JSON.stringify({ model: "mock/device-auth", messages: [{ role: "user", content: "hello" }], stream: false });
async function request(url: string, authorization?: string) {
	return fetch(url + endpoint, { method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body: payload });
}
afterEach(() => clearCustomApis());

describe("auth-gateway device bearer authentication", () => {
	it("rejects missing, malformed, wrong, and revoked bearer tokens before provider dispatch", async () => {
		let active = ["device-token"];
		const gw = await harness([], () => active);
		try {
			for (const authorization of [undefined, "Bearer", "Bearer  ", "Basic wrong", "Bearer wrong"]) {
				expect((await request(gw.url, authorization)).status).toBe(401);
			}
			active = [];
			expect((await request(gw.url, "Bearer device-token")).status).toBe(401);
			expect(gw.mock.calls.length).toBe(0);
		} finally { await gw.close(); }
	});

	it("requires credentials on health and permits OPTIONS without dispatch", async () => {
		const gw = await harness(["device-token"]);
		try {
			expect((await fetch(gw.url + "/healthz")).status).toBe(401);
			expect((await fetch(gw.url + endpoint, { method: "OPTIONS" })).status).toBe(204);
			expect(gw.mock.calls.length).toBe(0);
		} finally { await gw.close(); }
	});

	it("uses current device tokens on each request and still dispatches authorized requests", async () => {
		let active = ["device-token"];
		const gw = await harness([], () => active);
		try {
			gw.mock.push({ content: ["ok"] });
			const success = await request(gw.url, "Bearer device-token");
			expect(success.status).toBe(200);
			expect((await success.text()).includes("provider-secret")).toBe(false);
			active = [];
			expect((await request(gw.url, "Bearer device-token")).status).toBe(401);
			expect(gw.mock.calls.length).toBe(1);
		} finally { await gw.close(); }
	});
	it("refuses an empty bearer configuration without dispatch", async () => {
		const gw = await harness([]);
		try {
			expect((await request(gw.url, "Bearer device-token")).status).toBe(401);
			expect(gw.mock.calls.length).toBe(0);
		} finally { await gw.close(); }
	});

	it("keeps device clients away from credential and RPC routes", async () => {
		const gw = await harness([], () => ["device-token"]);
		try {
			for (const route of ["/v1/credentials/check", "/v1/usage", "/v1/snapshot", "/rpc", "/shell"]) {
				expect((await fetch(gw.url + route, { headers: { Authorization: "Bearer device-token" } })).status).toBe(404);
			}
			expect(gw.mock.calls.length).toBe(0);
		} finally { await gw.close(); }
	});

	it("passes a credential-free native client through existing provider dispatch", async () => {
		const gw = await harness([], () => ["device-token"]);
		try {
			gw.mock.push({ content: ["native success"] });
			const model = { ...gw.mock.model, baseUrl: gw.url };
			const events = streamPiNative(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { apiKey: "device-token" });
			for await (const _event of events) { /* Drain the real native client. */ }
			const result = await events.result();
			expect(result.stopReason).toBe("stop");
			expect(JSON.stringify(result)).toContain("native success");
			expect(JSON.stringify(result)).not.toContain("provider-secret");
			expect(gw.mock.calls.length).toBe(1);
		} finally { await gw.close(); }
	});

	it("removes provider credentials from successful, failed and streaming responses and logs", async () => {
		const logs = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-private-logs-"));
		logger.setTransports({ file: logs, console: false });
		const gw = await harness([], () => ["device-token"]);
		try {
			for (const stream of [false, true]) {
				for (const failure of [false, true]) {
					gw.mock.push(failure ? { throw: "provider-secret leaked upstream" } : { content: ["answer provider-secret"] });
					const response = await fetch(gw.url + "/v1/pi/stream", {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: "Bearer device-token" },
						body: JSON.stringify({ modelId: gw.mock.id, context: { messages: [] }, stream }),
					});
					const text = await response.text();
					expect(text).not.toContain("provider-secret");
					expect(text).toContain("[REDACTED]");
				}
			}
			const files = await fs.readdir(logs);
			expect(files.length).toBeGreaterThan(0);
			let text = "";
			for (const file of files) text += await fs.readFile(path.join(logs, file), "utf8");
			expect(text).toContain("auth-gateway");
			expect(text).not.toContain("provider-secret");
			expect(text).not.toContain("device-token");
		} finally {
			await gw.close();
			logger.setTransports({ file: true, console: false });
			await fs.rm(logs, { recursive: true, force: true });
		}
	});
});
