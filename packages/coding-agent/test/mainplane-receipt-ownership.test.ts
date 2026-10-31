import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@veyyon/coding-agent";
import { z } from "zod";
import { digest, remoteJobId, remoteRunId, remoteSessionId } from "../examples/extensions/mainplane-bridge-wire";
import extension from "../examples/extensions/mainplane-worker-bridge";

interface ReceiptToolReply {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
}
interface ReceiptTool {
	execute: (toolCallId: string, params: { runId: string }, signal: AbortSignal | undefined,
		onUpdate: undefined, ctx: { sessionManager: { getSessionFile: () => string | undefined } }) => Promise<ReceiptToolReply>;
}
function receiptTool(): ReceiptTool {
	const tools: Array<{ name: string; execute: ReceiptTool["execute"] }> = [];
	extension({ zod: { z }, registerTool(tool: unknown) {
		tools.push(tool as { name: string; execute: ReceiptTool["execute"] });
	} } as unknown as ExtensionAPI);
	const receipt = tools.find(tool => tool.name === "mainplane_run_receipt");
	if (!receipt) throw new Error("Mainplane receipt tool not registered");
	return receipt;
}
function nativeReceipt(file: string, id: string, operation: "run" | "job" = "run",
	state: "completed" | "accepted" = "completed") {
	const data = {
		schema_version: 2, idempotency_sha256: digest(id), request_sha256: digest("fixture-request"),
		operation, worker: "pc2", session: remoteSessionId(file), state,
		...(operation === "job" ? { job: remoteJobId(id), pid: 123, log: "owned-log", owner_instance: "main-harness" } : {}),
		...(state === "completed" ? { exit: 0, output_sha256: digest("private-output"), body: "private-output" } : {}),
	};
	return data;
}
async function withStubbedReceipt<T>(data: object, run: (calls: () => number) => Promise<T>): Promise<T> {
	let calls = 0;
	const stub = spyOn(globalThis, "fetch").mockImplementation((async () => {
		calls++;
		return new Response(JSON.stringify(data));
	}) as typeof fetch);
	const previousURL = process.env.MAINPLANE_BRIDGE_URL;
	const previousKey = process.env.MAINPLANE_API_KEY;
	process.env.MAINPLANE_BRIDGE_URL = "https://fleet.example/";
	process.env.MAINPLANE_API_KEY = "fixture-key";
	try { return await run(() => calls); }
	finally {
		stub.mockRestore();
		if (previousURL === undefined) delete process.env.MAINPLANE_BRIDGE_URL; else process.env.MAINPLANE_BRIDGE_URL = previousURL;
		if (previousKey === undefined) delete process.env.MAINPLANE_API_KEY; else process.env.MAINPLANE_API_KEY = previousKey;
	}
}
function inspect(id: string, file: string | undefined): Promise<ReceiptToolReply> {
	return receiptTool().execute("read-call", { runId: id }, undefined, undefined,
		{ sessionManager: { getSessionFile: () => file } });
}

describe("Mainplane operation receipts are scoped to the active session", () => {
	test("foreign completed Run receipt cannot disclose its body through the registered tool", async () => {
		const foreign = "/session/foreign.json";
		const id = remoteRunId(foreign, "executed-1");
		await withStubbedReceipt(nativeReceipt(foreign, id), async calls => {
			const result = await inspect(id, "/session/current.json");
			expect(calls()).toBe(1);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).not.toContain("private-output");
			expect(JSON.stringify(result)).not.toContain("owned-log");
		});
	});
	test("a missing persisted session refuses receipt inspection before network activity", async () => {
		const id = remoteRunId("/session/foreign.json", "executed-2");
		await withStubbedReceipt(nativeReceipt("/session/foreign.json", id), async calls => {
			const result = await inspect(id, undefined);
			expect(result.isError).toBe(true);
			expect(calls()).toBe(0);
			expect(JSON.stringify(result)).not.toContain("private-output");
		});
	});
	test("a foreign accepted Job receipt is not projected either", async () => {
		const foreign = "/session/other.json";
		const id = remoteRunId(foreign, "job-1");
		await withStubbedReceipt(nativeReceipt(foreign, id, "job", "accepted"), async () => {
			const result = await inspect(id, "/session/current.json");
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).not.toContain("main-harness");
		});
	});
	test("current-session completed Run receipt remains readable", async () => {
		const file = "/session/current.json";
		const id = remoteRunId(file, "executed-1");
		await withStubbedReceipt(nativeReceipt(file, id), async calls => {
			const result = await inspect(id, file);
			expect(calls()).toBe(1);
			expect(result.isError).toBe(false);
			expect(JSON.stringify(result)).toContain("private-output");
		});
	});
	test("current-session pending Job receipt retains its accepted state", async () => {
		const file = "/session/current.json";
		const id = remoteRunId(file, "job-1");
		await withStubbedReceipt(nativeReceipt(file, id, "job", "accepted"), async () => {
			const result = await inspect(id, file);
			expect(result.isError).toBe(false);
			expect(JSON.stringify(result)).toContain('"accepted"');
		});
	});
});
