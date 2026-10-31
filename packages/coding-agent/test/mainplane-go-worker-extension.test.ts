import { describe, expect, test } from "bun:test";
import { bridgeOrigin, remoteRunId, runRemote } from "../examples/extensions/mainplane-worker-bridge";

const args = {
	worker: "pc2",
	interpreter: "pwsh",
	code: "Write-Output ok",
	timeoutSeconds: 30,
	sessionFile: "/session/a.json",
	toolCallId: "tool-42",
};

describe("Mainplane Go bridge optional extension", () => {
	test("stable idempotency follows the session and tool call", () => {
		expect(remoteRunId("a", "x")).toBe(remoteRunId("a", "x"));
		expect(remoteRunId("a", "x")).not.toBe(remoteRunId("a", "y"));
		expect(remoteRunId("a", "x")).not.toBe(remoteRunId("b", "x"));
	});

	test("rejects unsafe bridge origins", () => {
		expect(bridgeOrigin("https://harness.example.org/")).toBe("https://harness.example.org");
		expect(bridgeOrigin("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080");
		for (const url of ["http://harness.example.org/", "https://user:password@harness.example.org/",
			"https://harness.example.org/unexpected", "https://harness.example.org/?key=bad"]) {
			expect(() => bridgeOrigin(url)).toThrow();
		}
	});

	test("run invokes the native bridge once with explicit idempotency key", async () => {
		const seen: { input: string; init?: RequestInit }[] = [];
		const transport = (async (input: string, init?: RequestInit) => {
			seen.push({ input, init });
			return new Response(JSON.stringify({ state: "completed", exit: 0, body: "ok" }), { status: 200 });
		}) as typeof fetch;
		const result = await runRemote("https://harness.example.org/", "mp_key_fixture", args, undefined, transport);
		expect(result.replayed).toBe(false);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.init?.method).toBe("POST");
		expect((seen[0]?.init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(result.id);
		expect(JSON.stringify(result)).not.toContain("mp_key_fixture");
	});

	test("a 409 reads the receipt instead of executing a second time", async () => {
		const verbs: string[] = [];
		const transport = (async (_input: string, init?: RequestInit) => {
			verbs.push(init?.method ?? "");
			if (init?.method === "POST") return new Response("", { status: 409 });
			return new Response(JSON.stringify({ state: "submitting", schema_version: 1 }), { status: 200 });
		}) as typeof fetch;
		const result = await runRemote("https://harness.example.org/", "mp_key_fixture", args, undefined, transport);
		expect(result.replayed).toBe(true);
		expect(result.result.state).toBe("submitting");
		expect(verbs).toEqual(["POST", "GET"]);
	});
});
