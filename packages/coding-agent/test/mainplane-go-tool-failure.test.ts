import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@veyyon/coding-agent";
import { z } from "zod";
import extension, { mainplaneRequestHash, remoteRunId, remoteSessionId } from "../examples/extensions/mainplane-worker-bridge";

test("registered run tool marks a nonzero remote exit as an error", async () => {
	const tools: unknown[] = [];
	extension({ zod: { z }, registerTool: (tool: unknown) => tools.push(tool) } as unknown as ExtensionAPI);
	const run = tools.find(tool => (tool as { name: string }).name === "mainplane_worker_run") as {
		execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: unknown[] }>;
	};
	const file = "/session/fixture.json";
	const id = remoteRunId(file, "call-one");
	const session = remoteSessionId(file);
	const digest = (s: string) => createHash("sha256").update(s).digest("hex");
	const transport = (async () => new Response(JSON.stringify({ schema_version: 2, operation: "run",
		idempotency_sha256: digest(id), request_sha256: mainplaneRequestHash("run", "pc2", session, "bash", "30", "exit 7"),
		worker: "pc2", session, state: "completed", exit: 7, output_sha256: digest(""), body: "" }))) as typeof fetch;
	const fetchMock = spyOn(globalThis, "fetch").mockImplementation(transport);
	const previousURL = process.env.MAINPLANE_BRIDGE_URL;
	const previousKey = process.env.MAINPLANE_API_KEY;
	process.env.MAINPLANE_BRIDGE_URL = "https://fleet.example/";
	process.env.MAINPLANE_API_KEY = "fixture-key";
	try {
		const result = await run.execute("call-one", { worker: "pc2", interpreter: "bash", code: "exit 7", timeoutSeconds: 30 },
			undefined, undefined, { sessionManager: { getSessionFile: () => file } });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('exit');
		expect(JSON.stringify(result)).not.toContain("fixture-key");
	} finally {
		fetchMock.mockRestore();
		if (previousURL === undefined) delete process.env.MAINPLANE_BRIDGE_URL; else process.env.MAINPLANE_BRIDGE_URL = previousURL;
		if (previousKey === undefined) delete process.env.MAINPLANE_API_KEY; else process.env.MAINPLANE_API_KEY = previousKey;
	}
});
