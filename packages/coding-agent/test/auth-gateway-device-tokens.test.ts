import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readGatewayDeviceTokens, runAuthGatewayCommand } from "../src/cli/auth-gateway-cli";
import { startAuthGateway } from "@veyyon/ai/auth-gateway";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { clearCustomApis } from "@veyyon/ai/api-registry";
import { createMockModel, registerMockApi } from "@veyyon/ai/providers/mock";

describe("gateway device list", () => {
	it("re-reads active devices and refuses missing or malformed files without falling back", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-devices-"));
		const file = path.join(dir, "devices.json");
		try {
			expect(await readGatewayDeviceTokens(file)).toEqual([]);
			await fs.writeFile(file, JSON.stringify({ pc2: "device-token", other: "second-token" }));
			expect(await readGatewayDeviceTokens(file)).toEqual(["device-token", "second-token"]);
			await fs.writeFile(file, JSON.stringify({ other: "second-token" }));
			expect(await readGatewayDeviceTokens(file)).toEqual(["second-token"]);
			for (const raw of ["broken", "[]", "null", '{"pc2":""}', '{"pc2":"bad token"}', '{"pc2":123}']) {
				await fs.writeFile(file, raw);
				expect(await readGatewayDeviceTokens(file)).toEqual([]);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
	it("refuses no-auth before loading provider credentials", async () => {
		await expect(runAuthGatewayCommand({ action: "serve", flags: { noAuth: true } })).rejects.toThrow(
			"auth-gateway requires device bearer authentication",
		);
	});
	it("never restores a static token after a device file is revoked, broken or unreadable", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-revocation-"));
		const file = path.join(dir, "devices.json");
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		registerMockApi();
		storage.setRuntimeApiKey("openrouter", "provider-secret");
		const model = createMockModel({ provider: "openrouter", id: "revocation-model" });
		const gateway = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["stale-static-token"],
			resolveBearerTokens: () => readGatewayDeviceTokens(file),
			storage,
			resolveModel: () => model,
		});
		const request = (token: string) => fetch(gateway.url + "/v1/pi/stream", {
			method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
			body: JSON.stringify({ modelId: model.id, context: { messages: [] }, stream: false }),
		});
		try {
			await fs.writeFile(file, '{"pc2":"device-token"}');
			model.push({ content: ["authorized"] });
			const success = await request("device-token");
			expect(success.status).toBe(200);
			await success.text();
			for (const raw of ["{}", "broken", '{"pc2":123}']) {
				await fs.writeFile(file, raw);
				for (const token of ["device-token", "stale-static-token"]) expect((await request(token)).status).toBe(401);
			}
			await fs.unlink(file);
			for (const token of ["device-token", "stale-static-token"]) expect((await request(token)).status).toBe(401);
			expect(model.calls.length).toBe(1);
		} finally {
			await gateway.close();
			storage.close();
			clearCustomApis();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
