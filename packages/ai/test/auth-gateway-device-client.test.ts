import { describe, expect, it } from "bun:test";
import { streamPiNative } from "@veyyon/ai/providers/pi-native-client";
import { createMockModel } from "@veyyon/ai/providers/mock";
import type { FetchImpl } from "@veyyon/ai/types";

describe("credential-free device client", () => {
	it("uses only the device bearer and omits it from the native request body", async () => {
		const model = { ...createMockModel({ provider: "openrouter", id: "device-test" }).model, baseUrl: "https://broker.example" };
		let calls = 0;
		const transport: FetchImpl = async (url, init) => {
			calls++;
			expect(String(url)).toBe("https://broker.example/v1/pi/stream");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer device-token");
			const body = String(init?.body);
			expect(body).not.toContain("device-token");
			expect(JSON.parse(body).options.apiKey).toBeUndefined();
			return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
		};
		const stream = streamPiNative(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { apiKey: "device-token", fetch: transport });
		for await (const _event of stream) { /* Drain the real client's error event. */ }
		expect((await stream.result()).stopReason).toBe("error");
		expect(calls).toBe(1);
	});
	it("reports broker unavailability without a provider fallback", async () => {
		const model = { ...createMockModel({ provider: "openrouter", id: "device-test" }).model, baseUrl: "https://broker.example" };
		let calls = 0;
		const transport: FetchImpl = async () => { calls++; throw new Error("broker unavailable"); };
		const stream = streamPiNative(model, { messages: [] }, { apiKey: "device-token", fetch: transport });
		for await (const _event of stream) { /* Drain the real client's error event. */ }
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("broker unavailable");
		expect(calls).toBe(1);
	});
});
