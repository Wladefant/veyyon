/**
 * Benchmark: the tool-call repair cascade on the calls a session sends most, which are clean.
 *
 * Every tool call passes through `repairToolCallArguments` before validation. A clean call is the
 * normal path, so the cascade's cost there is paid on every call of every turn; a repaired call is
 * the rare path. The run reports both, per call, for the same corpus and the same seedless inputs,
 * so two runs on one machine compare.
 *
 * Run: bun packages/coding-agent/bench/tool-call-repair.bench.ts
 */

import type { Tool, ToolCall } from "@veyyon/ai/types";
import { repairToolCallArguments } from "@veyyon/coding-agent/tools/core/repair/schema-repair";
import { makeBench } from "@veyyon/utils/bench-harness";

const ITERATIONS = 200_000;
const bench = makeBench(ITERATIONS, { warmup: 20_000 });

function tool(name: string, properties: Record<string, unknown>, required: string[]): Tool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties, required, additionalProperties: false },
	} as Tool;
}

const str = { type: "string" };
const TOOLS: Record<string, Tool> = {
	read: tool("read", { path: str, i: str }, ["path"]),
	bash: tool("bash", { command: str, cwd: str, timeout: { type: "number" }, i: str }, ["command"]),
	edit: tool("edit", { input: str, i: str }, ["input"]),
	search: tool("search", { type: str, input: str, path: str, i: str }, ["type", "input"]),
	task: tool("task", { agent: str, name: str, task: str, context: str, i: str }, ["task"]),
	yield: tool("yield", { result: { type: "object" }, type: str }, ["result"]),
};

function call(name: string, args: Record<string, unknown>): { tool: Tool; call: ToolCall } {
	const found = TOOLS[name];
	if (!found) throw new Error(`no bench tool ${name}`);
	return { tool: found, call: { type: "toolCall", id: `call-${name}`, name, arguments: args } };
}

const CLEAN = [
	call("read", { path: "src/session/agent-session.ts:120-180", i: "Reading session" }),
	call("bash", { command: "git status --short", timeout: 30, i: "Checking status" }),
	call("edit", { input: "[src/a.ts#1A2B]\nSWAP 3.=3:\n+const x = 1;", i: "Editing" }),
	call("search", { type: "text", input: "TODO|FIXME", path: "src", i: "Searching" }),
	call("task", {
		agent: "deep",
		name: "Worker",
		task: "# Target\nRefactor the loader.\n\n# Acceptance\nTests pass.",
		i: "Delegating",
	}),
	call("yield", { result: { data: { ok: true, findings: [] } } }),
];

const REPAIRED = [
	call("read", { filepath: "src/a.ts", i: "Reading" }),
	call("task", { agent: "deep", task: "# Target\\nRefactor the loader.\\n\\n# Acceptance\\nTests \\u2014 pass." }),
	call("yield", { result: '{"data": {"ok": true, "findings": []}}' }),
];

let sink = 0;
function runAll(corpus: readonly { tool: Tool; call: ToolCall }[]): void {
	for (const entry of corpus) {
		const outcome = repairToolCallArguments(entry.tool, entry.call);
		sink += outcome.status.length;
	}
}

console.log(`\nBenchmark: tool-call repair (${ITERATIONS} iterations per corpus)\n`);
const cleanMs = bench(`clean corpus    (${CLEAN.length} calls)`, () => runAll(CLEAN));
const repairedMs = bench(`repaired corpus (${REPAIRED.length} calls)`, () => runAll(REPAIRED));
const nsPerClean = (cleanMs * 1e6) / (ITERATIONS * CLEAN.length);
const nsPerRepaired = (repairedMs * 1e6) / (ITERATIONS * REPAIRED.length);
console.log(`\n  clean    ${nsPerClean.toFixed(1)} ns/call`);
console.log(`  repaired ${nsPerRepaired.toFixed(1)} ns/call`);
if (sink === 0) console.log("(no outcomes)");
