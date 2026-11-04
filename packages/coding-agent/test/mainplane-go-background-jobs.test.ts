import { describe, expect, test } from "bun:test";
import { digest, mainplaneRequestHash, receiptIsError, remoteJobId, remoteRunId, remoteSessionId, validateReceipt } from "../examples/extensions/mainplane-bridge-wire";
import { inspectRemoteJob, startRemoteJob } from "../examples/extensions/mainplane-bridge-jobs";

const input = { worker: "pc2", interpreter: "bash", code: "echo background", sessionFile: "/session/current", toolCallId: "job-one" };
const id = remoteRunId(input.sessionFile, input.toolCallId);
function receipt(state = "accepted") {
	const session = remoteSessionId(input.sessionFile);
	return { schema_version: 2, operation: "job", worker: input.worker, session,
		idempotency_sha256: digest(id), request_sha256: mainplaneRequestHash("job", input.worker, session, input.interpreter, input.code),
		state, job: remoteJobId(id), pid: 123, log: "/scratch/job.log", owner_instance: "bridge-one",
		...(state === "completed" ? { exit: 0, output_sha256: digest("done") } : {}) };
}

describe("native background job tools", () => {
	test("accepted is pending, not process success", async () => {
		let calls = 0;
		const transport = Object.assign((async (_url: string | URL | Request, init?: RequestInit) => {
			calls++; expect(init?.method).toBe("POST"); return new Response(JSON.stringify(receipt()), { status: 202 });
		}), { preconnect: globalThis.fetch.preconnect });
		const result = await startRemoteJob("https://fleet.example/", "fixture-key", input, undefined, transport);
		expect(result.completed).toBe(false); expect(result.process_succeeded).toBe(false);
		expect(result.result.pid).toBe(123); expect(receiptIsError(result.result)).toBe(false); expect(calls).toBe(1);
	});
	test("uncertain duplicate never launches again", async () => {
		let calls = 0; const transport = Object.assign((async () => { calls++; return new Response(JSON.stringify(receipt("uncertain")), { status: 409 }); }), { preconnect: globalThis.fetch.preconnect });
		const result = await startRemoteJob("https://fleet.example/", "fixture-key", input, undefined, transport);
		expect(result.replayed).toBe(true); expect(receiptIsError(result.result)).toBe(true); expect(calls).toBe(1);
	});
	test("status is read-only and bound to the current session", async () => {
		const transport = Object.assign((async (_url: string | URL | Request, init?: RequestInit) => { expect(init?.method).toBe("GET"); return new Response(JSON.stringify(receipt("completed"))); }), { preconnect: globalThis.fetch.preconnect });
		const done = await inspectRemoteJob("https://fleet.example/", "fixture-key", { runId: id, sessionFile: input.sessionFile }, undefined, transport);
		expect(done.completed).toBe(true); expect(done.process_succeeded).toBe(true);
		await expect(inspectRemoteJob("https://fleet.example/", "fixture-key", { runId: id, sessionFile: "/foreign" }, undefined, transport)).rejects.toThrow("another");
	});
	test("status helper refuses a missing session before any bridge request", async () => {
		const forbidden = Object.assign((async () => { throw new Error("status must not reach bridge without a session"); }), { preconnect: globalThis.fetch.preconnect });
		await expect(inspectRemoteJob("https://fleet.example/", "fixture-key",
			{ runId: id, sessionFile: "" }, undefined, forbidden)).rejects.toThrow("Persisted session");
	});
	test("rejects wrong native job identity and incomplete start metadata", () => {
		for (const change of [{ job: "wrong" }, { pid: 0 }, { log: undefined }, { owner_instance: "../bad" }]) {
			expect(() => validateReceipt({ ...receipt(), ...change }, id, "job")).toThrow();
		}
	});
	test("cancelled and failed jobs are not successful completion", () => {
		expect(receiptIsError(validateReceipt(receipt("cancelled"), id, "job"))).toBe(true);
		expect(receiptIsError(validateReceipt({ ...receipt("completed"), exit: 7 }, id, "job"))).toBe(true);
	});
});
