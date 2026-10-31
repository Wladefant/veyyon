import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { bridgeOrigin, mainplaneRequestHash, remoteRunId, remoteSessionId, runRemote, validateRunReceipt } from "../examples/extensions/mainplane-worker-bridge";

const args = { worker: "pc2", interpreter: "pwsh", code: "echo ok", timeoutSeconds: 30,
	sessionFile: "/session/a.json", toolCallId: "tool-42" };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
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
		expect(mainplaneRequestHash("run", "pc2", "sb-42", "pwsh", "30", "echo ok"))
			.toBe("b60c7d0de5026c7e7942ad1a60e140ef69ce385569523486826116f1af90e60c");
		expect(mainplaneRequestHash("run", "mac", "session-1", "js", "1", "é\n😀"))
			.toBe("bc579276fca14a570425610e681fb2203fd990844e3e2bf01ae8ddbaef62e2a2");
	});
	test("rejects credential-bearing and nonprivate HTTP origins", () => {
		for (const origin of ["http://host.example/", "https://user:pw@host.example/", "https://host.example/?key=secret"]) {
			expect(() => bridgeOrigin(origin)).toThrow();
		}
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
		expect(result.replayed).toBe(true);
		expect(result.result.state).toBe("uncertain");
		expect(calls).toBe(1);
	});
	test("rejects a wrong key, old schema, missing exit and forged body", () => {
		for (const change of [{ idempotency_sha256: "0".repeat(64) }, { schema_version: 1 }, { exit: undefined }, { body: "wrong" }]) {
			expect(() => validateRunReceipt({ ...receipt(), ...change }, remoteRunId(args.sessionFile, args.toolCallId))).toThrow();
		}
	});
	test("pre-aborted operations do not call the transport or leak private errors", async () => {
		let called = false;
		const abort = new AbortController(); abort.abort();
		const transport = (async () => { called = true; throw new Error("fixture-private-secret"); }) as typeof fetch;
		await expect(runRemote("https://fleet.example/", "fixture-key", args, abort.signal, transport)).rejects.toThrow("transport failed");
		expect(called).toBe(false);
	});
	test("accepts a valid native receipt whose escaped Go JSON envelope exceeds the reply cap", async () => {
		const body = "\0".repeat(100 * 1024);
		let calls = 0;
		const response = { ...receipt(), body, output_sha256: digest(body) };
		const envelope = JSON.stringify(response);
		expect(envelope.length).toBeGreaterThan(600 * 1024);
		const transport = (async () => { calls++; return new Response(envelope); }) as typeof fetch;
		const result = await runRemote("https://fleet.example/", "fixture-key", args, undefined, transport);
		expect(result.result.body).toBe(body);
		expect(calls).toBe(1);
		const oversizedBody = "\0".repeat(180 * 1024);
		const oversizedEnvelope = JSON.stringify({ ...receipt(), body: oversizedBody, output_sha256: digest(oversizedBody) });
		expect(Buffer.byteLength(oversizedEnvelope)).toBeGreaterThan(1024 * 1024);
		let oversizedCalls = 0;
		let cancelled = false;
		const oversizedTransport = (async () => {
			oversizedCalls++;
			return new Response(new ReadableStream<Uint8Array>({
				start(controller) { controller.enqueue(new TextEncoder().encode(oversizedEnvelope)); },
				cancel() { cancelled = true; },
			}));
		}) as typeof fetch;
		await expect(runRemote("https://fleet.example/", "fixture-key", args, undefined, oversizedTransport)).rejects.toThrow("response exceeded limit");
		expect(oversizedCalls).toBe(1);
		expect(cancelled).toBe(true);
	});

});
