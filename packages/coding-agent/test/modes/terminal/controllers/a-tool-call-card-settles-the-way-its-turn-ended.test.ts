/**
 * How a tool call's transcript card settles. A turn that ends seals every foreground card still pending and keeps
 * only live background tasks pending; an aborted or failed turn seals its pending foreground cards and a completed
 * one leaves them live; a call about to run drops its argument reveal so a late reveal tick cannot re-truncate the
 * final arguments; a streamed bash call hands its preview the raw partial JSON so inline env assignments show before
 * the JSON closes; a read of an internal URL gets its own card instead of joining the read group, for every scheme
 * the router handles; a read's images inline into the assistant block that issued it only while
 * `terminal.showImages` is on; a new turn forgets the last stated intent; and a resolve that applies a plan approval
 * hands the plan over.
 *
 * WHAT IT DOES NOT CATCH: dropping the anchors of components a rebuild detached is memory-only; no observable
 * output depends on it. The bash env row's exact layout is `bash-view`'s contract.
 *
 * Subject: `modes/terminal/controllers/tool-call-cards.ts`, driven through `ToolCallCards`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "bun:test";
import type { ImageContent, ToolCall } from "@veyyon/ai";
import { setStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InternalUrlRouter } from "@veyyon/coding-agent/internal-urls/router";
import type { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { ReadToolGroupComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/read-tool-group";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { DisplaceableBlocks } from "@veyyon/coding-agent/modes/terminal/controllers/displaceable-blocks";
import type { EventControllerContext } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import { ToolArgsRevealController } from "@veyyon/coding-agent/modes/terminal/controllers/tool-args-reveal";
import { ToolCallCards } from "@veyyon/coding-agent/modes/terminal/controllers/tool-call-cards";
import { SessionProjectionEngine } from "@veyyon/coding-agent/presentation/session-projection-engine";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { INTENT_FIELD } from "@veyyon/wire";

type ToolStart = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;
type ToolEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

const PNG: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.useRealTimers();
	resetSettingsForTest();
});

function createRig(options: { smoothStreaming?: boolean } = {}) {
	const chatContainer = new TranscriptContainer();
	// A card left pending is live and its rail ticks until the card is disposed.
	onTestFinished(() => chatContainer.disposeChildren());
	const working: string[] = [];
	const approvals: unknown[] = [];
	const inlined: { toolCallId: string; images: ImageContent[] }[] = [];
	const issuingBlock = {
		setToolResultImages: (toolCallId: string, images: ImageContent[]) => void inlined.push({ toolCallId, images }),
	} as unknown as AssistantMessageComponent;
	const ctx = {
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		chatContainer,
		effectiveHideThinkingBlock: false,
		ensureLoadingAnimation: () => {},
		handlePlanApproval: async (details: unknown) => void approvals.push(details),
		pendingTools: new Map(),
		proseOnlyThinking: true,
		session: { isAborting: false },
		sessionManager: { getCwd: () => "/repo" },
		setTodos: () => {},
		setWorkingMessage: (message: string) => void working.push(message),
		settings: { get: () => false },
		settledToolCalls: new Set<string>(),
		showWarning: () => {},
		streamingComponent: undefined,
		toolOutputExpanded: false,
		ui: { requestRender: () => {}, requestComponentRender: () => {} },
		viewSession: { isStreaming: false, getToolByName: () => undefined },
	};
	const toolArgsReveal = new ToolArgsRevealController({
		getSmoothStreaming: () => options.smoothStreaming ?? false,
		requestRender: () => {},
	});
	const cards = new ToolCallCards(ctx as unknown as EventControllerContext, {
		projection: new SessionProjectionEngine(),
		toolArgsReveal,
		displaceable: new DisplaceableBlocks(ctx as unknown as EventControllerContext),
		lastAssistantComponent: () => issuingBlock,
	});
	return { approvals, cards, chatContainer, ctx, inlined, toolArgsReveal, working };
}

function toolCall(id: string, name: string, args: Record<string, unknown>, partialJson?: string): ToolCall {
	const call = { type: "toolCall", id, name, arguments: args } as ToolCall;
	if (partialJson !== undefined) setStreamingPartialJson(call, partialJson);
	return call;
}

function rendered(component: { render(width: number): readonly string[] } | undefined): string {
	if (!component) throw new Error("expected a card");
	return Bun.stripANSI(component.render(160).join("\n"));
}

function card(ctx: { pendingTools: Map<string, unknown> }, id: string): ToolExecutionComponent {
	const component = ctx.pendingTools.get(id);
	if (!(component instanceof ToolExecutionComponent)) throw new Error(`expected a tool card for ${id}`);
	return component;
}

/** A `task` call whose result reports its agent still running in the background. */
async function runBackgroundTask(cards: ToolCallCards, id: string): Promise<void> {
	await cards.toolExecutionStarted({
		type: "tool_execution_start",
		toolCallId: id,
		toolName: "task",
		args: {},
	} as ToolStart);
	await cards.toolExecutionEnded({
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "task",
		isError: false,
		result: { content: [{ type: "text", text: "started" }], details: { async: { state: "running", jobId: "j1" } } },
	} as ToolEnd);
}

const PROGRESS = "reviewed 3 of 5 files";

/** Sends a running task a progress update, which only a card that was not sealed draws. */
async function reportProgress(cards: ToolCallCards, id: string): Promise<void> {
	await cards.toolExecutionUpdated({
		type: "tool_execution_update",
		toolCallId: id,
		toolName: "task",
		args: {},
		partialResult: {
			content: [{ type: "text", text: PROGRESS }],
			details: { async: { state: "running", jobId: "j1" } },
		},
	} as Extract<AgentSessionEvent, { type: "tool_execution_update" }>);
}

describe("a turn that ends", () => {
	it("seals each foreground card still pending and marks its call settled", () => {
		const { cards, ctx } = createRig();
		cards.previewStreamingToolCall(toolCall("bash-1", "bash", { command: "ls" }), false, new Set());
		cards.previewStreamingToolCall(toolCall("read-1", "read", { path: "src/a.ts" }), false, new Set());
		const bash = card(ctx, "bash-1");
		const group = ctx.pendingTools.get("read-1");
		expect(group).toBeInstanceOf(ReadToolGroupComponent);

		cards.endTurn();

		expect(bash.isTranscriptBlockFinalized()).toBe(true);
		expect((group as ReadToolGroupComponent).isTranscriptBlockFinalized()).toBe(true);
		expect([...ctx.pendingTools.keys()]).toEqual([]);
		expect([...ctx.settledToolCalls].sort()).toEqual(["bash-1", "read-1"]);
	});

	it("keeps a live background task pending for its later updates", async () => {
		const { cards, ctx } = createRig();
		await runBackgroundTask(cards, "task-1");

		cards.endTurn();
		await reportProgress(cards, "task-1");

		expect([...ctx.pendingTools.keys()]).toEqual(["task-1"]);
		expect(ctx.settledToolCalls.has("task-1")).toBe(false);
		expect(rendered(card(ctx, "task-1"))).toContain(PROGRESS);
	});
});

describe("a turn's pending cards", () => {
	for (const stopReason of ["aborted", "error"] as const) {
		it(`are sealed when the turn stops with ${stopReason}, except a live background task`, async () => {
			const { cards, ctx } = createRig();
			cards.previewStreamingToolCall(toolCall("bash-1", "bash", { command: "ls" }), false, new Set());
			// Mounted last, so the task card stays in the live region once the bash card is sealed above it.
			await runBackgroundTask(cards, "task-1");

			cards.settlePendingToolCalls(stopReason);
			await reportProgress(cards, "task-1");

			expect(card(ctx, "bash-1").isTranscriptBlockFinalized()).toBe(true);
			expect(rendered(card(ctx, "task-1"))).toContain(PROGRESS);
		});
	}

	it("stay live when the turn completes, since their calls still run", () => {
		const { cards, ctx } = createRig();
		cards.previewStreamingToolCall(toolCall("bash-1", "bash", { command: "ls" }), false, new Set());

		cards.settlePendingToolCalls("toolUse");

		expect(card(ctx, "bash-1").isTranscriptBlockFinalized()).toBe(false);
	});
});

describe("a call about to run", () => {
	it("shows its final arguments, and a late reveal tick does not take them back", async () => {
		vi.useFakeTimers();
		const { cards, ctx, toolArgsReveal } = createRig({ smoothStreaming: true });
		const streamed = '{"command":"npm run build && npm';
		cards.previewStreamingToolCall(toolCall("bash-1", "bash", {}, streamed.slice(0, 14)), true, new Set());
		cards.previewStreamingToolCall(toolCall("bash-1", "bash", {}, streamed), true, new Set());

		await cards.toolExecutionStarted({
			type: "tool_execution_start",
			toolCallId: "bash-1",
			toolName: "bash",
			args: { command: "npm run build && npm test" },
		} as ToolStart);
		vi.advanceTimersByTime(2_000);

		expect(rendered(card(ctx, "bash-1"))).toContain("npm run build && npm test");
		toolArgsReveal.stop();
	});
});

describe("a streamed bash call", () => {
	it("shows an inline env assignment that arrived after the last throttled parse of its arguments", () => {
		const { cards, ctx } = createRig();
		// Past the parse-growth threshold the parsed arguments lag the stream, so only the raw prefix holds an
		// env assignment that arrived a few bytes later.
		const head = `{"command":"echo ${"x".repeat(300)}",`;
		cards.previewStreamingToolCall(toolCall("bash-1", "bash", {}, head), false, new Set());
		cards.previewStreamingToolCall(
			toolCall("bash-1", "bash", {}, `${head}"env":{"DEPLOY_STAGE":"canary"`),
			false,
			new Set(),
		);

		expect(rendered(card(ctx, "bash-1"))).toContain("DEPLOY_STAGE");
	});
});

describe("a streamed read", () => {
	it("gets its own card when it targets an internal URL, for every scheme the router handles", () => {
		const schemes = InternalUrlRouter.instance().schemes();
		expect(schemes.length).toBeGreaterThan(0);
		for (const scheme of schemes) {
			const { cards, ctx } = createRig();
			const id = `read-${scheme}`;
			cards.previewStreamingToolCall(toolCall(id, "read", { path: `${scheme}://some/target` }), false, new Set());
			expect([scheme, ctx.pendingTools.get(id) instanceof ToolExecutionComponent]).toEqual([scheme, true]);
		}
	});

	it("joins the read group when it targets a file", () => {
		const { cards, ctx } = createRig();
		cards.previewStreamingToolCall(toolCall("read-1", "read", { path: "src/a.ts" }), false, new Set());
		expect(ctx.pendingTools.get("read-1")).toBeInstanceOf(ReadToolGroupComponent);
	});
});

describe("a read's images", () => {
	for (const showImages of [true, false]) {
		it(`${showImages ? "inline" : "stay out of"} the issuing assistant block while terminal.showImages is ${showImages}`, async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "terminal.showImages": showImages } });
			const { cards, inlined } = createRig();
			await cards.toolExecutionStarted({
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "shot.png" },
			} as ToolStart);
			await cards.toolExecutionEnded({
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				isError: false,
				result: { content: [PNG] },
			} as ToolEnd);

			expect(inlined).toEqual(showImages ? [{ toolCallId: "read-1", images: [PNG] }] : []);
		});
	}
});

describe("a stated intent", () => {
	it("is shown again after a new turn begins, even when it repeats the last turn's", () => {
		const { cards, working } = createRig();
		const content = [toolCall("bash-1", "bash", { [INTENT_FIELD]: "Checking the build", command: "ls" })];
		cards.showStreamedIntent(content);
		cards.showStreamedIntent(content);
		expect(working).toHaveLength(1);

		cards.beginTurn();
		cards.showStreamedIntent(content);

		expect(working).toHaveLength(2);
		expect(working.every(message => message.startsWith("Checking the build"))).toBe(true);
	});
});

describe("a resolve call", () => {
	for (const [action, expected] of [
		["apply", 1],
		["discard", 0],
	] as const) {
		it(`${expected ? "hands" : "does not hand"} the plan over when a plan approval resolves with ${action}`, async () => {
			const { approvals, cards } = createRig();
			const plan = { planFilePath: "local://PLAN.md", title: "ship-parser" };
			await cards.toolExecutionEnded({
				type: "tool_execution_end",
				toolCallId: "resolve-1",
				toolName: "resolve",
				isError: false,
				result: {
					content: [{ type: "text", text: "ok" }],
					details: { sourceToolName: "plan_approval", action, sourceResultDetails: plan },
				},
			} as ToolEnd);

			expect(approvals).toEqual(expected ? [plan] : []);
		});
	}
});
