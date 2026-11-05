/**
 * A tool-specific argument repair runs once, in the shared repair cascade, and every consumer of the
 * call receives what it produced.
 *
 * WHY THIS SUITE EXISTS. Two tools repaired a model's mistake inside their own `execute`: `task`
 * decoded a brief the model JSON-escaped twice, and `yield` parsed a `result` wrapper sent as a JSON
 * string. Approval, the `tool_execution_*` events and every hook saw the arguments as sent,
 * `VEYYON_REPAIR_DISABLE` and a harness profile's `repair: false` did not turn either repair off, and
 * nothing listed which tools repaired what. Both are entries of `TOOL_ARGUMENT_REPAIRS` now, which the
 * cascade in `schema-repair.ts` runs before validation.
 *
 * WHAT CLASS THIS CLOSES.
 * - Inventory: the registry's keys are pinned by exact equality and each must be a canonical tool name,
 *   and every entry must have fixtures here, so a new entry turns this red until it joins the sweeps.
 * - Scope: for every fixture of every entry, each value outside the fields the entry declares reaches the
 *   tool as sent, adversarial path-like values included, and the real tool's approval decision (in every
 *   approval mode the setting accepts) and cwd-escaping targets are the same before and after repair.
 * - Purity, idempotence and bounds: an entry never mutates what it was given, repairing its output again
 *   does nothing, a value at the bound is repaired and one past it is left as sent.
 * - Order and ownership: the cascade runs an entry after recovering stringified arguments and renaming a
 *   misspelled field. Through the real agent loop a repaired call reaches `beforeToolCall` and `execute`
 *   once, both holding one arguments object, and runs exactly as the call the model meant; a `yield`
 *   wrapper sent as a string runs exactly as the same wrapper sent as an object; an unrepairable call
 *   reaches neither `beforeToolCall` nor `execute`.
 * - Disable: the environment switch and a harness profile's `repair: false` turn every entry off.
 *
 * WHAT IT DOES NOT CATCH. A repair written inline in some other tool's `execute` is invisible here: the
 * registry inventories only what it holds. The fixtures name the mistakes the entries repair, not every
 * string a model could send. What validation does with a repaired object (the `yield` schema keeps the
 * first `result` branch that matches) is validation's contract, and the same for the object the model
 * could have sent directly.
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	ToolCallRepairResult,
} from "@veyyon/agent-core/types";
import type { Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { resolveApproval } from "@veyyon/coding-agent/tools/core/approval";
import type { ApprovalMode } from "@veyyon/coding-agent/tools/core/approval-modes";
import { TOOL } from "@veyyon/coding-agent/tools/core/builtin-names";
import { cwdEscapingTargets } from "@veyyon/coding-agent/tools/core/cwd-boundary";
import { createRepairToolCallArgumentsHook } from "@veyyon/coding-agent/tools/core/repair/agent-hook";
import { MAX_REPAIR_INPUT_BYTES } from "@veyyon/coding-agent/tools/core/repair/limits";
import { TOOL_ARGUMENT_REPAIRS, type ToolArgumentRepair } from "@veyyon/coding-agent/tools/core/repair/tool-repairs";
import { TempDir } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { constructEveryTool, type EveryToolSweep } from "../helpers/every-tool";

// Every tool in the registry is constructed once; the default 5s budget is below that on a loaded box.
setDefaultTimeout(60_000);

const profile = TempDir.createSync("@tool-argument-repairs-");
let sweep: EveryToolSweep | undefined;

afterAll(() => {
	profile.removeSync();
});

async function realTool(name: string): Promise<AgentTool> {
	sweep ??= await constructEveryTool(profile.path());
	const found = sweep.tools.find(candidate => candidate.name === name);
	if (!found) throw new Error(`the registry built no ${name} tool`);
	return found;
}

function entry(name: string): ToolArgumentRepair {
	const found = TOOL_ARGUMENT_REPAIRS.get(name);
	if (!found) throw new Error(`no registered repair for ${name}`);
	return found;
}

interface Fixture {
	label: string;
	sent: Record<string, unknown>;
	/** What the tool receives after repair; absent when the entry does not apply and the call runs as sent. */
	meant?: Record<string, unknown>;
}

/** A value of `length` code units carrying the double-encode signature at its end. */
function escapedBriefOfLength(length: number): string {
	return `${"x".repeat(length - 4)}\\n\\n`;
}

/** A stringified success wrapper of exactly `length` code units. */
function stringifiedWrapperOfLength(length: number): string {
	const shell = '{"data": ""}';
	return `{"data": "${"x".repeat(length - shell.length)}"}`;
}

const FIXTURES: Record<string, Fixture[]> = {
	// Batch first: the swept `task` tool takes the batch form, which `agent.batch` turns on by default, so
	// the cascade and loop tests below run the first fixture of each entry against the real schema.
	[TOOL.task]: [
		{
			label: "a batch whose shared context and one item's brief are escaped twice",
			sent: {
				context: "shared\\nnotes\\nhere",
				tasks: [
					{ name: "A\\nB\\nC", cwd: "C:\\\\Users\\\\x\\\\y", task: "one\\ntwo\\nthree" },
					{ name: "Beta", task: "clean" },
				],
			},
			meant: {
				context: "shared\nnotes\nhere",
				tasks: [
					{ name: "A\\nB\\nC", cwd: "C:\\\\Users\\\\x\\\\y", task: "one\ntwo\nthree" },
					{ name: "Beta", task: "clean" },
				],
			},
		},
		{
			label: "a flat brief escaped twice, beside a name and a cwd that carry escapes of their own",
			sent: {
				agent: "deep",
				name: "Fix\\nIt\\nNow",
				cwd: "..\\\\..\\\\etc",
				task: '# Target\\nThe loader.\\n\\n# Acceptance\\n\\"tests\\" pass \\u2014 done.',
			},
			meant: {
				agent: "deep",
				name: "Fix\\nIt\\nNow",
				cwd: "..\\\\..\\\\etc",
				task: '# Target\nThe loader.\n\n# Acceptance\n"tests" pass — done.',
			},
		},
		{ label: "a clean brief", sent: { agent: "deep", task: "# Target\nThe loader." } },
		{
			// Escaped three times, or prose quoting `\n` and `\t` of its own, escaped twice: the text is the
			// same either way, so there is no one reading to repair to.
			label: "a brief that would decode twice",
			sent: { task: "split \\\\n and \\\\t apart" },
		},
		{
			label: "a brief at the bound",
			sent: { task: escapedBriefOfLength(MAX_REPAIR_INPUT_BYTES) },
			meant: { task: `${"x".repeat(MAX_REPAIR_INPUT_BYTES - 4)}\n\n` },
		},
		{ label: "a brief past the bound", sent: { task: escapedBriefOfLength(MAX_REPAIR_INPUT_BYTES + 1) } },
	],
	[TOOL.yield]: [
		{
			label: "a success wrapper sent as a JSON string, beside a type that looks like one",
			sent: { result: '{"data": {"path": "..\\\\..\\\\etc", "ok": true}}', type: '{"data": 2}' },
			meant: { result: { data: { path: "..\\..\\etc", ok: true } }, type: '{"data": 2}' },
		},
		{
			label: "a failure wrapper sent as a JSON string",
			sent: { result: '{"error": "nothing reachable"}' },
			meant: { result: { error: "nothing reachable" } },
		},
		{
			label: "a wrapper with trailing commas",
			sent: { result: '  {"data": {"ok": true,},}  ' },
			meant: { result: { data: { ok: true } } },
		},
		{ label: "a result object", sent: { result: { data: { ok: true } } } },
		{ label: "a string that is not JSON", sent: { result: "done" } },
		{ label: "a string that opens like JSON and is not", sent: { result: "{not json" } },
		{ label: "a JSON array", sent: { result: '[{"data": 1}]' } },
		{
			label: "a wrapper at the bound",
			sent: { result: stringifiedWrapperOfLength(MAX_REPAIR_INPUT_BYTES) },
			meant: { result: { data: "x".repeat(MAX_REPAIR_INPUT_BYTES - '{"data": ""}'.length) } },
		},
		{ label: "a wrapper past the bound", sent: { result: stringifiedWrapperOfLength(MAX_REPAIR_INPUT_BYTES + 1) } },
	],
};

/** `args` with every field `fields` declares removed, at the depth the declaration names. */
function outsideDeclaredFields(args: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
	const rest: Record<string, unknown> = { ...args };
	for (const field of fields) {
		const [array, inner] = field.split("[].");
		if (inner === undefined) {
			delete rest[field];
			continue;
		}
		const items = rest[array];
		if (!Array.isArray(items)) continue;
		rest[array] = items.map(item => {
			if (!isRecord(item)) return item;
			const { [inner]: _declared, ...others } = item;
			return others;
		});
	}
	return rest;
}

function every(): [string, ToolArgumentRepair, Fixture][] {
	return Object.entries(FIXTURES).flatMap(([name, fixtures]) =>
		fixtures.map((fixture): [string, ToolArgumentRepair, Fixture] => [name, entry(name), fixture]),
	);
}

describe("the tool argument repair registry", () => {
	it("holds an entry for exactly the tools this suite sweeps, each under its canonical name", () => {
		const registered = [...TOOL_ARGUMENT_REPAIRS.keys()].sort();
		expect(registered).toEqual([TOOL.task, TOOL.yield]);
		expect(Object.keys(FIXTURES).sort()).toEqual(registered);
		const canonical = new Set<string>(Object.values(TOOL));
		expect(registered.filter(name => !canonical.has(name))).toEqual([]);
	});

	it("repairs each fixture to the arguments the model meant, and otherwise does not apply", () => {
		for (const [name, repair, fixture] of every()) {
			const label = `${name}: ${fixture.label}`;
			const before = structuredClone(fixture.sent);
			const result = repair.repair(fixture.sent);
			expect(fixture.sent, label).toEqual(before);
			if (fixture.meant === undefined) {
				expect(result, label).toBeUndefined();
				continue;
			}
			expect(result?.arguments, label).toEqual(fixture.meant);
			// Idempotent: what an entry produced is never repaired again.
			expect(result && repair.repair(result.arguments), label).toBeUndefined();
		}
	});

	it("leaves every value outside an entry's declared fields as the model sent it", () => {
		for (const [name, repair, fixture] of every()) {
			const repaired = repair.repair(fixture.sent)?.arguments ?? fixture.sent;
			expect(outsideDeclaredFields(repaired, repair.fields), `${name}: ${fixture.label}`).toEqual(
				outsideDeclaredFields(fixture.sent, repair.fields),
			);
		}
	});

	it("never changes the real tool's approval decision or the paths it reaches outside the workspace", async () => {
		const modes = SETTINGS_SCHEMA["tools.approvalMode"].values as readonly ApprovalMode[];
		const cwd = profile.path();
		for (const [name, repair, fixture] of every()) {
			if (fixture.meant === undefined) continue;
			const tool = await realTool(name);
			const repaired = repair.repair(fixture.sent)?.arguments;
			const label = `${name}: ${fixture.label}`;
			expect(repaired, label).toEqual(fixture.meant);
			for (const mode of modes) {
				expect(resolveApproval(tool, repaired, mode), `${label} (${mode})`).toEqual(
					resolveApproval(tool, fixture.sent, mode),
				);
			}
			expect(cwdEscapingTargets(tool, repaired, cwd), label).toEqual(cwdEscapingTargets(tool, fixture.sent, cwd));
		}
	});
});

describe("the repair cascade runs the registered entry", () => {
	const mock = createMockModel({ responses: [] });

	function call(name: string, args: unknown): AgentToolCall {
		return { type: "toolCall", id: "call-1", name, arguments: args as Record<string, unknown> };
	}

	it("after recovering stringified arguments and renaming a misspelled field", async () => {
		const hook = createRepairToolCallArgumentsHook(Settings.isolated(), () => mock.model);
		const yieldTool = await realTool(TOOL.yield);
		const outcome = hook(yieldTool, call(TOOL.yield, JSON.stringify({ Result: '{"data": {"ok": true}}' })));
		expect(outcome.status).toBe("repaired");
		expect(outcome.arguments).toEqual({ result: { data: { ok: true } } });
	});

	it("not at all when repair is disabled, by the environment or by the model's harness profile", async () => {
		const profileKey = `${mock.model.provider}/${mock.model.id}`;
		const disabledByProfile = createRepairToolCallArgumentsHook(
			Settings.isolated({ "harness.profiles": { [profileKey]: { repair: false } } }),
			() => mock.model,
		);
		const enabled = createRepairToolCallArgumentsHook(Settings.isolated(), () => mock.model);
		for (const name of TOOL_ARGUMENT_REPAIRS.keys()) {
			const fixture = FIXTURES[name]?.[0];
			if (!fixture?.meant) throw new Error(`the first ${name} fixture must be one the registry repairs`);
			const tool = await realTool(name);
			const outcomes: ToolCallRepairResult[] = [disabledByProfile(tool, call(name, fixture.sent))];
			const previous = process.env.VEYYON_REPAIR_DISABLE;
			process.env.VEYYON_REPAIR_DISABLE = "1";
			try {
				outcomes.push(enabled(tool, call(name, fixture.sent)));
			} finally {
				if (previous === undefined) delete process.env.VEYYON_REPAIR_DISABLE;
				else process.env.VEYYON_REPAIR_DISABLE = previous;
			}

			for (const outcome of outcomes) {
				expect(outcome.status, name).toBe("clean");
				expect(outcome.arguments, name).toEqual(fixture.sent);
			}
			// The control: the same call, with repair on, is repaired.
			expect(enabled(tool, call(name, fixture.sent)).arguments, name).toEqual(fixture.meant);
		}
	});
});

interface Dispatched {
	/** The arguments `beforeToolCall` received, one entry per call that reached it. */
	approved: unknown[];
	/** The arguments `execute` received, one entry per call that reached it. */
	executed: unknown[];
	/** The arguments `tool_execution_start` reported. */
	started: unknown[];
	/** The tool result the model reads next. */
	result: string;
	isError: boolean | undefined;
	details: unknown;
}

/**
 * One turn of the real loop: the provider answers with `args`, the loop repairs with the hook `sdk.ts`
 * installs, validates against the real tool's schema, runs `beforeToolCall`, then `execute`. With
 * `run` set the real tool runs; otherwise a stand-in records what it was given.
 */
async function dispatch(real: AgentTool, args: Record<string, unknown>, run: boolean): Promise<Dispatched> {
	const seen: Dispatched = {
		approved: [],
		executed: [],
		started: [],
		result: "no tool result",
		isError: undefined,
		details: undefined,
	};
	const wrapped: AgentTool = {
		name: real.name,
		label: real.label,
		description: real.description,
		lenientArgValidation: real.lenientArgValidation,
		get parameters() {
			return real.parameters;
		},
		execute: async (id, params, signal, onUpdate, context) => {
			seen.executed.push(params);
			if (run) return real.execute(id, params, signal, onUpdate, context);
			return { content: [{ type: "text", text: "ran" }] };
		},
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [wrapped] };
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
			beforeToolCall: approval => {
				seen.approved.push(approval.args);
				return undefined;
			},
		},
		undefined,
		mock.stream,
	);
	for await (const event of stream) events.push(event);
	for (const event of events) {
		if (event.type === "tool_execution_start") seen.started.push(event.args);
		if (event.type === "tool_execution_end") {
			seen.isError = event.isError;
			seen.details = event.result.details;
		}
		if (event.type === "message_end" && event.message.role === "toolResult") {
			seen.result = event.message.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		}
	}
	return seen;
}

describe("through the agent loop", () => {
	it("a repaired call reaches approval and the tool once, exactly as the call the model meant", async () => {
		const [fixture] = FIXTURES[TOOL.task] ?? [];
		if (!fixture?.meant) throw new Error("the first task fixture must be one the registry repairs");
		const task = await realTool(TOOL.task);
		const repaired = await dispatch(task, fixture.sent, false);
		const meant = await dispatch(task, fixture.meant, false);

		expect(repaired.executed).toHaveLength(1);
		expect(repaired.approved).toHaveLength(1);
		expect(repaired.approved[0]).toBe(repaired.executed[0]);
		expect(repaired.executed).toEqual(meant.executed);
		expect(repaired.started).toEqual(meant.started);
		expect(repaired.result).toBe(meant.result);
	});

	it("a yield wrapper sent as a JSON string runs exactly as the same wrapper sent as an object", async () => {
		const yieldTool = await realTool(TOOL.yield);
		const wrappers: Record<string, unknown>[] = [
			{ data: { ok: true } },
			{ error: "nothing reachable" },
			{ data: { ok: true }, error: "failed" },
			{ data: { nested: { list: [1, 2] } }, extra: "field" },
		];
		for (const wrapper of wrappers) {
			const label = JSON.stringify(wrapper);
			const asObject = await dispatch(yieldTool, { result: wrapper }, true);
			const asString = await dispatch(yieldTool, { result: JSON.stringify(wrapper) }, true);
			expect(asString.approved, label).toEqual(asObject.approved);
			expect(asString.executed, label).toEqual(asObject.executed);
			expect(asString.isError, label).toBe(asObject.isError);
			expect(asString.details, label).toEqual(asObject.details);
			expect(asString.result, label).toBe(asObject.result);
		}
		// The anchor: the success wrapper is a success, not two identical refusals.
		const success = await dispatch(yieldTool, { result: '{"data": {"ok": true}}' }, true);
		expect(success.details).toEqual({ data: { ok: true }, status: "success", error: undefined });
	});

	it("an unrepairable call reaches neither approval nor the tool, and is shown as the model sent it", async () => {
		// Two unknown keys that both read as `context`: no single rename is the one the model meant.
		const sent = { Context: "first", CONTEXT: "second", tasks: [{ task: "work" }] };
		const ran = await dispatch(await realTool(TOOL.task), sent, false);

		expect(ran.approved).toEqual([]);
		expect(ran.executed).toEqual([]);
		expect(ran.started).toEqual([sent]);
		expect(ran.isError).toBe(true);
		expect(ran.result).toContain('all look like aliases for "context"');
	});
});
