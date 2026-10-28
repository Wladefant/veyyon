/**
 * A resumed transcript is rebuilt in slices, with the event loop running between them, and the
 * transcript it mounts is the one the synchronous rebuild draws.
 *
 * WHAT THIS CLOSES. A resumed session rebuilt its whole transcript and drew its first frame in one
 * synchronous run before the composer echoed a key: on a 150-prompt session the first keystroke
 * after the composer appeared waited 112–141 ms. `ChatTranscriptBuilder.rebuildInSlices` now builds
 * the rows in a detached container one `TimeSlice` at a time, draws them at the terminal width, and
 * mounts them in one step; `UiHelpers.replayInitialMessages` drives it at launch, and
 * `EventController.deferEventsUntil` holds session events until it mounts.
 *
 * THE CLASS. The sliced replay leaving a state the synchronous rebuild would not:
 *   - a different transcript or tool-call ledger at the end of the replay, whatever slice it was cut
 *     at (the order, the read group, a turn that died, an agent still running in the background,
 *     an unanswered call, a call the previous transcript settled);
 *   - a builder method that reads or changes the transcript, called mid-replay, acting on the
 *     half-built rows instead of finishing the replay first. The sweep enumerates the builder's
 *     prototype, so a method added without a recipe fails until someone records what it does;
 *   - the screen showing a half-built transcript, the startup chat above the transcript, or the
 *     replay never yielding;
 *   - the first slice running in the caller's turn, where it lengthens the startup work that turn
 *     already holds, and a message that calls several tools building every tool's schema in the
 *     one turn that draws its cards;
 *   - a session event routed against the half-built ledger instead of waiting for the replay, and
 *     `resetTranscript` leaving a replay to mount into the chat it cleared.
 *
 * WHAT IT DOES NOT CATCH. How long a slice runs (the clock is driven here) and how fast the replay
 * finishes: both are measured on the shipped binary, not asserted. A caller that writes the chat
 * container directly mid-replay, without going through the builder or `resetTranscript`, keeps its
 * row below the transcript; the suite pins that for one appended row only.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage, UserMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { emptyUsage } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ChatTranscriptBuilder } from "@veyyon/coding-agent/modes/terminal/components/transcript/chat-transcript-builder";
import type { ToolExecutionHandle } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { UiHelpers } from "@veyyon/coding-agent/modes/terminal/utils/ui-helpers";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { type Component, Container, Text, TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import type { CustomBlock } from "@veyyon/wire/presentation";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";

const WIDTH = 120;
const ui = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
	terminal: { columns: WIDTH },
} as unknown as TUI;

const usage = { ...emptyUsage(), input: 10, output: 2, totalTokens: 12 };

function assistant(content: AssistantMessage["content"], stopReason: "stop" | "toolUse" | "error"): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		content,
		stopReason,
		...(stopReason === "error" ? { errorMessage: "stream closed before a finish reason" } : {}),
		timestamp: 2,
	} as AssistantMessage;
}

function toolTurn(id: string, name: string, args: Record<string, unknown>, text: string, details?: unknown) {
	return [
		assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse"),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text }],
			details,
			isError: false,
			timestamp: 3,
		} as AgentMessage,
	];
}

function context(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		models: {},
		injectedTtsrRules: [],
		selectedMCPToolNames: [],
		hasPersistedMCPToolSelection: false,
		mode: "none",
	};
}

/**
 * Every kind of row a rebuild draws, repeated so the replay runs across many slices and draws in
 * several batches: prose, a read group, a command, a change, a written file, a turn that died with
 * its calls unanswered, an agent still running in the background, and a last call with no result.
 */
function session(rounds: number): SessionContext {
	const messages: AgentMessage[] = [];
	for (let round = 0; round < rounds; round++) {
		messages.push({ role: "user", content: `round ${round}: inspect the module`, timestamp: 1 });
		messages.push(assistant([{ type: "text", text: `Looking at round ${round}.` }], "stop"));
		messages.push(
			...toolTurn(`r${round}-read-a`, "read", { path: `src/a${round}.ts` }, `export const a = ${round};`),
		);
		messages.push(
			...toolTurn(`r${round}-read-b`, "read", { path: `src/b${round}.ts` }, `export const b = ${round};`),
		);
		messages.push(
			...toolTurn(`r${round}-bash`, "bash", { command: `grep -rn "round${round}" src` }, `src/a${round}.ts:1:a`),
		);
		messages.push(
			...toolTurn(`r${round}-edit`, "edit", { path: `src/a${round}.ts` }, "Edited 1 file", {
				diff: ` 1|const a = 1;\n-2|const b = ${round};\n+2|const b = ${round + 1};`,
			}),
		);
		messages.push(
			...toolTurn(
				`r${round}-write`,
				"write",
				{ path: `src/c${round}.ts`, content: `export const c = ${round};\n` },
				`wrote src/c${round}.ts`,
			),
		);
		if (round % 4 === 3) {
			messages.push({ role: "user", content: `round ${round}: retry`, timestamp: 1 });
			messages.push(
				assistant(
					[{ type: "toolCall", id: `r${round}-dead`, name: "bash", arguments: { command: "ls" } }],
					"error",
				),
			);
		}
	}
	messages.push(
		...toolTurn("background", "task", { agent: "deep", task: "survey" }, "started", { async: { state: "running" } }),
	);
	messages.push(
		assistant([{ type: "toolCall", id: "unanswered", name: "bash", arguments: { command: "sleep 1" } }], "toolUse"),
	);
	return context(messages);
}

const extra: UserMessage = { role: "user", content: "a message after the replay", timestamp: 9 };
const block: CustomBlock = {
	kind: "custom",
	id: "notice-1",
	customKind: "notice",
	text: "a block after the replay",
	level: "info",
	timestamp: 1_700_000_000_000,
};

beforeAll(async () => {
	resetSettingsForTest();
	// A running agent's card animates its rail on a timer; with transitions off its rows are a
	// function of the transcript alone, whenever they are drawn.
	await Settings.init({ inMemory: true, overrides: { "display.transitions": "off" } });
	await initTheme();
});

/** Rows each test built, disposed after it so no card's timer outlives it. */
const built: TranscriptContainer[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const container of built.splice(0)) container.disposeChildren();
});

interface Subject {
	builder: ChatTranscriptBuilder;
	target: TranscriptContainer;
	pendingTools: Map<string, ToolExecutionHandle>;
	settledToolCalls: Set<string>;
	mounts: number;
	mount: (rows: readonly Component[]) => void;
}

function subject(streaming = false, getTool?: (name: string) => AgentTool | undefined): Subject {
	const target = new TranscriptContainer();
	built.push(target);
	const pendingTools = new Map<string, ToolExecutionHandle>();
	const settledToolCalls = new Set<string>();
	const builder = new ChatTranscriptBuilder({
		ui,
		cwd: process.cwd(),
		requestRender: () => {},
		container: target,
		pendingTools,
		settledToolCalls,
		isStreaming: () => streaming,
		getTool,
	});
	const self: Subject = {
		builder,
		target,
		pendingTools,
		settledToolCalls,
		mounts: 0,
		mount: rows => {
			self.mounts++;
			for (const row of rows) target.addChild(row);
		},
	};
	return self;
}

/** What a subject shows and routes against: its rows at the screen width and both tool-call ledgers. */
function observe(s: Subject) {
	return {
		rows: s.target.render(WIDTH),
		pending: [...s.pendingTools.keys()],
		settled: [...s.settledToolCalls],
	};
}

/** A clock that moves 3 ms on every read, so an 8 ms slice falls due every few items. Returns its restore. */
function driveClock(): () => void {
	let now = 0;
	const spy = vi.spyOn(performance, "now").mockImplementation(() => (now += 3));
	return () => spy.mockRestore();
}

/**
 * What each public builder method does when called while a replay is still building, applied the
 * same way to a builder whose transcript was rebuilt synchronously. `settles` is whether the call
 * mounts the replay before it acts.
 */
const RECIPES: Record<string, { settles: boolean; run: (s: Subject) => unknown }> = {
	rebuild: { settles: true, run: s => s.builder.rebuild(session(1)) },
	rebuildInSlices: { settles: true, run: s => s.builder.rebuildInSlices(session(1), {}, s.mount) },
	settle: { settles: true, run: s => s.builder.settle() },
	append: { settles: true, run: s => s.builder.append([extra]) },
	appendMessage: { settles: true, run: s => s.builder.appendMessage(extra) },
	clearTranscript: { settles: true, run: s => s.builder.clearTranscript() },
	setTranscriptBlocks: { settles: true, run: s => s.builder.setTranscriptBlocks([block]) },
	appendTranscriptBlock: { settles: true, run: s => s.builder.appendTranscriptBlock(block) },
	updateTranscriptBlock: { settles: true, run: s => s.builder.updateTranscriptBlock("absent", { text: "x" }) },
	removeTranscriptBlock: { settles: true, run: s => s.builder.removeTranscriptBlock("absent") },
	reset: { settles: true, run: s => s.builder.reset() },
	dispose: { settles: true, run: s => s.builder.dispose() },
	// Expansion applies to the rows built so far and to every row built after it, so it does not
	// need the replay finished.
	setExpanded: { settles: false, run: s => s.builder.setExpanded(true) },
};

describe("a resumed transcript replays without blocking input", () => {
	for (const streaming of [false, true]) {
		it(`mounts the transcript and ledgers the synchronous rebuild leaves (streaming: ${streaming})`, async () => {
			const input = session(12);
			const reference = subject(streaming);
			// A call the previous transcript settled, which the rebuilt one never made.
			reference.settledToolCalls.add("stale");
			reference.builder.rebuild(input);

			const sliced = subject(streaming);
			sliced.settledToolCalls.add("stale");
			const restoreClock = driveClock();
			let turns = 0;
			const replay = sliced.builder.rebuildInSlices(input, {}, sliced.mount);
			while (sliced.mounts === 0) {
				await nextTurn();
				turns++;
			}
			await replay;
			restoreClock();

			expect(turns).toBeGreaterThan(10);
			expect(sliced.mounts).toBe(1);
			expect(observe(sliced)).toEqual(observe(reference));
			expect(sliced.settledToolCalls.has("stale")).toBe(false);
			expect(sliced.settledToolCalls.has("unanswered")).toBe(!streaming);
			expect(sliced.pendingTools.has("unanswered")).toBe(streaming);
			expect(sliced.pendingTools.has("background")).toBe(true);
		});
	}

	it("keeps the screen on what it showed until the whole transcript mounts in one step", async () => {
		const sliced = subject();
		const startup = new Text("welcome", 0, 0);
		sliced.target.addChild(startup);
		driveClock();
		const replay = sliced.builder.rebuildInSlices(session(6), {}, sliced.mount);
		const seen: Component[][] = [];
		while (sliced.mounts === 0) {
			seen.push([...sliced.target.children]);
			await nextTurn();
		}
		await replay;

		expect(seen.length).toBeGreaterThan(1);
		for (const rows of seen) expect(rows).toEqual([startup]);
		expect(sliced.target.children[0]).toBe(startup);
		expect(sliced.target.children.length).toBeGreaterThan(50);
	});

	it("builds nothing in the caller's turn", async () => {
		// A frozen clock: no slice falls due, so the turn that builds the first slice builds it all.
		vi.spyOn(performance, "now").mockReturnValue(0);
		const sliced = subject();
		const replay = sliced.builder.rebuildInSlices(session(2), {}, sliced.mount);
		expect(sliced.mounts).toBe(0);
		await replay;
		expect(sliced.mounts).toBe(1);
		expect(sliced.target.children.length).toBeGreaterThan(10);
	});

	it("builds each tool schema a message reads in a turn of its own", async () => {
		// The clock moves only while a schema builds, by more than a slice, as an ArkType build does.
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		let turn = 0;
		const builds: { tool: string; turn: number }[] = [];
		const tools = new Map(
			["alpha", "beta", "gamma"].map((name): [string, AgentTool] => {
				let schema: Record<string, unknown> | undefined;
				const tool = {
					name,
					get parameters() {
						if (!schema) {
							builds.push({ tool: name, turn });
							now += 20;
							schema = { type: "object", properties: { path: { type: "string" } } };
						}
						return schema;
					},
				};
				return [name, tool as unknown as AgentTool];
			}),
		);
		const sliced = subject(false, name => tools.get(name));
		const calls = [...tools.keys()].map(name => ({
			type: "toolCall" as const,
			id: `call-${name}`,
			name,
			arguments: { path: `src/${name}.ts` },
		}));
		const replay = sliced.builder.rebuildInSlices(
			context([{ role: "user", content: "inspect", timestamp: 1 }, assistant(calls, "toolUse")]),
			{},
			sliced.mount,
		);
		while (sliced.mounts === 0) {
			await nextTurn();
			turn++;
		}
		await replay;

		expect(builds.map(build => build.tool)).toEqual(["alpha", "beta", "gamma"]);
		expect(new Set(builds.map(build => build.turn)).size).toBe(3);
	});

	it("finishes the replay before any builder call that reads or changes the transcript", async () => {
		const proto = ChatTranscriptBuilder.prototype;
		const methods = Object.getOwnPropertyNames(proto).filter(
			name => name !== "constructor" && typeof Object.getOwnPropertyDescriptor(proto, name)?.value === "function",
		);
		expect(Object.keys(RECIPES).sort()).toEqual(methods.sort());
		expect(
			Object.entries(RECIPES)
				.filter(([, recipe]) => !recipe.settles)
				.map(([name]) => name),
		).toEqual(["setExpanded"]);

		const input = session(8);
		for (const [name, recipe] of Object.entries(RECIPES)) {
			const reference = subject();
			reference.builder.rebuild(input);
			await recipe.run(reference);

			const sliced = subject();
			const restoreClock = driveClock();
			const replay = sliced.builder.rebuildInSlices(input, {}, sliced.mount);
			await nextTurn();
			await nextTurn();
			expect({ name, mounts: sliced.mounts }).toEqual({ name, mounts: 0 });

			const ran = recipe.run(sliced);
			if (recipe.settles) expect({ name, mounts: sliced.mounts }).toEqual({ name, mounts: 1 });
			await ran;
			await replay;
			restoreClock();

			expect({ name, ...observe(sliced) }).toEqual({ name, ...observe(reference) });
		}
	});
});

function welcomeCtx(input: SessionContext, streaming: boolean) {
	const chatContainer = new TranscriptContainer();
	built.push(chatContainer);
	const welcome = new Text("welcome", 0, 0);
	chatContainer.addChild(welcome);
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingPythonComponents: [],
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), terminal: { columns: WIDTH } },
		settings: { get: () => false },
		toolOutputExpanded: false,
		focusedAgentId: undefined,
		noteDisplayableThinkingContent: () => false,
		editor: { seedHistory: vi.fn() },
		showStatus: vi.fn(),
		viewSession: {
			isStreaming: streaming,
			buildTranscriptSessionContext: () => input,
			getToolByName: () => undefined,
			extensionRunner: undefined,
			sessionManager: { getEntries: () => [], getCwd: () => process.cwd(), putBlobSync: vi.fn() },
		},
	} as unknown as InteractiveModeContext;
	return { ctx, chatContainer, welcome, helpers: new UiHelpers(ctx) };
}

describe("UiHelpers.replayInitialMessages", () => {
	it("draws the transcript above the startup chat, and a row shown mid-replay below it", async () => {
		const input = session(4);
		const { chatContainer, welcome, helpers } = welcomeCtx(input, false);
		const reference = subject();
		reference.builder.rebuild(input);
		const transcriptRows = reference.target.children.length;

		driveClock();
		const replay = helpers.replayInitialMessages();
		await nextTurn();
		expect(chatContainer.children).toEqual([welcome]);
		const late = new Text("shown mid-replay", 0, 0);
		chatContainer.addChild(late);
		await replay;

		const children = chatContainer.children;
		expect(children.length).toBe(transcriptRows + 2);
		expect(children.slice(-2)).toEqual([welcome, late]);
		const transcript = [...reference.target.render(WIDTH)];
		expect(chatContainer.render(WIDTH).slice(0, transcript.length)).toEqual(transcript);
	});

	it("replays a session that is already streaming before it returns to the event loop", async () => {
		const { chatContainer, welcome, helpers } = welcomeCtx(session(4), true);
		driveClock();
		const replay = helpers.replayInitialMessages();
		expect(chatContainer.children.length).toBeGreaterThan(1);
		expect(chatContainer.children.at(-1)).toBe(welcome);
		await replay;
	});
});

function eventCtx() {
	const chat: AgentMessage[] = [];
	const addMessageToChat = (message: AgentMessage): void => {
		chat.push(message);
	};
	const ctx = {
		isInitialized: true,
		statusLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		editor: { setText: vi.fn(), getText: () => "" },
		addMessageToChat,
		updatePendingMessagesDisplay: vi.fn(),
		getUserMessageText: (message: UserMessage) => (typeof message.content === "string" ? message.content : ""),
		optimisticUserMessageSignature: undefined,
		locallySubmittedUserSignatures: new Set<string>(),
		clearOptimisticUserMessage: vi.fn(),
		replaceOptimisticUserMessage: vi.fn(),
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
		viewSession: { isStreaming: false },
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), chat };
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, attribution: "user", timestamp: 1 };
}

describe("EventController.deferEventsUntil", () => {
	for (const outcome of ["resolves", "rejects"] as const) {
		it(`holds session events, in order, until the replay ${outcome === "resolves" ? "mounts" : "fails"}`, async () => {
			const { controller, chat } = eventCtx();
			const replay = Promise.withResolvers<void>();
			controller.deferEventsUntil(replay.promise);
			const first = userMessage("first");
			const second = userMessage("second");
			const handled = [
				controller.handleEvent({ type: "message_start", message: first }),
				controller.handleEvent({ type: "message_start", message: second }),
			];
			await nextTurn();
			await nextTurn();
			expect(chat).toEqual([]);

			if (outcome === "resolves") replay.resolve();
			else replay.reject(new Error("replay failed"));
			await Promise.all(handled);
			expect(chat).toEqual([first, second]);

			// Released for good: a later event is handled without waiting on anything.
			const third = userMessage("third");
			await controller.handleEvent({ type: "message_start", message: third });
			expect(chat.at(-1)).toBe(third);
		});
	}
});

describe("InteractiveMode.replayInitialMessages", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let agentSession: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	afterEach(async () => {
		mode?.stop();
		await agentSession?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		agentSession = undefined;
		authStorage = undefined;
		tempDir = undefined;
	});

	/** A mode up over a session of `turns` resumed exchanges, its transcript not yet replayed. */
	async function resumed(turns: number): Promise<InteractiveMode> {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@veyyon-sliced-replay-");
		const dir = tempDir.path();
		await Settings.init({ inMemory: true, cwd: dir, overrides: { "display.transitions": "off" } });
		authStorage = await AuthStorage.create(path.join(dir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		agentSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(dir, dir),
			settings: Settings.isolated(),
			modelRegistry,
		});
		for (let turn = 0; turn < turns; turn++) {
			agentSession.sessionManager.appendMessage({ role: "user", content: `resumed question ${turn}`, timestamp: 1 });
			agentSession.sessionManager.appendMessage(
				assistant([{ type: "text", text: `resumed answer ${turn}` }], "stop"),
			);
		}
		mode = new InteractiveMode(agentSession, "test");
		mode.ui = new TUI(new VirtualTerminal(WIDTH, 30, 2_000));
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		return mode;
	}

	function shown(m: InteractiveMode): string {
		return Bun.stripANSI(m.chatContainer.render(WIDTH).join("\n"));
	}

	it("holds a session event that arrives mid-replay until the transcript mounts above it", async () => {
		const m = await resumed(60);
		const restoreClock = driveClock();
		const replay = m.replayInitialMessages({ clearTerminalHistory: false });
		const late = userMessage("sent while the transcript replayed");
		const handled = m.eventController.handleEvent({ type: "message_start", message: late });
		await nextTurn();
		expect(shown(m)).not.toContain("resumed question 0");
		expect(shown(m)).not.toContain("sent while the transcript replayed");

		await replay;
		await handled;
		restoreClock();
		const rows = shown(m);
		expect(rows.indexOf("resumed answer 59")).toBeGreaterThan(-1);
		expect(rows.indexOf("sent while the transcript replayed")).toBeGreaterThan(rows.indexOf("resumed answer 59"));
	});

	it("mounts nothing once resetTranscript discards a replay still building", async () => {
		const m = await resumed(60);
		const restoreClock = driveClock();
		const replay = m.replayInitialMessages({ clearTerminalHistory: false });
		await nextTurn();
		expect(shown(m)).not.toContain("resumed question 0");

		m.resetTranscript();
		await replay;
		restoreClock();
		expect(shown(m)).not.toContain("resumed question");
	});
});
