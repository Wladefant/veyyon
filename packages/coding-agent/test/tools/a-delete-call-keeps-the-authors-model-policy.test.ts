import { expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentTool, BeforeToolCallContext } from "@veyyon/agent-core/types";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { emptyUsage } from "@veyyon/catalog/models";
import { type } from "arktype";
import { checkDeleteAdmission } from "../../src/tools/core/delete-admission";

const dangerous: ReadonlyArray<[string, Record<string, unknown>]> = [
	["bash", { command: "rm synthetic-file.txt" }],
	["bash", { command: "cmd /c rd /s /q synthetic-dir" }],
	["bash", { command: "powershell -Command 'Remove-Item -LiteralPath \"synthetic dir\" -Recurse -Force'" }],
	["launch", { op: "start", application: "pwsh.exe", args: ["-Command", "Remove-Item synthetic-file.txt"] }],
	["edit", { input: "[synthetic-file.txt#ABCD]\nREM\n" }],
	["edit", { path: "synthetic-file.txt", edits: [{ op: "delete" }] }],
	["edit", { path: "synthetic-file.txt", edits: [{ op: "update", rename: "new-name.txt" }] }],
	["apply_patch", { input: "*** Begin Patch\n*** Delete File: synthetic-file.txt\n*** End Patch\n" }],
	["write", { path: "synthetic-file.txt", content: "" }],
	["write", { path: "synthetic.db:rows:7", content: "   " }],
	["ast_edit", { ops: [{ pat: "console.log($$$)", out: "" }] }],
	["rewind", {}],
];

for (const model of ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-xhigh"]) {
	for (const [name, args] of dangerous) {
		it(`blocks ${name} destructive input authored by ${model}: ${JSON.stringify(args)}`, () => {
			const toolCall = { type: "toolCall" as const, id: "call", name, arguments: args };
			const context: BeforeToolCallContext = {
				assistantMessage: {
					role: "assistant",
					api: "mock",
					provider: "google-antigravity",
					model,
					stopReason: "toolUse",
					usage: emptyUsage(),
					timestamp: 0,
					content: [toolCall],
				},
				toolCall,
				args,
				context: { systemPrompt: [], tools: [], messages: [] },
			};
			expect(checkDeleteAdmission(context, process.cwd())).toEqual({
				block: true,
				reason: expect.stringContaining("Report the path to your parent"),
			});
			expect(
				checkDeleteAdmission(
					{ ...context, assistantMessage: { ...context.assistantMessage, model: "gemini-3.8-flash" } },
					process.cwd(),
				),
			).toBeUndefined();
		});
	}
}

it("uses the call author's model even while the active loop routes to Luna", async () => {
	const executed: string[] = [];
	const parameters = type({ command: "string" });
	const tool: AgentTool<typeof parameters> = {
		name: "bash",
		label: "Bash",
		description: "Record execution without starting a shell",
		parameters,
		async execute(id) {
			executed.push(id);
			return { content: [{ type: "text", text: "reached execution" }] };
		},
	};
	const command = { command: "rm synthetic-file.txt" };
	const hydrogen = createMockModel({
		provider: "google-antigravity",
		id: "gemini-4-hydrogen-medium",
		responses: [{ content: [{ type: "toolCall", id: "hydrogen", name: tool.name, arguments: command }] }],
	});
	const luna = createMockModel({
		provider: "openai-codex",
		id: "gpt-6-luna",
		responses: [
			{ content: [{ type: "toolCall", id: "luna", name: tool.name, arguments: command }] },
			{ content: ["done"] },
		],
	});
	let hasQueuedResponse = true;
	const stream = agentLoop(
		[{ role: "user", content: "Try the tool", timestamp: 0 }],
		{ systemPrompt: [], messages: [], tools: [tool] },
		{
			convertToLlm: messages =>
				messages.filter(message => message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
			model: luna.model,
			beforeToolCall: context => checkDeleteAdmission(context, process.cwd()),
		},
		undefined,
		(model, context, options) => {
			if (hasQueuedResponse) {
				hasQueuedResponse = false;
				return hydrogen.stream(hydrogen.model, context, options);
			}
			return luna.stream(model, context, options);
		},
	);
	const results: boolean[] = [];
	for await (const event of stream) {
		if (event.type === "tool_execution_end") results.push(event.isError);
	}
	expect(results).toEqual([true, false]);
	expect(executed).toEqual(["luna"]);
});
