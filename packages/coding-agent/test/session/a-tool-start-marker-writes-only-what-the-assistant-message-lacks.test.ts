/**
 * WHY THIS SUITE EXISTS:
 *
 * Every tool call wrote a `tool_execution_start` marker holding a `startedAt` equal to the entry's own
 * timestamp and a command/path summary of arguments the assistant message beside it already held:
 * about 40% of the marker bytes in recorded sessions. The recorder now writes the time only as the
 * entry timestamp, and the argument summary only when no assistant message on the branch records the
 * call, which is when the resume warning has no other source for it.
 *
 * CLASS: for every branch shape a marker can be appended to (the call recorded by the newest
 * assistant message, recorded behind finished results of its batch, no assistant message at all, a
 * user message after the assistant message, an assistant message that records other calls, a renamed
 * repeat the reader folds into its original, a result already recorded for the call) the pending tool
 * calls read back from the written file equal the ones a marker holding the time and the summary
 * yields, and no written marker holds a `startedAt`.
 *
 * DOES NOT CATCH: a change to how the resume warning reads an assistant message that the recorder's
 * lookup does not follow; both read through the same `appendAssistantToolCalls`, so only a reader
 * that stops using it could split them.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	collectPendingToolCalls,
	describePendingToolCalls,
	summarizeToolArguments,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@veyyon/kernel/session/exit-diagnostics";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

interface Call {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

const MAKE: Call = { id: "call-make", name: "bash", arguments: { command: "make -j8 all" } };
const READ: Call = { id: "call-read", name: "read", arguments: { path: "src/app.ts" } };

function assistant(calls: readonly Call[]): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map(call => ({ type: "toolCall", ...call })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function answer(manager: SessionManager, call: Call): void {
	manager.appendMessage({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	});
}

interface Scenario {
	name: string;
	/** Entries on the branch before `started` begins running. */
	setup(manager: SessionManager): void;
	started: Call;
}

const SCENARIOS: Scenario[] = [
	{
		name: "the newest assistant message records the call",
		setup: manager => manager.appendMessage(assistant([MAKE])),
		started: MAKE,
	},
	{
		name: "the call follows a finished result of its batch",
		setup: manager => {
			manager.appendMessage(assistant([READ, MAKE]));
			manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, { toolCallId: READ.id, toolName: READ.name });
			answer(manager, READ);
		},
		started: MAKE,
	},
	{ name: "no assistant message is on the branch", setup: () => {}, started: MAKE },
	{
		name: "a user message follows the assistant message",
		setup: manager => {
			manager.appendMessage(assistant([MAKE]));
			manager.appendMessage({ role: "user", content: "keep going", timestamp: 3 });
		},
		started: MAKE,
	},
	{
		name: "the newest assistant message records other calls",
		setup: manager => manager.appendMessage(assistant([READ])),
		started: MAKE,
	},
	{
		name: "the call is a renamed repeat the reader folds",
		setup: manager => manager.appendMessage(assistant([MAKE, { ...MAKE, id: `${MAKE.id}_2` }])),
		started: { ...MAKE, id: `${MAKE.id}_2` },
	},
	{
		name: "a result for the call is already recorded",
		setup: manager => {
			manager.appendMessage(assistant([MAKE]));
			answer(manager, MAKE);
		},
		started: MAKE,
	},
];

/** The marker as a session wrote it before this change: the summary and the time in its data. */
function withWholeMarker(branch: readonly SessionEntry[], started: Call): SessionEntry[] {
	return branch.map(entry => {
		if (entry.type !== "custom" || entry.customType !== TOOL_EXECUTION_START_CUSTOM_TYPE) return entry;
		const data = entry.data as { toolCallId: string };
		if (data.toolCallId !== started.id) return entry;
		const args = summarizeToolArguments(started.arguments);
		return { ...entry, data: { ...data, ...(args ? { args } : {}), startedAt: entry.timestamp } };
	});
}

describe("a tool start marker writes only what the assistant message lacks", () => {
	const roots: TempDir[] = [];
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		for (const root of roots.splice(0)) await root.remove();
	});

	/** Record `scenario`'s start through a real session, and return the file's markers and branch. */
	async function run(
		scenario: Scenario,
	): Promise<{ markers: Map<string, Record<string, unknown>>; branch: SessionEntry[] }> {
		const root = TempDir.createSync("@pi-tool-start-marker-");
		roots.push(root);
		const manager = SessionManager.create(root.path(), root.join("sessions"));
		const agent = new Agent({ initialState: { systemPrompt: ["test"], messages: [], tools: [] } });
		const session = new AgentSession({
			agent,
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: {} as never,
		});
		sessions.push(session);

		scenario.setup(manager);
		agent.emitExternalEvent({
			type: "tool_execution_start",
			toolCallId: scenario.started.id,
			toolName: scenario.started.name,
			args: scenario.started.arguments,
		});
		await session.waitForIdle();
		// A branch with no assistant message is not written until something asks for the file.
		await manager.ensureOnDisk();

		const file = manager.getSessionFile() as string;
		const markers = new Map<string, Record<string, unknown>>();
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			if (!line.includes(TOOL_EXECUTION_START_CUSTOM_TYPE)) continue;
			const entry = JSON.parse(line) as { customType?: string; data: Record<string, unknown> };
			if (entry.customType === TOOL_EXECUTION_START_CUSTOM_TYPE)
				markers.set(String(entry.data.toolCallId), entry.data);
		}
		return { markers, branch: (await SessionManager.open(file)).getBranch() };
	}

	it("reads back the pending calls a marker with the time and the summary yields, for every branch shape", async () => {
		for (const scenario of SCENARIOS) {
			const { branch } = await run(scenario);
			const whole = withWholeMarker(branch, scenario.started);
			expect({ scenario: scenario.name, pending: collectPendingToolCalls(branch) }).toEqual({
				scenario: scenario.name,
				pending: collectPendingToolCalls(whole),
			});
			expect({ scenario: scenario.name, warning: describePendingToolCalls(branch) }).toEqual({
				scenario: scenario.name,
				warning: describePendingToolCalls(whole),
			});
		}
	});

	it("writes no start time and writes the summary only where no assistant message records the call", async () => {
		const keepsSummary: string[] = [];
		for (const scenario of SCENARIOS) {
			const { markers } = await run(scenario);
			const written = markers.get(scenario.started.id);
			if (!written) throw new Error(`${scenario.name}: no marker written`);
			expect({ scenario: scenario.name, startedAt: written.startedAt }).toEqual({
				scenario: scenario.name,
				startedAt: undefined,
			});
			const kept = written.args !== undefined;
			expect({ scenario: scenario.name, args: written.args }).toEqual({
				scenario: scenario.name,
				args: kept ? summarizeToolArguments(scenario.started.arguments) : undefined,
			});
			if (kept) keepsSummary.push(scenario.name);
		}
		expect(keepsSummary).toEqual([
			"no assistant message is on the branch",
			"a user message follows the assistant message",
			"the newest assistant message records other calls",
			"the call is a renamed repeat the reader folds",
			"a result for the call is already recorded",
		]);
	});

	it("names the start time a marker from before this change wrote, not its entry timestamp", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistant([MAKE]));
		manager.appendCustomEntry(TOOL_EXECUTION_START_CUSTOM_TYPE, {
			toolCallId: MAKE.id,
			toolName: MAKE.name,
			startedAt: "2026-01-02T03:04:05.000Z",
		});
		expect(collectPendingToolCalls(manager.getBranch())).toEqual([
			{
				toolCallId: MAKE.id,
				toolName: MAKE.name,
				args: MAKE.arguments,
				assistantTimestamp: 1,
				startedAt: "2026-01-02T03:04:05.000Z",
			},
		]);
	});
});
