import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readRemoteText } from "../examples/extensions/mainplane-worker-bridge";

function response(data: Buffer, extra: Record<string, unknown> = {}): Response {
	return new Response(JSON.stringify({ schema_version: 1, worker: "pc2", data_base64: data.toString("base64"),
		bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), ...extra }));
}

// WHY: Go replaces lone UTF-16 surrogates in JSON paths with U+FFFD.
// Exercise production preflight and request bytes; no native host is accessed.
describe("Mainplane worker read path identity", () => {
	test("rejects lone high and low surrogate paths before authenticated transport", async () => {
		let calls = 0;
		const transport = Object.assign(async () => {
			calls++;
			return response(Buffer.from("sample"));
		}, { preconnect: globalThis.fetch.preconnect });
		for (const path of ["/owned/\ud800.txt", "/owned/\udc00.txt"]) {
			await expect(readRemoteText("https://fleet.example/", "fixture-key", "pc2",
				path, undefined, transport)).rejects.toThrow("Invalid worker or remote path");
		}
		expect(calls).toBe(0);
	});
	test("preserves Unicode, emoji and literal replacement-character paths on the wire", async () => {
		for (const path of ["/owned/München-東京-😀.txt", "/owned/\ufffd.txt"]) {
			let observedPath: unknown;
			const transport = Object.assign(async (_url: unknown, init?: RequestInit) => {
				const body = Buffer.from(String(init?.body), "utf8").toString("utf8");
				observedPath = JSON.parse(body).path;
				return response(Buffer.from("sample"));
			}, { preconnect: globalThis.fetch.preconnect });
			const result = await readRemoteText("https://fleet.example/", "fixture-key", "pc2",
				path, undefined, transport);
			expect(observedPath).toBe(path);
			expect(result.text).toBe("sample");
		}
	});
});

describe("Mainplane worker read integrity", () => {
	test("preserves verified UTF-8", async () => {
		const transport = Object.assign((async () => response(Buffer.from("sample"))), { preconnect: globalThis.fetch.preconnect });
		const result = await readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/file", undefined, transport);
		expect(result.text).toBe("sample");
		expect(result.truncated).toBe(false);
	});
	test("rejects forged digests, foreign workers, invalid lengths and noncanonical base64", async () => {
		for (const extra of [{ sha256: "0".repeat(64) }, { worker: "pc3" }, { bytes: -1 }, { bytes: 1.5 }, { data_base64: "eA==\n" }]) {
			const transport = Object.assign((async () => response(Buffer.from("x"), extra)), { preconnect: globalThis.fetch.preconnect });
			await expect(readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/file", undefined, transport)).rejects.toThrow();
		}
	});
	test("does not decode invalid UTF-8 as text", async () => {
		const transport = Object.assign((async () => response(Buffer.from([0xff, 0]))), { preconnect: globalThis.fetch.preconnect });
		await expect(readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/image", undefined, transport)).rejects.toThrow("binary");
	});
	test("display truncation does not split a surrogate pair", async () => {
		const transport = Object.assign((async () => response(Buffer.from("x".repeat(49_999) + "😀tail"))), { preconnect: globalThis.fetch.preconnect });
		const result = await readRemoteText("https://fleet.example/", "fixture-key", "pc2", "/file", undefined, transport);
		expect(result.text).toBe("x".repeat(49_999));
		expect(result.truncated).toBe(true);
	});
	test("rejects digest-valid NUL-containing UTF-8 even beyond the preview", async () => {
		for (const value of ["ok\0hidden", "x".repeat(50_001) + "\0hidden"]) {
			const transport = Object.assign((async () => response(Buffer.from(value, "utf8"))), { preconnect: globalThis.fetch.preconnect });
			await expect(readRemoteText("https://fleet.example/", "fixture-key", "pc2",
				"/binary-like", undefined, transport)).rejects.toThrow("binary");
		}
	});
	test("preserves ordinary Unicode and line breaks across the binary boundary", async () => {
		const content = "München\n東京";
		const transport = Object.assign((async () => response(Buffer.from(content, "utf8"))), { preconnect: globalThis.fetch.preconnect });
		const result = await readRemoteText("https://fleet.example/", "fixture-key",
			"pc2", "/unicode", undefined, transport);
		expect(result.text).toBe(content);
		expect(result.bytes).toBe(Buffer.byteLength(content, "utf8"));
		expect(result.truncated).toBe(false);
	});
});
