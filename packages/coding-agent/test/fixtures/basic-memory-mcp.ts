#!/usr/bin/env bun
import * as readline from "node:readline";

type Request = {
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

const EXPECTED_QUERY = "specific orchid lookup";
const NOTE_ID = "notes/orchid";
const NOTE_TEXT = "The account stores orchid seeds in the north shed.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reply(id: string | number, result: unknown): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function toolResult(value: unknown): { content: { type: "text"; text: string }[] } {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function handle(request: Request): void {
	if (request.id === undefined || request.id === null) return;
	switch (request.method) {
		case "initialize":
			reply(request.id, {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "basic-memory-test-fixture", version: "1.0.0" },
			});
			return;
		case "tools/list":
			reply(request.id, {
				tools: ["search_notes", "read_note", "write_note"].map(name => ({
					name,
					description: `Test fixture ${name}`,
					inputSchema: { type: "object", properties: {}, additionalProperties: true },
				})),
			});
			return;
		case "tools/call": {
			const name = request.params?.name;
			const args = request.params?.arguments;
			if (typeof name !== "string" || !isRecord(args)) {
				reply(request.id, { isError: true, content: [{ type: "text", text: "Invalid tool call" }] });
				return;
			}
			if (name === "search_notes") {
				const results =
					args.query === EXPECTED_QUERY ? [{ title: "orchid", external_id: NOTE_ID, file_path: NOTE_ID }] : [];
				reply(request.id, toolResult({ results }));
				return;
			}
			if (name === "read_note" && args.identifier === NOTE_ID) {
				reply(request.id, toolResult({ content: NOTE_TEXT }));
				return;
			}
			reply(request.id, {
				isError: true,
				content: [{ type: "text", text: `Unsupported fixture tool call: ${name}` }],
			});
			return;
		}
		default:
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32601, message: `Unsupported fixture method: ${request.method}` },
				})}\n`,
			);
	}
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", line => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let request: Request;
	try {
		request = JSON.parse(trimmed) as Request;
	} catch {
		return;
	}
	handle(request);
});
