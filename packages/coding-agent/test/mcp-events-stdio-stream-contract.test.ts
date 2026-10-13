import { afterEach, describe, expect, it } from "bun:test";
import { StdioTransport } from "@veyyon/coding-agent/mcp/transports/stdio";

let transport: StdioTransport | undefined;

afterEach(async () => {
	await transport?.close().catch(() => {});
	transport = undefined;
});

describe("MCP stdio streamRequest contract", () => {
	it("routes concurrent notifications by subscription id and drops unknown or missing ids", async () => {
		const script = [
			"const readline = require('node:readline');",
			"const rl = readline.createInterface({ input: process.stdin });",
			"const streams = [];",
			"const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
			"rl.on('line', line => {",
			"  const message = JSON.parse(line);",
			"  if (message.method === 'events/subscribe') {",
			"    const id = message.params._meta['io.modelcontextprotocol/subscriptionId'];",
			"    streams.push(id);",
			"    if (streams.length === 2) {",
			"      for (const streamId of streams) send({ jsonrpc: '2.0', method: 'events/changed', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': streamId }, marker: String(streamId) } });",
			"      send({ jsonrpc: '2.0', method: 'events/changed', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': 'unknown' }, marker: 'unknown' } });",
			"      send({ jsonrpc: '2.0', method: 'events/changed', params: { marker: 'missing' } });",
			"    }",
			"  }",
			"});",
		].join("\n");
		transport = new StdioTransport({ type: "stdio", command: process.execPath, args: ["-e", script] });
		await transport.connect();
		const receivedA: string[] = [];
		const receivedB: string[] = [];
		let resolveBoth: (() => void) | undefined;
		const bothReceived = new Promise<void>(resolve => { resolveBoth = resolve; });
		let streamAId: string | number;
		let streamBId: string | number;
		const a = transport.streamRequest("events/subscribe", {}, message => {
			if ("params" in message && message.params && typeof message.params === "object" && "marker" in message.params) {
				receivedA.push(String(message.params.marker));
				}
			if (receivedA.length === 1 && receivedB.length === 1) resolveBoth?.();
		}, { onRequestId: id => { streamAId = id; } });
		const b = transport.streamRequest("events/subscribe", {}, message => {
			if ("params" in message && message.params && typeof message.params === "object" && "marker" in message.params) {
				receivedB.push(String(message.params.marker));
			}
			if (receivedA.length === 1 && receivedB.length === 1) resolveBoth?.();
		}, { onRequestId: id => { streamBId = id; } });
		try {
			await bothReceived;
			expect(receivedA).toEqual([String(streamAId)]);
			expect(receivedB).toEqual([String(streamBId)]);
			a.cancel();
			b.cancel();
			await Promise.all([a.done, b.done]);
		} finally {
			a.cancel();
			b.cancel();
		}
	});

	it("cancels one stream, settles done, and keeps the other active", async () => {
		const script = [
			"const readline = require('node:readline');",
			"const rl = readline.createInterface({ input: process.stdin });",
			"const streams = [];",
			"const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
			"rl.on('line', line => {",
			"  const message = JSON.parse(line);",
			"  if (message.method === 'events/subscribe') {",
			"    streams.push(message.params._meta['io.modelcontextprotocol/subscriptionId']);",
			"    if (streams.length === 2) for (const id of streams) send({ jsonrpc: '2.0', method: 'events/changed', params: { _meta: { 'io.modelcontextprotocol/subscriptionId': id }, marker: String(id) } });",
			"  }",
			"});",
		].join("\n");
		transport = new StdioTransport({ type: "stdio", command: process.execPath, args: ["-e", script] });
		await transport.connect();
		const receivedA: string[] = [];
		const receivedB: string[] = [];
		let resolveBoth: (() => void) | undefined;
		const bothReceived = new Promise<void>(resolve => { resolveBoth = resolve; });
		const a = transport.streamRequest("events/subscribe", {}, () => receivedA.push("received"));
		const b = transport.streamRequest("events/subscribe", {}, () => {
			receivedB.push("received");
			if (receivedB.length === 1) resolveBoth?.();
		});
		try {
			await bothReceived;
			a.cancel();
			await a.done;
			expect(receivedA).toHaveLength(1);
			expect(receivedB).toHaveLength(1);
			b.cancel();
			await b.done;
		} finally {
			a.cancel();
			b.cancel();
		}
	});
});
