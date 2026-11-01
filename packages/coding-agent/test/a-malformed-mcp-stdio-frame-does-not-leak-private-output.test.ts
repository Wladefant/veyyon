import { afterEach, expect, it, vi } from "bun:test";
import { logger } from "@veyyon/utils";
import { StdioTransport } from "../src/mcp/transports/stdio";

// WHY: an MCP child's stdout can be JSONL without being a JSON-RPC object.
// The previous read-loop catch wrote both the raw frame and a TypeError that
// could echo that frame to a persistent warning. This synthetic child verifies
// the warning cannot copy private input while a later valid reply still works.
// Gap: this does not authorize or audit normal server stderr diagnostics.
const FAKE_PRIVATE_FRAME = "TEST_ONLY_PRIVATE_MCP_STDIO_CONTENT";

async function withinStdioPhase<T>(work: Promise<T>, phase: string): Promise<T> {
	const timeout = Promise.withResolvers<never>();
	const timer = setTimeout(() => timeout.reject(new Error("Timed out waiting for " + phase)), 5_000);
	try {
		return await Promise.race([work, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

it("drops a non-object JSON-RPC frame without logging its bytes or losing a following valid result", async () => {
	// The child emits one legal JSONL string that is not a JSON-RPC object.
	// It then reads the real request frame and responds using its exact id.
	const program = [
		"process.stdout.write(JSON.stringify(" + JSON.stringify(FAKE_PRIVATE_FRAME) + ") + '\\n');",
		"let buffered = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', chunk => {",
		"  buffered += chunk;",
		"  while (buffered.includes('\\n')) {",
		"    const split = buffered.indexOf('\\n');",
		"    const line = buffered.slice(0, split);",
		"    buffered = buffered.slice(split + 1);",
		"    const request = JSON.parse(line);",
		"    process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:request.id, result:{tools:[]}}) + '\\n');",
		"  }",
		"});",
	].join("\n");
	const transport = new StdioTransport({
		command: process.execPath,
		args: ["--eval", program],
	});
	const warning = Promise.withResolvers<void>();
	const diagnostics: string[] = [];
	vi.spyOn(logger, "warn").mockImplementation((message, context) => {
		if (message !== "Ignored an unreadable message from an MCP server") return;
		diagnostics.push(JSON.stringify({ message, context }));
		warning.resolve();
	});

	try {
		await withinStdioPhase(transport.connect(), "MCP test child startup");
		await withinStdioPhase(warning.promise, "invalid-frame diagnostic");
		const response = await withinStdioPhase(
			transport.request<{ tools: unknown[] }>("tools/list", {}, { timeoutMs: 3_000 }),
			"valid response after invalid frame",
		);
		expect(response).toEqual({ tools: [] });
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toContain("Ignored an unreadable message");
		expect(diagnostics[0]).toContain("Check the server's own logs");
		expect(diagnostics[0]).not.toContain(FAKE_PRIVATE_FRAME);
	} finally {
		await withinStdioPhase(transport.close(), "MCP test child cleanup");
	}
}, 20_000);
