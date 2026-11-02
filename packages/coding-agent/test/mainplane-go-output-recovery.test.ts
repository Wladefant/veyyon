import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@veyyon/coding-agent";
import { z } from "zod";
import extension from "../examples/extensions/mainplane-worker-bridge";
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

interface RegisteredOutputReply {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	details?: { retrieval_only?: boolean };
}
interface RegisteredOutputTool {
	name: string;
	execute: (
		toolCallId: string,
		params: { runId: string; offset?: number; limit?: number; outputSha256?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { sessionManager: { getSessionFile: () => string | undefined } },
	) => Promise<RegisteredOutputReply>;
}
function registeredOutputTool(): RegisteredOutputTool {
	const tools: RegisteredOutputTool[] = [];
	extension({ zod: { z }, registerTool(tool: unknown) {
		tools.push(tool as RegisteredOutputTool);
	} } as unknown as ExtensionAPI);
	const registered = tools.find(tool => tool.name === "mainplane_recover_output");
	if (!registered) throw new Error("mainplane_recover_output was not registered by the actual extension");
	return registered;
}
async function withRegisteredOutputFixture<T>(
	transport: typeof fetch,
	run: (tool: RegisteredOutputTool) => Promise<T>,
): Promise<T> {
	const originalURL = process.env.MAINPLANE_BRIDGE_URL;
	const originalKey = process.env.MAINPLANE_API_KEY;
	const stub = spyOn(globalThis, "fetch").mockImplementation(transport);
	process.env.MAINPLANE_BRIDGE_URL = "https://fleet.example/";
	process.env.MAINPLANE_API_KEY = "fixture-key";
	try { return await run(registeredOutputTool()); }
	finally {
		stub.mockRestore();
		if (originalURL === undefined) delete process.env.MAINPLANE_BRIDGE_URL;
		else process.env.MAINPLANE_BRIDGE_URL = originalURL;
		if (originalKey === undefined) delete process.env.MAINPLANE_API_KEY;
		else process.env.MAINPLANE_API_KEY = originalKey;
	}
}
function outputContext(file: string | undefined) {
	return { sessionManager: { getSessionFile: () => file } };
}

describe("registered Mainplane output recovery without execution", () => {
	test("the actual opt-in tool reads owned Unicode pages, preserves failed-run exit and never POSTs", async () => {
		const requests: Array<{ url: string; method: string; redirect: string | undefined; authorization: string | null }> = [];
		const bytesText = "a😀éz";
		const fixtureTransport = transportFor(bytesText);
		const auditedTransport = (async (url: string, init: RequestInit) => {
			requests.push({ url: String(url), method: init.method ?? "", redirect: init.redirect,
				authorization: new Headers(init.headers).get("Authorization") });
			return fixtureTransport(url, init);
		}) as typeof fetch;
		await withRegisteredOutputFixture(auditedTransport, async tool => {
			const first = await tool.execute("display-one", { runId: input.runId, limit: 2 },
				undefined, undefined, outputContext(input.sessionFile));
			expect(first.isError).not.toBe(true);
			const page1 = JSON.parse(first.content[0]!.text);
			expect(page1).toMatchObject({
				text: "a😀", offset: 0, next_offset: 2, retrieval_only: true, execution_exit: 7,
			});
			expect(first.details?.retrieval_only).toBe(true);
			const second = await tool.execute("display-two",
				{ runId: input.runId, offset: 2, limit: 2, outputSha256: page1.output_sha256 },
				undefined, undefined, outputContext(input.sessionFile));
			expect(second.isError).not.toBe(true);
			const page2 = JSON.parse(second.content[0]!.text);
			expect(page2).toMatchObject({
				text: "éz", offset: 2, next_offset: null, retrieval_only: true, execution_exit: 7,
			});
			expect(page2.output_sha256).toBe(page1.output_sha256);
		});
		const receiptRead = { url: "https://fleet.example/fleet/runs/run-fixture", method: "GET",
			redirect: "error", authorization: "Bearer fixture-key" };
		const artifactRead = { ...receiptRead, url: "https://fleet.example/fleet/runs/run-fixture/output" };
		expect(requests).toEqual([receiptRead, artifactRead, receiptRead, artifactRead]);
	});

	test("a missing session, a foreign receipt and an uncertain receipt refuse before output fetch", async () => {
		const absentCalls: string[] = [];
		await withRegisteredOutputFixture(transportFor("private", {}, method => absentCalls.push(method)),
			async tool => {
				const answer = await tool.execute("missing", { runId: input.runId },
					undefined, undefined, outputContext(undefined));
				expect(answer.isError).toBe(true);
				expect(JSON.stringify(answer)).not.toContain("private");
			});
		expect(absentCalls).toEqual([]);

		const foreignCalls: string[] = [];
		await withRegisteredOutputFixture(transportFor("foreign-private", {}, method => foreignCalls.push(method)),
			async tool => {
				const answer = await tool.execute("foreign", { runId: input.runId },
					undefined, undefined, outputContext("/session/foreign"));
				expect(answer.isError).toBe(true);
				expect(JSON.stringify(answer)).not.toContain("foreign-private");
			});
		expect(foreignCalls).toEqual(["GET"]);

		const pending = {
			schema_version: 2, operation: "run", worker: "pc2",
			session: remoteSessionId(input.sessionFile),
			idempotency_sha256: digest(input.runId), request_sha256: "a".repeat(64),
			state: "uncertain",
		};
		const pendingCalls: string[] = [];
		const pendingTransport = (async (url: string, init: RequestInit) => {
			pendingCalls.push(init.method ?? "");
			if (String(url).endsWith("/output")) throw new Error("uncertain receipt must not request output");
			return new Response(JSON.stringify(pending));
		}) as typeof fetch;
		await withRegisteredOutputFixture(pendingTransport, async tool => {
			const answer = await tool.execute("pending", { runId: input.runId },
				undefined, undefined, outputContext(input.sessionFile));
			expect(answer.isError).toBe(true);
		});
		expect(pendingCalls).toEqual(["GET"]);
	});

	test("409/410/503 output failures are errors and never relaunch the original command", async () => {
		for (const status of [409, 410, 503]) {
			const methods: string[] = [];
			const valid = transportFor("ok");
			const unavailable = (async (url: string, init: RequestInit) => {
				methods.push(init.method ?? "");
				if (String(url).endsWith("/output")) {
					return new Response("private-output-unavailable", { status });
				}
				return valid(url, init);
			}) as typeof fetch;
			await withRegisteredOutputFixture(unavailable, async tool => {
				const answer = await tool.execute("unavailable", { runId: input.runId },
					undefined, undefined, outputContext(input.sessionFile));
				expect(answer.isError).toBe(true);
				expect(JSON.stringify(answer)).not.toContain("private-output-unavailable");
			});
			expect(methods).toEqual(["GET", "GET"]);
		}
	});
});
