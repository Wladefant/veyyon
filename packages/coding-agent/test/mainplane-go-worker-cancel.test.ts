import { describe, expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@veyyon/coding-agent";
import { z } from "zod";
import { cancelRemoteSession, registerMainplaneCancellation } from "../examples/extensions/mainplane-bridge-cancel";
import { digest, mainplaneRequestHash, remoteRunId, remoteSessionId } from "../examples/extensions/mainplane-bridge-wire";

const input = { worker: "pc2", sessionFile: "/current/session", toolCallId: "cancel-one" };
function reply(state = "completed") {
	const session = remoteSessionId(input.sessionFile);
	return { schema_version: 2, operation: "kill", worker: input.worker, session,
		idempotency_sha256: digest(remoteRunId(input.sessionFile, input.toolCallId)),
		request_sha256: mainplaneRequestHash("kill", input.worker, session), state,
		...(state === "completed" ? { exit: 0, output_sha256: digest("") } : {}) };
}

describe("explicit native session cancellation", () => {
	test("derives only the current session and does not retry uncertain acknowledgement", async () => {
		let calls = 0;
		const transport = Object.assign((async (_url: string | URL | Request, init?: RequestInit) => {
			calls++; expect(JSON.parse(String(init?.body)).session).toBe(remoteSessionId(input.sessionFile));
			return new Response(JSON.stringify(reply("uncertain")), { status: 409 });
		}), { preconnect: globalThis.fetch.preconnect });
		const result = await cancelRemoteSession("https://fleet.example/", "fixture-key", input, undefined, transport);
		expect(result.result.state).toBe("uncertain"); expect(result.replayed).toBe(true); expect(calls).toBe(1);
	});
	test("rejects another session's acknowledgement", async () => {
		const transport = Object.assign((async () => new Response(JSON.stringify({ ...reply(), session: "foreign" }))), { preconnect: globalThis.fetch.preconnect });
		await expect(cancelRemoteSession("https://fleet.example/", "fixture-key", input, undefined, transport)).rejects.toThrow("different work");
	});
	test("registered tool cannot be steered by a foreign session argument", async () => {
		let registered: unknown;
		registerMainplaneCancellation({ zod: { z }, registerTool: (tool: unknown) => { registered = tool; } } as unknown as ExtensionAPI);
		const tool = registered as { parameters: { safeParse: (v: unknown) => { success: boolean } }; execute: (...args: unknown[]) => Promise<{ isError: boolean }> };
		expect(tool.parameters.safeParse({ worker: "pc2", session: "foreign" }).success).toBe(false);
		const oldURL = process.env.MAINPLANE_BRIDGE_URL; const oldKey = process.env.MAINPLANE_API_KEY;
		process.env.MAINPLANE_BRIDGE_URL = "https://fleet.example/"; process.env.MAINPLANE_API_KEY = "fixture-key";
		const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign((async (_url: string | URL | Request, init?: RequestInit) => {
			expect(JSON.parse(String(init?.body)).session).toBe(remoteSessionId(input.sessionFile));
			return new Response(JSON.stringify(reply()));
		}), { preconnect: globalThis.fetch.preconnect }));
		try {
			const result = await tool.execute(input.toolCallId, { worker: "pc2", session: "foreign" }, undefined, undefined,
				{ sessionManager: { getSessionFile: () => input.sessionFile } });
			expect(result.isError).toBe(false);
			const missing = await tool.execute(input.toolCallId, { worker: "pc2" }, undefined, undefined,
				{ sessionManager: { getSessionFile: () => undefined } });
			expect(missing.isError).toBe(true); expect(mock).toHaveBeenCalledTimes(1);
		} finally {
			mock.mockRestore();
			if (oldURL === undefined) delete process.env.MAINPLANE_BRIDGE_URL; else process.env.MAINPLANE_BRIDGE_URL = oldURL;
			if (oldKey === undefined) delete process.env.MAINPLANE_API_KEY; else process.env.MAINPLANE_API_KEY = oldKey;
		}
	});
});
