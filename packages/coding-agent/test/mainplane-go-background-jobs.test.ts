import { describe, expect, test } from "bun:test";
import { digest, mainplaneRequestHash, receiptIsError, remoteJobId, remoteRunId, remoteSessionId, validateReceipt } from "../examples/extensions/mainplane-bridge-wire";
import { readRemoteReceipt } from "../examples/extensions/mainplane-worker-bridge";
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

	test("generic receipt reader rejects coercible JSON-array operation discriminators", async () => {
		const run = {
			schema_version: 2, operation: "run", worker: input.worker, session: remoteSessionId(input.sessionFile),
			idempotency_sha256: digest(id), request_sha256: digest("synthetic-run-request"), state: "submitting",
		};
		for (const operation of [["run"], ["write"], ["kill"], ["job"]]) {
			expect(() => validateReceipt({ ...run, operation }, id)).toThrow("receipt identity or schema");
		}
		let calls = 0;
		const transport = Object.assign((async (_url: string | URL | Request, init?: RequestInit) => {
			calls++; expect(init?.method).toBe("GET");
			return new Response(JSON.stringify({ ...run, operation: ["run"] }));
		}), { preconnect: globalThis.fetch.preconnect });
		await expect(readRemoteReceipt("https://fleet.example/", "fixture-key", id, input.sessionFile, undefined, transport))
			.rejects.toThrow("receipt identity or schema");
		expect(calls).toBe(1);
	});

	test("native job status rejects coercible JSON-array lifecycle states", async () => {
		const malformed = { ...receipt(), state: ["accepted"] };
		expect(() => validateReceipt(malformed, id, "job")).toThrow("receipt identity or schema");
		let calls = 0;
		const transport = Object.assign((async (_url: string | URL | Request, init?: RequestInit) => {
			calls++; expect(init?.method).toBe("GET");
			return new Response(JSON.stringify(malformed));
		}), { preconnect: globalThis.fetch.preconnect });
		await expect(inspectRemoteJob("https://fleet.example/", "fixture-key",
			{ runId: id, sessionFile: input.sessionFile }, undefined, transport))
			.rejects.toThrow("receipt identity or schema");
		expect(calls).toBe(1);
	});

	test("primitive operation and state discriminators preserve pending semantics", () => {
		const normalJob = validateReceipt(receipt(), id, "job");
		expect(normalJob.operation).toBe("job");
		expect(normalJob.state).toBe("accepted");
		expect(normalJob.job).toBe(remoteJobId(id));
		const run = validateReceipt({
			schema_version: 2, operation: "run", worker: input.worker, session: remoteSessionId(input.sessionFile),
			idempotency_sha256: digest(id), request_sha256: digest("synthetic-run-request"), state: "submitting",
		}, id);
		expect(run.operation).toBe("run");
		expect(run.state).toBe("submitting");
	});


	test("native completed receipt refuses non-round-trippable JSON body despite matching UTF-8 digest", async () => {
		// JSON escapes can carry isolated UTF-16 surrogates even though the
		// digest function encodes both those strings and real U+FFFD identically.
		const canonical = "\uFFFD";
		const malformed = "\uD800";
		expect(digest(malformed)).toBe(digest(canonical));
		const completed = {
			schema_version: 2, operation: "run", worker: input.worker,
			session: remoteSessionId(input.sessionFile), idempotency_sha256: digest(id),
			request_sha256: digest("synthetic-run-request"), state: "completed",
			exit: 0, output_sha256: digest(canonical),
		};
		for (const body of [malformed, "\uDC00"]) {
			expect(() => validateReceipt({ ...completed, body }, id, "run"))
				.toThrow("output digest mismatch");
		}
		let calls = 0;
		const transport = Object.assign((async (_url: string | URL | Request, init?: RequestInit) => {
			calls++; expect(init?.method).toBe("GET");
			return new Response(JSON.stringify({ ...completed, body: malformed }));
		}), { preconnect: globalThis.fetch.preconnect });
		await expect(readRemoteReceipt("https://fleet.example/", "fixture-key",
			id, input.sessionFile, undefined, transport)).rejects.toThrow("output digest mismatch");
		expect(calls).toBe(1);
		const good = validateReceipt({ ...completed, body: canonical }, id, "run");
		expect(good.body).toBe(canonical);
		expect(good.output_sha256).toBe(digest(canonical));
		const supplementary = "a😀";
		const goodUnicode = validateReceipt({
			...completed, body: supplementary, output_sha256: digest(supplementary),
		}, id, "run");
		expect(goodUnicode.body).toBe(supplementary);
	});

});
