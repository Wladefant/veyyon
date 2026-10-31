import { describe, expect, test } from "bun:test";
import { digest, mainplaneRequestHash, remoteRunId, remoteSessionId } from "../examples/extensions/mainplane-bridge-wire";
import { writeRemoteText } from "../examples/extensions/mainplane-bridge-write";

const input = { worker: "pc2", path: "C:/owned/file.txt", text: "line one\r\né😀\r\n", sessionFile: "/session/one", toolCallId: "write-one" };
function transportFor(change: Record<string, unknown> = {}, status = 200, request = input): typeof fetch {
	return (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body));
		expect(Buffer.from(body.data_base64, "base64").toString("utf8")).toBe(request.text);
		expect(body.path).toBe(request.path);
		const session = remoteSessionId(request.sessionFile);
		return new Response(JSON.stringify({ schema_version: 2, operation: "write", worker: request.worker, session,
			idempotency_sha256: digest(remoteRunId(request.sessionFile, request.toolCallId)),
			request_sha256: mainplaneRequestHash("write", request.worker, session, request.path, digest(request.text)),
			state: "completed", exit: 0, output_sha256: digest(request.text), full: request.path, ...change }), { status });
	}) as typeof fetch;
}

describe("native worker text writes", () => {
	test("preserves CRLF and Unicode bytes and verifies readback", async () => {
		const result = await writeRemoteText("https://fleet.example/", "fixture-key", input, undefined, transportFor());
		expect(result.bytes).toBe(Buffer.byteLength(input.text));
		expect(result.result.state).toBe("completed");
		expect(JSON.stringify(result)).not.toContain(input.text);
	});
	test("refuses readback digest or path mismatch", async () => {
		for (const change of [{ output_sha256: "0".repeat(64) }, { full: "/other" }]) {
			await expect(writeRemoteText("https://fleet.example/", "fixture-key", input, undefined, transportFor(change))).rejects.toThrow("readback");
		}
	});
	test("uncertain duplicate stays uncertain without another write", async () => {
		let count = 0; const transport = transportFor({ state: "uncertain", exit: undefined, output_sha256: undefined, full: undefined }, 409);
		const counted = (async (...args: Parameters<typeof fetch>) => { count++; return transport(...args); }) as typeof fetch;
		const result = await writeRemoteText("https://fleet.example/", "fixture-key", input, undefined, counted);
		expect(result.result.state).toBe("uncertain"); expect(result.replayed).toBe(true); expect(count).toBe(1);
	});
	test("rejects oversized and malformed Unicode before sending", async () => {
		let count = 0; const transport = (async () => { count++; return new Response(); }) as typeof fetch;
		for (const text of ["x".repeat(1024 * 1024 + 1), "\ud800"]) {
			await expect(writeRemoteText("https://fleet.example/", "fixture-key", { ...input, text }, undefined, transport)).rejects.toThrow();
		}
		expect(count).toBe(0);
	});
	test("rejects lone-surrogate worker paths before authenticated HTTP", async () => {
		let calls = 0;
		const transport = (async () => {
			calls++;
			throw new Error("Invalid remote path must not be sent to Mainplane");
		}) as unknown as typeof fetch;
		for (const path of ["C:/owned/\ud800.txt", "C:/owned/\udc00.txt"]) {
			await expect(writeRemoteText("https://fleet.example/", "fixture-key", { ...input, path }, undefined, transport))
				.rejects.toThrow("Invalid worker or remote path");
		}
		expect(calls).toBe(0);
	});
	test("preserves supplementary Unicode in a valid native worker path", async () => {
		const request = { ...input, path: "C:/owned/🚀-résumé.txt" };
		const result = await writeRemoteText("https://fleet.example/", "fixture-key", request, undefined, transportFor({}, 200, request));
		expect(result.result.full).toBe(request.path);
		expect(result.result.state).toBe("completed");
	});
});
