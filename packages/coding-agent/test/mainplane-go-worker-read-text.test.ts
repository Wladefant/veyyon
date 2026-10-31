import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readRemoteText } from "../examples/extensions/mainplane-worker-bridge";

function response(data: Buffer, extra: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({ schema_version: 1, worker: "pc2", data_base64: data.toString("base64"),
		bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), ...extra }));
}

describe("Mainplane worker read integrity", () => {
	test("preserves verified UTF-8", async () => {
		const transport = (async () => response(Buffer.from("sample"))) as typeof fetch;
		const result = await readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/file", undefined, transport);
		expect(result.text).toBe("sample");
		expect(result.truncated).toBe(false);
	});
	test("rejects forged digests, foreign workers, invalid lengths and noncanonical base64", async () => {
		for (const extra of [{ sha256: "0".repeat(64) }, { worker: "pc3" }, { bytes: -1 }, { bytes: 1.5 }, { data_base64: "eA==\n" }]) {
			const transport = (async () => response(Buffer.from("x"), extra)) as typeof fetch;
			await expect(readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/file", undefined, transport)).rejects.toThrow();
		}
	});
	test("does not decode invalid UTF-8 as text", async () => {
		const transport = (async () => response(Buffer.from([0xff, 0]))) as typeof fetch;
		await expect(readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/image", undefined, transport)).rejects.toThrow("binary");
	});
	test("display truncation does not split a surrogate pair", async () => {
		const transport = (async () => response(Buffer.from("x".repeat(49_999) + "😀tail"))) as typeof fetch;
		const result = await readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/file", undefined, transport);
		expect(result.text).toBe("x".repeat(49_999));
		expect(result.truncated).toBe(true);
	});
});
