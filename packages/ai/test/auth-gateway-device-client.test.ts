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
		const iteration = (async () => {
			for await (const _event of stream) { /* Drain the real client's error event. */ }
		})();
		const iterationRejected = expect(iteration).rejects.toThrow(/401|unauthorized/);
		const resultRejected = expect(stream.result()).rejects.toThrow(/401|unauthorized/);
		await Promise.all([iterationRejected, resultRejected]);
		expect(calls).toBe(1);
	});
	it("rejects on broker unavailability without a provider fallback", async () => {
		const model = { ...createMockModel({ provider: "openrouter", id: "device-test" }).model, baseUrl: "https://broker.example" };
		let calls = 0;
		const transport: FetchImpl = async () => { calls++; throw new Error("broker unavailable"); };
		const stream = streamPiNative(model, { messages: [] }, { apiKey: "device-token", fetch: transport });
		const iteration = (async () => {
			for await (const _event of stream) { /* Drain the real client's error event. */ }
		})();
		const iterationRejected = expect(iteration).rejects.toThrow("broker unavailable");
		const resultRejected = expect(stream.result()).rejects.toThrow("broker unavailable");
		await Promise.all([iterationRejected, resultRejected]);
		expect(calls).toBe(1);
	});
});
