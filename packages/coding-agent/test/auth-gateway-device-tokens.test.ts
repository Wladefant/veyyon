import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readGatewayDeviceTokens, runAuthGatewayCommand } from "../src/cli/auth-gateway-cli";

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
});
