import { describe, expect, test } from "bun:test";
import { discoverFleet, validateFleetInventory, registerMainplaneDiscovery } from "../examples/extensions/mainplane-bridge-discovery";
import type { ExtensionAPI } from "@veyyon/coding-agent";
import { z } from "zod";

function inventory() {
	return { schema_version: 1, adapter: "superboard-mainplane-bridge/v2",
		upstream_source_sha: "123c20654133782cc0a5e0a3c9edfa5410b09f6e", scope: "connected-or-refused",
		workers: [{ name: "pc2", status: "connected", os: "windows", arch: "amd64", version: "0.5.9", interpreters: ["pwsh", "js"] }] };
}

describe("native fleet discovery", () => {
	test("uses GET only and projects away unknown response fields", async () => {
		const data = { ...inventory(), token: "never-echo-this" };
		const calls: string[] = [];
		const transport = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push(`${init?.method} ${String(input)}`);
			return new Response(JSON.stringify(data));
		}) as typeof fetch;
		const result = await discoverFleet("https://fleet.example.org", "fixture-token", undefined, transport);
		expect(calls).toEqual(["GET https://fleet.example.org/fleet/workers"]);
		expect(result.workers[0]?.interpreters).toEqual(["js", "pwsh"]);
		expect(JSON.stringify(result)).not.toContain("never-echo-this");
		expect(data.workers[0]?.interpreters).toEqual(["pwsh", "js"]);
	});
	test("preserves refused state and a genuine empty native pool", () => {
		const data = inventory(); data.workers[0]!.status = "refused";
		expect(validateFleetInventory(data).workers[0]?.status).toBe("refused");
		expect(validateFleetInventory({ ...inventory(), workers: [] }).workers).toEqual([]);
	});
	test("refuses stale schemas and source pins", () => {
		for (const change of [{ schema_version: 2 }, { adapter: "stock" }, { upstream_source_sha: "0".repeat(40) }, { scope: "all-enrolled" }]) {
			expect(() => validateFleetInventory({ ...inventory(), ...change })).toThrow();
		}
	});
	test("refuses duplicates, coerced states and unbounded inventories", () => {
		const row = inventory().workers[0]!;
		for (const workers of [[row, row], [{ ...row, status: ["connected"] }], [{ ...row, name: "../pc" }],
			[{ ...row, interpreters: ["pwsh", "pwsh"] }], [{ ...row, version: "bad\nversion" }], Array(1025).fill(row)]) {
			expect(() => validateFleetInventory({ ...inventory(), workers })).toThrow();
		}
	});
	test("registers a no-argument read-only tool", () => {
		let registered: { name: string; parameters: z.ZodType } | undefined;
		registerMainplaneDiscovery({ zod: { z }, registerTool(tool: unknown) {
			registered = tool as { name: string; parameters: z.ZodType };
		} } as unknown as ExtensionAPI);
		expect(registered?.name).toBe("mainplane_fleet_status");
		expect(registered?.parameters.safeParse({}).success).toBe(true);
		expect(registered?.parameters.safeParse({ command: "ignored?" }).success).toBe(false);
	});
});
