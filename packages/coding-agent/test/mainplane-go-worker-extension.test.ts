import { describe, expect, test } from "bun:test";
import { bridgeOrigin, digest, mainplaneRequestHash, remoteRunId, remoteSessionId, validateReceipt } from "../examples/extensions/mainplane-bridge-wire";
import { runRemote } from "../examples/extensions/mainplane-worker-bridge";

const args = { worker: "pc2", interpreter: "pwsh", code: "echo ok", timeoutSeconds: 30,
	sessionFile: "/session/a.json", toolCallId: "tool-42" };
const receipt = () => ({ schema_version: 2, operation: "run", worker: args.worker,
	session: remoteSessionId(args.sessionFile), idempotency_sha256: digest(remoteRunId(args.sessionFile, args.toolCallId)),
	request_sha256: mainplaneRequestHash("run", args.worker, remoteSessionId(args.sessionFile), args.interpreter, "30", args.code),
	state: "completed", exit: 0, output_sha256: digest("ok"), body: "ok" });

describe("Mainplane request-bound execution", () => {
	test("stable IDs differ across sessions and calls", () => {
		expect(remoteRunId("a", "x")).toBe(remoteRunId("a", "x"));
		expect(remoteRunId("a", "x")).not.toBe(remoteRunId("b", "x"));
		expect(remoteRunId("a", "x")).not.toBe(remoteRunId("a", "y"));
	});
	test("byte framing matches independent Go fixtures including Unicode", () => {
		expect(mainplaneRequestHash("run", "pc2", "sb-42", "pwsh", "30", "echo ok")).toBe("b60c7d0de5026c7e7942ad1a60e140ef69ce385569523486826116f1af90e60c");
		expect(mainplaneRequestHash("run", "mac", "session-1", "js", "1", "é\n😀")).toBe("bc579276fca14a570425610e681fb2203fd990844e3e2bf01ae8ddbaef62e2a2");
	});
	test("rejects credential-bearing and nonprivate HTTP origins", () => {
		for (const origin of ["http://host.example/", "https://user:pw@host.example/", "https://host.example/?key=secret"]) expect(() => bridgeOrigin(origin)).toThrow();
		expect(bridgeOrigin("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
	});
	test("accepts only a receipt bound to this request", async () => {
		const transport = (async () => new Response(JSON.stringify(receipt()))) as typeof fetch;
		const result = await runRemote("https://fleet.example/", "fixture-key", args, undefined, transport);
		expect(result.result.exit).toBe(0);
		expect(result.output_available).toBe(true);
		const wrong = (async () => new Response(JSON.stringify({ ...receipt(), request_sha256: "0".repeat(64) }))) as typeof fetch;
		await expect(runRemote("https://fleet.example/", "fixture-key", args, undefined, wrong)).rejects.toThrow("different work");
	});
	test("duplicate uncertain receipts do not trigger another request", async () => {
		let calls = 0;
		const { exit: _exit, output_sha256: _digest, body: _body, ...uncertain } = receipt();
		const transport = (async () => { calls++; return new Response(JSON.stringify({ ...uncertain, state: "uncertain" }), { status: 409 }); }) as typeof fetch;
		const result = await runRemote("https://fleet.example/", "fixture-key", args, undefined, transport);
		expect(result.replayed).toBe(true); expect(result.result.state).toBe("uncertain"); expect(calls).toBe(1);
	});
	test("rejects wrong keys, old schemas, missing exits and forged bodies", () => {
		for (const change of [{ idempotency_sha256: "0".repeat(64) }, { schema_version: 1 }, { exit: undefined }, { body: "wrong" }]) {
			expect(() => validateReceipt({ ...receipt(), ...change }, remoteRunId(args.sessionFile, args.toolCallId), "run")).toThrow();
		}
	});
	test("pre-aborted operations never reach transport", async () => {
		let called = false; const abort = new AbortController(); abort.abort();
		const transport = (async () => { called = true; throw new Error("fixture-private-secret"); }) as typeof fetch;
		await expect(runRemote("https://fleet.example/", "fixture-key", args, abort.signal, transport)).rejects.toThrow("transport failed");
		expect(called).toBe(false);
	});
});
