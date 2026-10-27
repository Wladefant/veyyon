/**
 * WHY THIS SUITE EXISTS. A prompt does not reach the model alone: the session restates the modes it is
 * in, reads the files the prompt names as `@path`, and runs the `before_agent_start` handlers, which
 * add messages and may replace the system prompt for the turn. That input is built by the `TurnInput`
 * session collaborator (`src/session/runtime/turn-input.ts`), and a block dropped, reordered, built
 * while its mode is off, or attributed to the wrong party changes what the model reads with no error
 * anywhere.
 *
 * THE CLASS. Every part of that input, observed on the turn the model receives from a real
 * `AgentSession`: each mode block present exactly while its mode applies and in its fixed order ahead
 * of the prompt; the plan reference sent once; a mentioned file read with the hashline header and
 * recorded in the session's own snapshot store, so a later edit can address it; an extension message
 * after the mentions, keeping the attribution it sets and taking the prompt's when it sets none (the
 * agent's on a turn an unattributed hidden message requested); and
 * the system prompt an extension returns holding for its turn only, with the base restored on the next
 * turn and on a session that loads no extension.
 *
 * WHAT IT DOES NOT CATCH. The image options a mention is read with (`images.autoResize`, the WebP
 * exclusion for a model that cannot decode it) are passed through to the encoder and not observed
 * here; the content of the goal and plan blocks is the business of their own suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { canonicalSnapshotKey, getFileSnapshotStore } from "@veyyon/coding-agent/edit/file-snapshot-store";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { CustomMessage, FileMentionMessage } from "@veyyon/coding-agent/session/messages";
import { formatHashlineHeader } from "@veyyon/hashline";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake, TempDir } from "@veyyon/utils";

const BASE_PROMPT = ["base system prompt"];
const MODE_BLOCKS = ["plan-mode-reference", "plan-mode-context", "goal-mode-context", "vibe-mode-context"];

/** What one `before_agent_start` call returns. */
interface HandlerResult {
	messages?: Array<{ customType: string; content: string; display: boolean; attribution?: "user" | "agent" }>;
	systemPrompt?: string[];
}

interface Harness {
	readonly session: AgentSession;
	readonly mock: MockModel;
	/** The prompt text each `before_agent_start` call received, in call order. */
	readonly handlerPrompts: string[];
}

let tempDir: TempDir;
let session: AgentSession | undefined;
const authStorages: AuthStorage[] = [];

beforeEach(() => {
	tempDir = TempDir.createSync("@turn-input-");
});

afterEach(async () => {
	await session?.dispose();
	session = undefined;
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	await tempDir.remove();
});

/** A registered `edit` tool, which is what turns hashline anchors on for a mentioned file. */
const editTool: AgentTool = {
	name: "edit",
	label: "edit",
	description: "edit",
	parameters: { type: "object", properties: {} },
	execute: async () => ({ content: [{ type: "text", text: "" }] }),
};

/**
 * A session over a mock model. `handlerResults` makes the session load an extension whose
 * `before_agent_start` handler returns one entry per call, in order; omitting it loads no extension.
 */
async function openSession(handlerResults?: HandlerResult[]): Promise<Harness> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
	const mock = createMockModel({ handler: { content: ["done"] } });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: BASE_PROMPT, tools: [] },
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
	authStorages.push(authStorage);
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const handlerPrompts: string[] = [];
	let extensionRunner: ExtensionRunner | undefined;
	if (handlerResults) {
		const results = [...handlerResults];
		const runner = {
			emit: async () => undefined,
			hasHandlers: () => false,
			emitBeforeAgentStart: async (text: string, _images: ImageContent[] | undefined, _system: string[]) => {
				handlerPrompts.push(text);
				return results.shift();
			},
		};
		extensionRunner = runner as unknown as ExtensionRunner;
	}
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		toolRegistry: new Map([[editTool.name, editTool]]),
		extensionRunner,
	});
	return { session, mock, handlerPrompts };
}

/** The messages the turn that answered `text` was built from: everything after the previous answer. */
function turnInput(target: AgentSession, text: string): AgentMessage[] {
	const messages = target.agent.state.messages;
	const promptIndex = messages.findIndex(
		message =>
			message.role === "user" &&
			typeof message.content !== "string" &&
			message.content.some(block => block.type === "text" && block.text === text),
	);
	if (promptIndex < 0) throw new Error(`No user message carries ${JSON.stringify(text)}`);
	let start = promptIndex;
	while (start > 0 && messages[start - 1].role !== "assistant") start--;
	let end = promptIndex + 1;
	while (end < messages.length && messages[end].role !== "assistant") end++;
	return messages.slice(start, end);
}

/** Each message of a turn as one label: the custom type, `fileMention`, or `prompt` for the user message. */
function labels(messages: AgentMessage[], include: readonly string[]): string[] {
	const out: string[] = [];
	for (const message of messages) {
		if (message.role === "custom" && include.includes(message.customType)) out.push(message.customType);
		else if (message.role === "fileMention") out.push("fileMention");
		else if (message.role === "user") out.push("prompt");
	}
	return out;
}

function customOf(messages: AgentMessage[], customType: string): CustomMessage {
	const found = messages.find(
		(message): message is CustomMessage => message.role === "custom" && message.customType === customType,
	);
	if (!found) throw new Error(`The turn carries no ${customType} message`);
	return found;
}

function mentionOf(messages: AgentMessage[]): FileMentionMessage {
	const found = messages.find((message): message is FileMentionMessage => message.role === "fileMention");
	if (!found) throw new Error("The turn carries no file mention");
	return found;
}

describe("the mode blocks a prompt carries", () => {
	it("goal and vibe mode open the prompt in that order, hidden and attributed to the agent", async () => {
		const { session } = await openSession();
		await session.goalRuntime.createGoal({ objective: "Ship the parser rewrite" });
		session.setVibeModeState({ enabled: true });

		await session.prompt("first question");

		const input = turnInput(session, "first question");
		expect(labels(input, MODE_BLOCKS)).toEqual(["goal-mode-context", "vibe-mode-context", "prompt"]);
		for (const customType of ["goal-mode-context", "vibe-mode-context"]) {
			const block = customOf(input, customType);
			expect({ display: block.display, attribution: block.attribution }).toEqual({
				display: false,
				attribution: "agent",
			});
		}
		expect(customOf(input, "goal-mode-context").content).toContain("Ship the parser rewrite");
	});

	it("a block reaches a prompt only while its mode applies", async () => {
		const { session } = await openSession();

		await session.prompt("no modes");
		expect(labels(turnInput(session, "no modes"), MODE_BLOCKS)).toEqual(["prompt"]);

		session.setVibeModeState({ enabled: true });
		await session.prompt("vibe on");
		expect(labels(turnInput(session, "vibe on"), MODE_BLOCKS)).toEqual(["vibe-mode-context", "prompt"]);

		session.setVibeModeState({ enabled: false });
		await session.goalRuntime.createGoal({ objective: "Finish the release" });
		await session.prompt("goal on");
		expect(labels(turnInput(session, "goal on"), MODE_BLOCKS)).toEqual(["goal-mode-context", "prompt"]);

		await session.goalRuntime.pauseGoal();
		await session.prompt("goal paused");
		expect(labels(turnInput(session, "goal paused"), MODE_BLOCKS)).toEqual(["prompt"]);
	});

	it("plan mode's rules lead the goal block, and the approved plan is referenced once after plan mode ends", async () => {
		const { session } = await openSession();
		await fs.writeFile(tempDir.join("PLAN.md"), "# Plan\n\n1. Do the thing\n");
		await session.goalRuntime.createGoal({ objective: "Carry out the plan" });

		session.setPlanModeState({ enabled: true, planFilePath: "PLAN.md" });
		await session.prompt("plan it");
		expect(labels(turnInput(session, "plan it"), MODE_BLOCKS)).toEqual([
			"plan-mode-context",
			"goal-mode-context",
			"prompt",
		]);

		session.setPlanModeState(undefined);
		session.setPlanReferencePath("PLAN.md");
		await session.prompt("build it");
		expect(labels(turnInput(session, "build it"), MODE_BLOCKS)).toEqual([
			"plan-mode-reference",
			"goal-mode-context",
			"prompt",
		]);

		await session.prompt("keep going");
		expect(labels(turnInput(session, "keep going"), MODE_BLOCKS)).toEqual(["goal-mode-context", "prompt"]);
	});

	it("a vibe block delivered outside a prompt is the one a prompt carries", async () => {
		const { session } = await openSession();
		session.setVibeModeState({ enabled: true });
		await session.prompt("vibe turn");
		const carried = customOf(turnInput(session, "vibe turn"), "vibe-mode-context");

		await session.sendVibeModeContext();
		const sent = session.agent.state.messages.at(-1);
		expect(sent?.role === "custom" ? [sent.customType, sent.content, sent.attribution] : sent).toEqual([
			"vibe-mode-context",
			carried.content,
			"agent",
		]);

		session.setVibeModeState(undefined);
		const before = session.agent.state.messages.length;
		await session.sendVibeModeContext();
		await session.sendGoalModeContext();
		expect(session.agent.state.messages.length).toBe(before);
	});
});

describe("the files a prompt mentions", () => {
	it("a mentioned file follows the prompt, anchored and recorded in the session's snapshot store", async () => {
		const { session } = await openSession();
		const file = tempDir.join("notes.txt");
		await fs.writeFile(file, "alpha\nbeta\n");

		await session.prompt("summarize @notes.txt");

		const input = turnInput(session, "summarize @notes.txt");
		expect(labels(input, MODE_BLOCKS)).toEqual(["prompt", "fileMention"]);
		const [mentioned] = mentionOf(input).files;
		const recorded = getFileSnapshotStore(session).head(canonicalSnapshotKey(file));
		if (!recorded) throw new Error("The mention left no snapshot in the session's store");
		expect(mentioned.content.split("\n")[0]).toBe(formatHashlineHeader("notes.txt", recorded.hash));
		expect(recorded.text).toBe("alpha\nbeta\n");
	});

	it("a prompt that mentions no readable file carries no mention", async () => {
		const { session } = await openSession();

		await session.prompt("plain question");
		await session.prompt("read @missing.txt");

		expect(labels(turnInput(session, "plain question"), MODE_BLOCKS)).toEqual(["prompt"]);
		expect(labels(turnInput(session, "read @missing.txt"), MODE_BLOCKS)).toEqual(["prompt"]);
	});
});

describe("the input before_agent_start adds", () => {
	it("an extension's message follows the mentions and keeps the attribution it sets", async () => {
		const { session, handlerPrompts } = await openSession([
			{
				messages: [
					{ customType: "ext-agent", content: "agent note", display: false, attribution: "agent" },
					{ customType: "ext-default", content: "default note", display: false },
				],
			},
			{ messages: [{ customType: "ext-user", content: "user note", display: false, attribution: "user" }] },
		]);
		await fs.writeFile(tempDir.join("spec.md"), "spec\n");

		await session.prompt("check @spec.md");
		const userTurn = turnInput(session, "check @spec.md");
		expect(labels(userTurn, ["ext-agent", "ext-default"])).toEqual([
			"prompt",
			"fileMention",
			"ext-agent",
			"ext-default",
		]);
		expect(customOf(userTurn, "ext-agent").attribution).toBe("agent");
		expect(customOf(userTurn, "ext-default").attribution).toBe("user");

		await session.prompt("internal reminder", { synthetic: true });
		const syntheticTurn = session.agent.state.messages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "ext-user",
		);
		expect(syntheticTurn.map(message => message.attribution)).toEqual(["user"]);
		expect(handlerPrompts).toEqual(["check @spec.md", "internal reminder"]);
	});

	it("an extension's message on a turn an unattributed hidden message requested is the agent's", async () => {
		const { session, mock } = await openSession([
			{ messages: [{ customType: "ext-default", content: "default note", display: false }] },
		]);

		session.queueDeferredMessage({
			role: "custom",
			customType: "requested-turn",
			content: "carry on",
			display: false,
			timestamp: Date.now(),
		});
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(1);
		const added = session.agent.state.messages.filter(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "ext-default",
		);
		expect(added.map(message => message.attribution)).toEqual(["agent"]);
	});

	it("the system prompt an extension returns holds for its turn, and the base returns on the next", async () => {
		const { session, mock } = await openSession([{ systemPrompt: ["extension prompt"] }, {}]);

		await session.prompt("first");
		await session.prompt("second");

		expect(mock.calls.map(call => call.context.systemPrompt)).toEqual([["extension prompt"], BASE_PROMPT]);
	});

	it("a session that loads no extension sends the base system prompt", async () => {
		const { session, mock } = await openSession();
		session.agent.setSystemPrompt(["left over from an earlier turn"]);

		await session.prompt("hello");

		expect(mock.calls.map(call => call.context.systemPrompt)).toEqual([BASE_PROMPT]);
	});
});
