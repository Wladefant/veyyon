import { describe, expect, test } from "bun:test";
import { digest, remoteSessionId } from "../examples/extensions/mainplane-bridge-wire";
import { recoverRemoteOutput } from "../examples/extensions/mainplane-bridge-output";

const input = { runId: "run-fixture", sessionFile: "/session/current" };
function transportFor(text: string, changes: Record<string, unknown> = {}, onCall = (_method: string) => {}): typeof fetch {
	const bytes = Buffer.from(text); const sha = digest(bytes);
	return (async (url: string, init: RequestInit) => {
		onCall(init.method ?? "");
		if (String(url).endsWith('/output')) return new Response(JSON.stringify({ schema_version: 1,
			idempotency_sha256: digest(input.runId), request_sha256: "a".repeat(64), output_sha256: sha,
			bytes: bytes.length, data_base64: bytes.toString('base64'), ...changes }));
		return new Response(JSON.stringify({ schema_version: 2, operation: "run", worker: "pc2",
			session: remoteSessionId(input.sessionFile), idempotency_sha256: digest(input.runId),
			request_sha256: "a".repeat(64), state: "completed", exit: 7, output_sha256: sha }));
	}) as typeof fetch;
}

describe("exact prior-output recovery", () => {
	test("uses reads only and keeps Unicode page boundaries", async () => {
		const methods: string[] = [];
		const transport = transportFor("a😀éz", {}, method => methods.push(method));
		const first = await recoverRemoteOutput("https://fleet.example/", "fixture-key", { ...input, limit: 2 }, undefined, transport);
		expect(first.text).toBe("a😀"); expect(first.next_offset).toBe(2); expect(first.execution_exit).toBe(7);
		const second = await recoverRemoteOutput("https://fleet.example/", "fixture-key", { ...input, offset: 2, limit: 2, outputSha256: first.output_sha256 }, undefined, transport);
		expect(second.text).toBe("éz"); expect(second.next_offset).toBe(null);
		expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
	});
	test("preserves a UTF-8 BOM across exact output pages", async () => {
		const text = "\uFEFFa😀";
		const methods: string[] = [];
		const transport = transportFor(text, {}, method => methods.push(method));
		const first = await recoverRemoteOutput("https://fleet.example/", "fixture-key", { ...input, limit: 1 }, undefined, transport);
		const second = await recoverRemoteOutput("https://fleet.example/", "fixture-key", { ...input, offset: 1, limit: 1, outputSha256: first.output_sha256 }, undefined, transport);
		const third = await recoverRemoteOutput("https://fleet.example/", "fixture-key", { ...input, offset: 2, limit: 1, outputSha256: first.output_sha256 }, undefined, transport);
		expect(first.text).toBe("\uFEFF"); expect(second.text).toBe("a"); expect(third.text).toBe("😀");
		expect([first.bytes, second.bytes, third.bytes]).toEqual([8, 8, 8]);
		expect([first.output_sha256, second.output_sha256, third.output_sha256]).toEqual([digest(Buffer.from(text)), digest(Buffer.from(text)), digest(Buffer.from(text))]);
		expect([first.next_offset, second.next_offset, third.next_offset]).toEqual([1, 2, null]);
		expect(methods).toEqual(["GET", "GET", "GET", "GET", "GET", "GET"]);
	});

	test("rejects tampered or foreign artifacts", async () => {
		for (const change of [{ request_sha256: "b".repeat(64) }, { data_base64: Buffer.from("wrong").toString("base64") }, { bytes: -1 }]) {
			await expect(recoverRemoteOutput("https://fleet.example/", "fixture-key", input, undefined, transportFor("ok", change))).rejects.toThrow();
		}
	});
	test("rejects a foreign execution session before requesting output", async () => {
		let calls = 0;
		const transport = transportFor("ok", {}, () => calls++);
		await expect(recoverRemoteOutput("https://fleet.example/", "fixture-key", { ...input, sessionFile: "/foreign" }, undefined, transport)).rejects.toThrow("owned");
		expect(calls).toBe(1);
	});
	test("revision mismatch and binary output are explicit", async () => {
		await expect(recoverRemoteOutput("https://fleet.example/", "fixture-key", { ...input, outputSha256: "0".repeat(64) }, undefined, transportFor("ok"))).rejects.toThrow("revision");
		await expect(recoverRemoteOutput("https://fleet.example/", "fixture-key", input, undefined, transportFor("binary\0"))).rejects.toThrow("binary");
	});
});
