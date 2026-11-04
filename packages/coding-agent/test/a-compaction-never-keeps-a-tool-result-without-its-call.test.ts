/**
 * WHY: a compaction never keeps a tool result whose call it summarized away.
 *
 * Defect: `set_cwd` appends `prompt_cache_invalidated` and `cwd_changed` custom messages while it
 * runs, so both sit between the assistant's call and the tool's result. The cut-point search treated
 * every custom message as a turn boundary, a compaction cut there, kept the result and summarized the
 * call, and every later request carried a result answering a call missing from the history:
 * `transformMessages` folded it into a note and warned "folding a tool result whose call is missing
 * from the history" on each request until another compaction moved past it.
 *
 * Class: any entry of any kind sitting inside a tool-call window, at any keep-recent budget, reached
 * through the kept tail or through the turn prefix a split cut summarizes (including a turn opened
 * behind a server-side window boundary), and a session that already holds a result separated from its
 * call by an earlier pass. The interloper sweep is typed over the
 * full `SessionEntry` and `AgentMessage` unions, so a new entry kind or message role fails the type
 * check until it is given a builder or an opt-out, and the opt-outs are pinned by exact equality.
 *
 * Gap: a host that rebuilds context from a boundary it chose itself (a branch target picked inside a
 * window) is not covered; only the compaction cut search is. `transformMessages` still folds such a
 * result rather than sending a request the provider rejects. Behind a server-side window boundary the
 * history is on disk, so the turn search there matches a result to the assistant message nearest
 * before it instead of by id: a late result answering an older call is not recognized there.
 */
import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { prepareCompaction } from "@veyyon/agent-core/compaction/compaction";
import { REMOTE_COMPACTION_PRESERVE_KEY } from "@veyyon/agent-core/compaction/remote-compaction-entry";
import { DEFAULT_COMPACTION_SETTINGS } from "@veyyon/agent-core/compaction/threshold";
import { transformMessages } from "@veyyon/ai/providers/transform-messages";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { shellDomain } from "@veyyon/coding-agent/tools/shell/manifest";
import { registerAgentMessageKinds } from "@veyyon/kernel/session/message-kinds";
import { buildSessionContext } from "@veyyon/kernel/session/session-context";
import type { CompactionEntry, SessionEntry } from "@veyyon/kernel/session/session-entries";

// The tool registry registers every domain's message kinds before a session converts a transcript;
// the `!` and `$` roles below convert through the shell domain's kinds.
registerAgentMessageKinds(shellDomain.messageKinds);

const MODEL = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const STAMP = "2026-08-06T00:00:00.000Z";

const zeroUsage = (): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const text = (label: string, words: number) => `${label} ${"lorem ".repeat(words)}`.trim();

const userMessage = (body: string): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text: body }],
	timestamp: 1,
});

const assistantMessage = (content: AssistantMessage["content"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: zeroUsage(),
	stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
	timestamp: 1,
});

const call = (id: string, name: string): ToolCall => ({ type: "toolCall", id, name, arguments: { path: "/repo/a" } });

const resultMessage = (toolCallId: string, toolName: string, body: string): ToolResultMessage => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text: body }],
	isError: false,
	timestamp: 1,
});

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An entry without its tree position; {@link chain} assigns ids and parents in order. */
type Unplaced = DistributiveOmit<SessionEntry, "id" | "parentId" | "timestamp">;

function chain(prefix: string, unplaced: Unplaced[]): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const [index, fields] of unplaced.entries()) {
		const parentId = entries[index - 1]?.id ?? null;
		entries.push({ ...fields, id: `${prefix}-${index}`, parentId, timestamp: STAMP } as SessionEntry);
	}
	return entries;
}

const message = (msg: AgentMessage): Unplaced => ({ type: "message", message: msg });

type EntryKind = Exclude<SessionEntry["type"], "message">;
type MessageRole = AgentMessage["role"];

/**
 * Every entry kind a session can hold between a call and its result. `null` is an opt-out, pinned
 * below: a compaction entry is the start of the range a pass reads, never inside it.
 */
const ENTRY_INTERLOPERS: { [K in EntryKind]: Unplaced | null } = {
	thinking_level_change: { type: "thinking_level_change", thinkingLevel: "high" },
	model_change: { type: "model_change", model: "anthropic/claude-sonnet-4-5" },
	service_tier_change: { type: "service_tier_change", serviceTier: null },
	compaction: null,
	branch_summary: { type: "branch_summary", fromId: "elsewhere", summary: text("branch", 6) },
	custom: { type: "custom", customType: "tool_execution_start" },
	custom_message: {
		type: "custom_message",
		customType: "cwd_changed",
		content: text("working directory is now /repo/b", 6),
		display: true,
	},
	label: { type: "label", targetId: "elsewhere", label: "mark" },
	title_change: { type: "title_change", title: "title", source: "auto" },
	ttsr_injection: { type: "ttsr_injection", injectedRules: [] },
	mcp_tool_selection: { type: "mcp_tool_selection", selectedToolNames: [] },
	session_init: { type: "session_init", systemPrompt: "system", task: "task", tools: [] },
	mode_change: { type: "mode_change", mode: "none" },
	subagent_spawn: {
		type: "subagent_spawn",
		agentId: "agent-1",
		agentName: "task",
		task: "task",
		sessionFile: "/repo/agent-1.jsonl",
		isolation: "none",
		status: "completed",
		exitCode: 0,
		durationMs: 1,
	},
	settings_snapshot: { type: "settings_snapshot", kind: "diff", values: {} },
	session_lifecycle: { type: "session_lifecycle", state: "running", reason: "resumed" },
	session_checkpoint: { type: "session_checkpoint", prefixSequence: 0 },
};

/**
 * Every message role a session can record between a call and its result. A tool result is the
 * window's own closing kind: the sweep's window already holds a second result before the interloper.
 */
const MESSAGE_INTERLOPERS: { [R in MessageRole]: AgentMessage | null } = {
	user: userMessage(text("steer", 6)),
	developer: { role: "developer", content: text("developer note", 6), timestamp: 1 },
	assistant: assistantMessage([{ type: "text", text: text("aside", 6) }]),
	toolResult: null,
	custom: { role: "custom", customType: "cwd_changed", content: text("cwd", 6), display: true, timestamp: 1 },
	hookMessage: { role: "hookMessage", customType: "hook", content: text("hook", 6), display: true, timestamp: 1 },
	branchSummary: { role: "branchSummary", summary: text("branch", 6), fromId: "elsewhere", timestamp: 1 },
	compactionSummary: { role: "compactionSummary", summary: text("summary", 6), tokensBefore: 1, timestamp: 1 },
	fileMention: { role: "fileMention", files: [{ path: "/repo/a", content: text("file", 6) }], timestamp: 1 },
	bashExecution: {
		role: "bashExecution",
		command: "ls",
		output: text("listing", 6),
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	},
	pythonExecution: {
		role: "pythonExecution",
		code: "1",
		output: text("one", 6),
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	},
};

const interlopers: Array<[string, Unplaced]> = [
	...Object.entries(ENTRY_INTERLOPERS).flatMap(
		([kind, entry]): Array<[string, Unplaced]> => (entry ? [[`entry ${kind}`, entry]] : []),
	),
	...Object.entries(MESSAGE_INTERLOPERS).flatMap(
		([role, msg]): Array<[string, Unplaced]> => (msg ? [[`message ${role}`, message(msg)]] : []),
	),
];

/**
 * A session whose middle turn issues two calls and records `interloper` after the first result, inside
 * the window the second result closes. Turns before and after give the cut room on both sides.
 */
function sessionAround(interloper: Unplaced): SessionEntry[] {
	return chain("e", [
		message(userMessage(text("first task", 12))),
		message(assistantMessage([call("call-a", "read")])),
		message(resultMessage("call-a", "read", text("file body", 14))),
		message(assistantMessage([{ type: "text", text: text("read it", 8) }])),
		message(userMessage(text("second task", 10))),
		message(assistantMessage([call("call-b", "read"), call("call-c", "set_cwd")])),
		{ type: "custom", customType: "tool_execution_start" },
		message(resultMessage("call-b", "read", text("other body", 9))),
		interloper,
		message(resultMessage("call-c", "set_cwd", text("cwd changed to /repo/b", 7))),
		message(assistantMessage([call("call-d", "read")])),
		message(resultMessage("call-d", "read", text("third body", 11))),
		message(assistantMessage([{ type: "text", text: text("done", 9) }])),
		message(userMessage(text("third task", 8))),
		message(assistantMessage([{ type: "text", text: text("answer", 10) }])),
	]);
}

/** Ids of tool results in `messages` whose call no assistant message before them declares. */
function resultsWithoutTheirCall(messages: readonly AgentMessage[]): string[] {
	const declared = new Set<string>();
	const orphans: string[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const block of msg.content) if (block.type === "toolCall") declared.add(block.id);
		} else if (msg.role === "toolResult" && !declared.has(msg.toolCallId)) {
			orphans.push(msg.toolCallId);
		}
	}
	return orphans;
}

/** Ids of tool results the provider transform folded into a note instead of sending as results. */
function foldedByTheTransform(messages: AgentMessage[]): string[] {
	const sent = convertToLlm(messages);
	const before = sent.flatMap(msg => (msg.role === "toolResult" ? [msg.toolCallId] : []));
	const after = new Set(
		transformMessages(sent, MODEL).flatMap(msg => (msg.role === "toolResult" ? [msg.toolCallId] : [])),
	);
	return before.filter(id => !after.has(id));
}

interface Outcome {
	firstKeptEntryId: string;
	keptOrphans: string[];
	prefixOrphans: string[];
	folded: string[];
}

/**
 * Compacts `entries` at every keep-recent budget from one token to the whole range and returns one
 * outcome per distinct cut. Each budget crosses at a different entry, so every entry is tried as the
 * place the budget runs out.
 */
function compactAtEveryBudget(entries: SessionEntry[]): Outcome[] {
	const outcomes = new Map<string, Outcome>();
	for (let budget = 1; budget <= 2_000; budget++) {
		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: budget });
		if (!preparation) continue;
		const key = `${preparation.firstKeptEntryId}:${preparation.turnPrefixMessages.length}`;
		if (outcomes.has(key)) continue;
		const compaction: CompactionEntry = {
			type: "compaction",
			id: `compaction-${budget}`,
			parentId: entries[entries.length - 1].id,
			timestamp: STAMP,
			summary: "summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 1,
		};
		const rebuilt = buildSessionContext([...entries, compaction]).messages;
		outcomes.set(key, {
			firstKeptEntryId: preparation.firstKeptEntryId,
			keptOrphans: resultsWithoutTheirCall(preparation.recentMessages),
			prefixOrphans: resultsWithoutTheirCall(preparation.turnPrefixMessages),
			folded: foldedByTheTransform(rebuilt),
		});
	}
	return [...outcomes.values()];
}

describe("a compaction cut never lands inside a tool-call window", () => {
	test("every entry kind and message role is either swept or opted out by name", () => {
		const optedOut = [
			...Object.entries(ENTRY_INTERLOPERS).flatMap(([kind, entry]) => (entry ? [] : [kind])),
			...Object.entries(MESSAGE_INTERLOPERS).flatMap(([role, msg]) => (msg ? [] : [role])),
		];
		expect(optedOut).toEqual(["compaction", "toolResult"]);
	});

	for (const [label, interloper] of interlopers) {
		test(`${label} between a call and its result: no budget keeps the result without its call`, () => {
			const entries = sessionAround(interloper);
			const outcomes = compactAtEveryBudget(entries);
			// The sweep reached cuts on both sides of the window, so the window was actually contested.
			const keptIds = new Set(outcomes.map(outcome => outcome.firstKeptEntryId));
			expect(keptIds.has("e-5")).toBe(true);
			expect(keptIds.has("e-10")).toBe(true);
			for (const outcome of outcomes) {
				expect({ kept: outcome.firstKeptEntryId, orphans: outcome.keptOrphans }).toEqual({
					kept: outcome.firstKeptEntryId,
					orphans: [],
				});
				expect({ kept: outcome.firstKeptEntryId, orphans: outcome.prefixOrphans }).toEqual({
					kept: outcome.firstKeptEntryId,
					orphans: [],
				});
				expect({ kept: outcome.firstKeptEntryId, folded: outcome.folded }).toEqual({
					kept: outcome.firstKeptEntryId,
					folded: [],
				});
			}
		});
	}
});

describe("a set_cwd call followed by the messages it appends while it runs", () => {
	// Minimized from a recorded session: a goal-progress entry closes the previous turn, the assistant
	// calls set_cwd, the tool appends prompt_cache_invalidated and cwd_changed, then its result lands.
	// The pass that broke it kept from the tool_execution_start entry right behind the call.
	const entries = chain("s", [
		message(userMessage(text("audit the service", 20))),
		message(assistantMessage([call("call-1", "read")])),
		message(resultMessage("call-1", "read", text("config body", 30))),
		{ type: "custom", customType: "goal_progress" },
		message(assistantMessage([call("call-2", "set_cwd")])),
		{ type: "custom", customType: "tool_execution_start" },
		{
			type: "custom_message",
			customType: "prompt_cache_invalidated",
			content: "The system prompt changed; the provider prompt cache was invalidated.",
			display: false,
		},
		{
			type: "custom_message",
			customType: "cwd_changed",
			content: "Working directory is now /repo/b.",
			display: true,
		},
		message(resultMessage("call-2", "set_cwd", "Working directory set to /repo/b.")),
		{ type: "custom", customType: "goal_progress" },
		message(assistantMessage([{ type: "text", text: text("continuing in the new directory", 25) }])),
	]);

	test("no budget keeps the set_cwd result without the call, and the provider receives every result", () => {
		const outcomes = compactAtEveryBudget(entries);
		expect(outcomes.map(outcome => outcome.firstKeptEntryId)).not.toContain("s-5");
		expect(outcomes.map(outcome => outcome.firstKeptEntryId)).not.toContain("s-6");
		expect(outcomes.map(outcome => outcome.firstKeptEntryId)).not.toContain("s-7");
		expect(
			outcomes.flatMap(outcome => [...outcome.keptOrphans, ...outcome.prefixOrphans, ...outcome.folded]),
		).toEqual([]);
	});
});

describe("a session an earlier pass already cut inside a window", () => {
	// The state a pre-fix compaction left behind: the assistant ran a read and a set_cwd in parallel, and
	// the pass kept from the tool_execution_start entry behind the calls. The rebuilt context starts with
	// the read's result, the two messages set_cwd appended, and set_cwd's result, both calls summarized.
	// The next pass must cut past those results instead of carrying one forward again.
	const before = chain("h", [
		message(userMessage(text("audit the service", 20))),
		message(assistantMessage([call("call-0", "read"), call("call-1", "set_cwd")])),
		{ type: "custom", customType: "tool_execution_start" },
		message(resultMessage("call-0", "read", text("config body", 12))),
		{
			type: "custom_message",
			customType: "prompt_cache_invalidated",
			content: "The system prompt changed; the provider prompt cache was invalidated.",
			display: false,
		},
		{
			type: "custom_message",
			customType: "cwd_changed",
			content: "Working directory is now /repo/b.",
			display: true,
		},
		message(resultMessage("call-1", "set_cwd", "Working directory set to /repo/b.")),
		{ type: "custom", customType: "goal_progress" },
		message(assistantMessage([{ type: "text", text: text("continuing", 20) }])),
	]);
	const earlier: CompactionEntry = {
		type: "compaction",
		id: "h-compaction",
		parentId: before[before.length - 1].id,
		timestamp: STAMP,
		summary: "summary",
		firstKeptEntryId: "h-2",
		tokensBefore: 1,
	};
	const after = chain("t", [
		message(userMessage(text("next task", 15))),
		message(assistantMessage([call("call-2", "read")])),
		message(resultMessage("call-2", "read", text("file body", 30))),
		message(assistantMessage([{ type: "text", text: text("done", 20) }])),
	]);
	after[0] = { ...after[0], parentId: earlier.id };
	const entries: SessionEntry[] = [...before, earlier, ...after];

	test("the separated results are what the rebuilt context starts from", () => {
		expect(resultsWithoutTheirCall(buildSessionContext(entries).messages)).toEqual(["call-0", "call-1"]);
	});

	test("every budget's next pass summarizes the separated result instead of keeping it", () => {
		const outcomes = compactAtEveryBudget(entries);
		expect(outcomes.length).toBeGreaterThan(0);
		for (const outcome of outcomes) {
			expect({ kept: outcome.firstKeptEntryId, orphans: outcome.keptOrphans, folded: outcome.folded }).toEqual({
				kept: outcome.firstKeptEntryId,
				orphans: [],
				folded: [],
			});
		}
	});
});

describe("a turn split behind a server-side window boundary", () => {
	// A server-side compaction keeps from `w-5`, so the cut may land only from there on, while the turn a
	// split cut summarizes is searched for back to the start of the session. The custom message behind
	// the boundary sits inside call-x's window and must not be taken for the turn's opening.
	const behind = chain("w", [
		message(userMessage(text("first task", 20))),
		message(assistantMessage([call("call-x", "set_cwd")])),
		{ type: "custom", customType: "tool_execution_start" },
		{
			type: "custom_message",
			customType: "cwd_changed",
			content: "Working directory is now /repo/b.",
			display: true,
		},
		message(resultMessage("call-x", "set_cwd", "Working directory set to /repo/b.")),
		message(assistantMessage([call("call-y", "read")])),
		message(resultMessage("call-y", "read", text("file body", 20))),
	]);
	const window: CompactionEntry = {
		type: "compaction",
		id: "w-window",
		parentId: behind[behind.length - 1].id,
		timestamp: STAMP,
		summary: "server-side window",
		firstKeptEntryId: "w-5",
		tokensBefore: 1,
		preserveData: {
			[REMOTE_COMPACTION_PRESERVE_KEY]: {
				version: 1,
				provider: "openai",
				api: "openai-responses",
				model: "gpt-5.1",
				window: [{ type: "compaction", encrypted_content: "opaque" }],
				compactedAt: STAMP,
			},
		},
	};
	const ahead = chain("v", [
		message(assistantMessage([call("call-z", "read")])),
		message(resultMessage("call-z", "read", text("other body", 20))),
		message(assistantMessage([{ type: "text", text: text("done", 20) }])),
	]);
	ahead[0] = { ...ahead[0], parentId: window.id };
	const entries: SessionEntry[] = [...behind, window, ...ahead];

	test("no budget's turn prefix begins inside the window behind the boundary", () => {
		const outcomes = compactAtEveryBudget(entries);
		expect(outcomes.some(outcome => outcome.firstKeptEntryId.startsWith("v-"))).toBe(true);
		for (const outcome of outcomes) {
			expect({ kept: outcome.firstKeptEntryId, orphans: outcome.prefixOrphans }).toEqual({
				kept: outcome.firstKeptEntryId,
				orphans: [],
			});
		}
	});
});
