import { expect, it } from "bun:test";
import { StdioTransport } from "../src/mcp/transports/stdio";

// WHY: a child can echo a request id with a malformed JSON-RPC envelope.
// That does not establish successful tool delivery, nor a successful event
// subscription. Only the external child is synthetic: parsing and pending
// request resolution run through the production StdioTransport.
// Gap: this does not qualify an installed MCP provider or host.
async function phase<T>(work: Promise<T>, label: string): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Error("Timed out waiting for " + label)), 5_000);
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function createChild(mode: string): StdioTransport {
	const program = [
		"const mode = " + JSON.stringify(mode) + ";",
		"let buffer = '';",
		"let requests = 0;",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', chunk => {",
		"  buffer += chunk;",
		"  while (buffer.includes('\\n')) {",
		"    const index = buffer.indexOf('\\n');",
		"    const line = buffer.slice(0, index);",
		"    buffer = buffer.slice(index + 1);",
		"    const request = JSON.parse(line);",
		"    if (!Object.hasOwn(request, 'id')) continue;",
		"    requests++;",
		"    const id = request.id;",
		"    let reply = { jsonrpc: '2.0', id, result: { tools: [] } };",
		"    if (requests === 1) {",
		"      if (mode === 'wrong-version') reply = { jsonrpc: '1.0', id, result: { tools: [] } };",
		"      else if (mode === 'missing-branches') reply = { jsonrpc: '2.0', id };",
		"      else if (mode === 'both-branches') reply = { jsonrpc: '2.0', id, result: {}, error: {code:-32603,message:'failed'} };",
		"      else if (mode === 'null-error') reply = { jsonrpc: '2.0', id, error: null };",
		"      else if (mode === 'bad-error-code') reply = { jsonrpc: '2.0', id, error: {code:'-32603',message:'failed'} };",
		"      else if (mode === 'no-error-message') reply = { jsonrpc: '2.0', id, error: {code:-32603} };",
		"      else if (mode === 'null-result') reply = { jsonrpc:'2.0', id, result:null };",
		"      else if (mode === 'valid-error') reply = { jsonrpc:'2.0', id, error:{code:-32601,message:'Synthetic method unavailable'} };",
		"    }",
		"    process.stdout.write(JSON.stringify(reply) + '\\n');",
		"  }",
		"});",
	].join("\n");
	return new StdioTransport({ type: "stdio", command: process.execPath, args: ["--eval", program] });
}

it("rejects matching-id malformed stdio envelopes, then accepts the next valid tool response", async () => {
	const modes = [
		"wrong-version",
		"missing-branches",
		"both-branches",
		"null-error",
		"bad-error-code",
		"no-error-message",
	];
	for (const mode of modes) {
		const transport = createChild(mode);
		try {
			await phase(transport.connect(), mode + " child startup");
			await expect(
				phase(transport.request("tools/list", {}, { timeoutMs: 3_000 }), mode + " refusal"),
			).rejects.toThrow("invalid JSON-RPC response envelope");
			await expect(
				phase(transport.request("tools/list", {}, { timeoutMs: 3_000 }), mode + " next valid reply"),
			).resolves.toEqual({ tools: [] });
		} finally {
			await phase(transport.close(), mode + " child cleanup");
		}
	}
}, 40_000);

it("preserves a real stdio null result and a valid server error", async () => {
	for (const mode of ["null-result", "valid-error"]) {
		const transport = createChild(mode);
		try {
			await phase(transport.connect(), mode + " startup");
			const first = phase(transport.request("tools/list", {}, { timeoutMs: 3_000 }), mode + " response");
			if (mode === "null-result") await expect(first).resolves.toBeNull();
			else await expect(first).rejects.toThrow("MCP error -32601: Synthetic method unavailable");
			await expect(
				phase(transport.request("tools/list", {}, { timeoutMs: 3_000 }), mode + " following valid"),
			).resolves.toEqual({ tools: [] });
		} finally {
			await phase(transport.close(), mode + " cleanup");
		}
	}
}, 15_000);

it("refuses a malformed stdio event-stream acknowledgement without completing its subscription", async () => {
	const transport = createChild("missing-branches");
	try {
		await phase(transport.connect(), "stream child startup");
		const stream = transport.streamRequest("events/subscribe", { name: "synthetic" }, () => {});
		await expect(phase(stream.done, "malformed stream acknowledgement")).rejects.toThrow(
			"invalid JSON-RPC response envelope",
		);
		await expect(
			phase(transport.request("tools/list", {}, { timeoutMs: 3_000 }), "following valid stdio reply"),
		).resolves.toEqual({ tools: [] });
	} finally {
		await phase(transport.close(), "stream child cleanup");
	}
}, 12_000);
