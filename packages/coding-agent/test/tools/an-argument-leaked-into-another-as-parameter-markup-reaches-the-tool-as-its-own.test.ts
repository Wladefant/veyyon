/**
 * An argument a model wrote as parameter markup inside another argument's string reaches the tool as its own
 * argument.
 *
 * WHY THIS SUITE EXISTS. Recorded calls closed one parameter and opened the next inside a JSON string value:
 * `language: 'py</parameter>\n<parameter name="title">crash forensics'`. Validation refused every such eval
 * call (`language must be runtime: …`), and a write whose `content` ended in
 * `</parameter>\n<parameter name="i">Rewriting search manifest` passed validation and wrote the markup into a
 * `Cargo.toml`.
 *
 * WHAT CLASS THIS CLOSES. The repair the agent loop runs before validation splits such a value at the markup
 * and moves each leaked argument into its own field. The sweep builds every registered tool and leaks every
 * argument its wire schema declares, the intent field included, into the first string argument, through the
 * hook `sdk.ts` installs; a tool added later is swept the day it lands. A tool whose wire schema stops
 * declaring a string argument cannot host the leak and lands in `noStringArgument`, pinned by exact equality.
 * The recorded shapes are replayed through the real loop, so the split arguments are also what validation
 * accepts, what `execute` receives and, for `i`, the intent the call is shown with.
 *
 * WHAT IT DOES NOT CATCH. Markup leaked in another shape (a last value that ends in its own closing tag, an
 * `<invoke>` block, another dialect's tags) stays in the value, and so does markup inside a nested string,
 * such as an `ast_edit` op. A value that opens a parameter before the markup, as a document of tool-call
 * examples does, is left whole by design, and so is one naming an
 * argument the call already has. With repair off for the model (`repair: false` in its harness profile, or
 * `VEYYON_REPAIR_DISABLE`) the value reaches validation as sent.
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentMessage, AgentTool, AgentToolCall } from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createRepairToolCallArgumentsHook } from "@veyyon/coding-agent/tools/core/repair/agent-hook";
import { TempDir } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { INTENT_FIELD } from "@veyyon/wire";
import { constructEveryTool, type EveryToolSweep } from "../helpers/every-tool";

// Every tool in the registry is constructed once; the default 5s budget is below that on a loaded box.
setDefaultTimeout(60_000);

const profile = TempDir.createSync("@leaked-parameter-markup-");
let sweep: EveryToolSweep | undefined;

afterAll(() => {
	profile.removeSync();
});

async function everyTool(): Promise<EveryToolSweep> {
	sweep ??= await constructEveryTool(profile.path());
	return sweep;
}

async function tool(name: string): Promise<AgentTool> {
	const found = (await everyTool()).tools.find(candidate => candidate.name === name);
	if (!found) throw new Error(`the registry built no ${name} tool`);
	return found;
}

/** The markup that closes one parameter and opens `name`, as the recorded calls carry it. */
function leak(name: string): string {
	return `</parameter>\n<parameter name="${name}">`;
}

function call(name: string, args: Record<string, unknown>): AgentToolCall {
	return { type: "toolCall", id: "call-1", name, arguments: args };
}

const repair = createRepairToolCallArgumentsHook(Settings.isolated(), () => createMockModel({ responses: [] }).model);

function isStringProperty(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	return schema.type === "string" || (Array.isArray(schema.type) && schema.type.includes("string"));
}

interface Dispatched {
	/** What `execute` received, or undefined when the call never reached it. */
	executed: Record<string, unknown> | undefined;
	/** The intent `tool_execution_start` reported. */
	intent: string | undefined;
	/** The tool result text the model reads next. */
	result: string;
}

/**
 * One turn of the real loop with intent tracing on, as a session runs it: the provider answers with `args`,
 * the loop strips `i`, repairs with the hook `sdk.ts` installs, validates against the real tool's schema and
 * runs a stand-in `execute` that records what it was given.
 */
async function dispatch(real: AgentTool, args: Record<string, unknown>): Promise<Dispatched> {
	let executed: Record<string, unknown> | undefined;
	const recording: AgentTool = {
		name: real.name,
		label: real.label,
		description: real.description,
		// `eval` computes its schema in a getter over `#private` fields, so a spread would lose it.
		get parameters() {
			return real.parameters;
		},
		execute: async (_id, params) => {
			executed = params as Record<string, unknown>;
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [recording] };
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "call-1", name: real.name, arguments: args }] },
			{ content: ["done"] },
		],
	});
	const events: AgentEvent[] = [];
	const stream = agentLoop(
		[{ role: "user", content: "call it" } as AgentMessage],
		context,
		{
			model: mock.model,
			convertToLlm: messages =>
				messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[],
			intentTracing: true,
			repairToolCallArguments: createRepairToolCallArgumentsHook(Settings.isolated(), () => mock.model),
		},
		undefined,
		mock.stream,
	);
	for await (const event of stream) events.push(event);
	let intent: string | undefined;
	let result = "no tool result";
	for (const event of events) {
		if (event.type === "tool_execution_start") intent = event.intent;
		if (event.type === "message_end" && event.message.role === "toolResult") {
			result = event.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		}
	}
	return { executed, intent, result };
}

describe("an argument leaked into another as parameter markup", () => {
	it("runs the recorded eval call with its title as its own argument", async () => {
		const eval_ = await tool("eval");
		const ran = await dispatch(eval_, {
			language: `py${leak("title")}crash forensics`,
			code: "print(1)",
			i: "Counting rows",
		});
		expect(ran.executed).toEqual({ language: "py", title: "crash forensics", code: "print(1)" });
		expect(ran.intent).toBe("Counting rows");
	});

	it("runs the recorded eval call whose code leaked into its language", async () => {
		const eval_ = await tool("eval");
		const code = "import os\nfor name in sorted(os.listdir('.')):\n    print(name)";
		const ran = await dispatch(eval_, { language: `py${leak("code")}${code}`, i: "Listing files" });
		expect(ran.executed).toEqual({ language: "py", code });
	});

	it("writes the recorded file without the markup and shows the leaked intent", async () => {
		const write = await tool("write");
		const content = '[package]\nname = "demo"\nversion = "0.1.0"\n';
		const ran = await dispatch(write, {
			path: "Cargo.toml",
			content: `${content}${leak(INTENT_FIELD)}Rewriting the manifest`,
		});
		expect(ran.executed).toEqual({ path: "Cargo.toml", content });
		expect(ran.intent).toBe("Rewriting the manifest");
	});

	it("moves every declared argument out of the first string argument of every tool", async () => {
		const { tools, unconstructable, notRegistered } = await everyTool();
		const wrong: string[] = [];
		const noStringArgument: string[] = [];
		let checked = 0;
		for (const real of tools) {
			const schema = toolWireSchema(real);
			const properties = isRecord(schema.properties) ? schema.properties : {};
			const declared = Object.keys(properties).filter(name => name !== INTENT_FIELD);
			const host = declared.find(name => isStringProperty(properties[name]));
			if (!host) {
				noStringArgument.push(real.name);
				continue;
			}
			// Every other required string is present, so the call is short of nothing but the leak.
			const required = Array.isArray(schema.required) ? schema.required : [];
			for (const leaked of [...declared.filter(name => name !== host), INTENT_FIELD]) {
				const present = Object.fromEntries(
					declared
						.filter(name => name !== host && name !== leaked)
						.filter(name => required.includes(name) && isStringProperty(properties[name]))
						.map(name => [name, "present"]),
				);
				const outcome = repair(real, call(real.name, { ...present, [host]: `head${leak(leaked)}tail` }));
				const expected = { ...present, [host]: "head", [leaked]: "tail" };
				checked++;
				if (outcome.status !== "repaired" || !isDeepStrictEqual(outcome.arguments, expected)) {
					wrong.push(
						`${real.name}: ${leaked} in ${host} -> ${outcome.status} ${JSON.stringify(outcome.arguments)}`,
					);
				}
			}
		}
		expect(wrong).toEqual([]);
		// A tool the sweep cannot build is a hole in it, not a tool that is safe.
		expect(unconstructable).toEqual([]);
		expect(notRegistered).toEqual([]);
		// These take only arrays, objects, numbers and booleans at the top level; a leak inside a nested string
		// is not split. A tool joining the list is one the sweep stopped covering.
		expect(noStringArgument.sort()).toEqual(["ask", "ast_edit", "job", "retain", "yield"]);
		// The sweep drove something: an empty one satisfies every assertion above.
		expect(checked).toBeGreaterThan(100);
	});

	it("leaves a value whole when the markup is not a clear leak", async () => {
		const write = await tool("write");
		const whole = [
			// A document quoting a call opens a parameter before the markup.
			`<invoke name="write">\n<parameter name="content">x${leak(INTENT_FIELD)}y`,
			// An argument the tool does not declare.
			`x${leak("mode")}y`,
			// An argument the call already has.
			`x${leak("path")}y`,
			// The same argument leaked twice.
			`x${leak(INTENT_FIELD)}y${leak(INTENT_FIELD)}z`,
			// A leaked value holding more markup.
			`x${leak(INTENT_FIELD)}y</parameter>`,
		];
		for (const content of whole) {
			const sent = { path: "a.txt", content };
			expect(repair(write, call("write", sent))).toEqual({ status: "clean", arguments: sent, hints: [] });
		}
		// An argument the first value already supplied, leaked again by a second value.
		const twice = { path: `a.txt${leak(INTENT_FIELD)}x`, content: `y${leak(INTENT_FIELD)}z` };
		expect(repair(write, call("write", twice)).arguments).toEqual({
			path: "a.txt",
			[INTENT_FIELD]: "x",
			content: twice.content,
		});
	});
});
