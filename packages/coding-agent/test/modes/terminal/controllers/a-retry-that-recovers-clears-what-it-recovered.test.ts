/**
 * How a turn shows its recovery. An auto-compaction loader states why it started and offers Esc only while Esc
 * cancels it; a compaction that produced a summary rebuilds the transcript; a retry that recovers marks each
 * superseded error block as recovered and clears the pinned banner, whether or not the recovered error carries the
 * block's persistence key; a retry that fails leaves the banner and the error in place; and the working loader comes
 * back once a retry ends mid-stream.
 *
 * The compaction reasons are a typed table over the event's `reason` union, so a new reason fails type checking
 * until it has an expected prefix.
 *
 * WHAT IT DOES NOT CATCH: the retry countdown's own text, which `retry-display` tests own, and the projection's
 * retry summary wording. Stopping the retry loader explicitly is equivalent to disposing the status container's
 * children on this path, so dropping either one alone stays green here.
 *
 * Subject: `modes/terminal/controllers/turn-recovery.ts`, driven through `TurnRecovery`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { RecoveredRetryError } from "@veyyon/coding-agent/extensibility/shared-events";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import type { ComposerPredictionController } from "@veyyon/coding-agent/modes/terminal/controllers/composer-prediction-controller";
import type { EventControllerContext } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { IdleFollowUps } from "@veyyon/coding-agent/modes/terminal/controllers/idle-follow-ups";
import { TurnRecovery } from "@veyyon/coding-agent/modes/terminal/controllers/turn-recovery";
import { SessionProjectionEngine } from "@veyyon/coding-agent/presentation/session-projection-engine";
import { compactionActionLabel } from "@veyyon/coding-agent/presentation/summary-builder";
import { toAssistantMessageView } from "@veyyon/coding-agent/presentation/transcript-builder";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { Container, type Loader } from "@veyyon/tui";

type CompactionStart = Extract<AgentSessionEvent, { type: "auto_compaction_start" }>;
type CompactionEnd = Extract<AgentSessionEvent, { type: "auto_compaction_end" }>;
type RetryStart = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type RetryEnd = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

/** What the compaction loader prefixes to its action label, per start reason. */
const REASON_PREFIX: Record<CompactionStart["reason"], string> = {
	threshold: "",
	overflow: "Context overflow detected, ",
	incomplete: "Response incomplete, ",
	idle: "Idle ",
	provider_switch: "Provider switch, ",
};

const ERROR_TEXT = "Provider stream stalled while waiting for the next event";
const RECOVERY_NOTE = "retried after a stalled stream";

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	resetSettingsForTest();
});

function createRig(options: { focusedAgentId?: string; streaming?: boolean } = {}) {
	const log: string[] = [];
	const progress: boolean[] = [];
	const ctx = {
		autoCompactionLoader: undefined as Loader | undefined,
		retryLoader: undefined as Loader | undefined,
		lastAssistantUsage: { input: 1 } as unknown,
		focusedAgentId: options.focusedAgentId,
		clearPinnedError: () => log.push("banner:clear"),
		clearWorkingLoader: () => false,
		ensureLoadingAnimation: () => log.push("working:show"),
		flushCompactionQueue: async () => {},
		rebuildChatFromMessages: () => log.push("chat:rebuild"),
		refreshComposerShortcuts: () => {},
		settings: { get: () => undefined },
		showError: (message: string) => log.push(`error:${message}`),
		showPinnedError: (message: string) => log.push(`banner:${message}`),
		showStatus: (message: string) => log.push(`status:${message}`),
		showWarning: (message: string) => log.push(`warning:${message}`),
		statusContainer: new Container(),
		statusLine: { invalidate: () => {} },
		ui: { requestRender: () => {}, requestComponentRender: () => {} },
		viewSession: { isStreaming: options.streaming ?? false, settings: { get: () => undefined }, model: undefined },
	};
	const recovery = new TurnRecovery(ctx as unknown as EventControllerContext, {
		projection: new SessionProjectionEngine(),
		idle: { cancel: () => {} } as unknown as IdleFollowUps,
		composerPrediction: { cancel: () => {} } as unknown as ComposerPredictionController,
		setTerminalProgress: active => void progress.push(active),
	});
	return { ctx, log, progress, recovery };
}

/** The loader's message, with the spinner frame in front of it dropped. */
function loaderMessage(loader: Loader | undefined): string {
	if (!loader) throw new Error("expected a loader in the status area");
	const words = Bun.stripANSI(loader.render(200).join(" ")).trim().split(/\s+/);
	return words.slice(1).join(" ");
}

function compactionStart(reason: CompactionStart["reason"]): CompactionStart {
	return { type: "auto_compaction_start", reason, action: "context-full" } as CompactionStart;
}

function compactionEnd(overrides: Partial<CompactionEnd>): CompactionEnd {
	return {
		type: "auto_compaction_end",
		action: "context-full",
		result: undefined,
		aborted: false,
		willRetry: false,
		...overrides,
	} as CompactionEnd;
}

const RETRY_START = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 2_000,
	errorMessage: ERROR_TEXT,
} as RetryStart;

function erroredBlock(): AssistantMessageComponent {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "running the migration" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "error",
		errorMessage: ERROR_TEXT,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1_700_000_000_000,
	};
	return new AssistantMessageComponent(toAssistantMessageView(message));
}

function recovered(persistenceKey: string | undefined): RecoveredRetryError {
	return {
		entryId: "entry-1",
		persistenceKey,
		note: RECOVERY_NOTE,
		retryRecovery: {
			kind: "auto-retry",
			status: "recovered",
			attempt: 1,
			recoveredAt: "2026-01-01T00:00:00.000Z",
			recovery: "plain",
			note: RECOVERY_NOTE,
		},
	};
}

function rendered(component: AssistantMessageComponent): string {
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("an auto-compaction loader", () => {
	it("states why the compaction started, for every start reason", async () => {
		const label = compactionActionLabel(true, "local");
		for (const [reason, prefix] of Object.entries(REASON_PREFIX) as [CompactionStart["reason"], string][]) {
			const { ctx, recovery } = createRig();
			await recovery.compactionStarted(compactionStart(reason));
			expect(loaderMessage(ctx.autoCompactionLoader)).toBe(`${prefix}${label}… (esc to cancel)`);
			await recovery.compactionEnded(compactionEnd({ skipped: true }));
		}
	});

	it("offers Esc only while no agent is focused, since Esc then returns to the main session", async () => {
		const label = compactionActionLabel(true, "local");
		const { ctx, recovery } = createRig({ focusedAgentId: "agent-1" });
		await recovery.compactionStarted(compactionStart("threshold"));
		expect(loaderMessage(ctx.autoCompactionLoader)).toBe(`${label}…`);
		await recovery.compactionEnded(compactionEnd({ skipped: true }));

		await recovery.retryStarted(RETRY_START, undefined);
		expect(loaderMessage(ctx.retryLoader)).not.toContain("esc to cancel");
		await recovery.retryEnded({ type: "auto_retry_end", success: true, attempt: 1 } as RetryEnd);
	});

	it("marks the terminal busy from start to end", async () => {
		const { progress, recovery } = createRig();
		await recovery.compactionStarted(compactionStart("overflow"));
		expect(progress).toEqual([true]);
		await recovery.compactionEnded(compactionEnd({ skipped: true }));
		expect(progress).toEqual([true, false]);
	});

	it("rebuilds the transcript when the compaction produced a summary, and not when it was cancelled", async () => {
		const done = createRig();
		await done.recovery.compactionStarted(compactionStart("threshold"));
		await done.recovery.compactionEnded(compactionEnd({ result: {} as CompactionEnd["result"] }));
		expect(done.log).toEqual(["chat:rebuild"]);
		expect(done.ctx.lastAssistantUsage).toBeUndefined();

		const cancelled = createRig();
		await cancelled.recovery.compactionStarted(compactionStart("threshold"));
		await cancelled.recovery.compactionEnded(compactionEnd({ aborted: true }));
		expect(cancelled.log).toEqual(["status:Auto-compaction cancelled"]);
	});
});

describe("an auto-retry", () => {
	for (const [keyed, label] of [
		[true, "by the block's persistence key"],
		[false, "by superseded order when the recovered error carries no key"],
	] as const) {
		it(`marks the recovered block and clears the pinned banner, matched ${label}`, async () => {
			const { log, recovery } = createRig();
			const block = erroredBlock();
			recovery.pinTurnError(block, ERROR_TEXT);
			expect(rendered(block)).not.toContain(ERROR_TEXT);

			await recovery.retryStarted(RETRY_START, block);
			await recovery.retryEnded({
				type: "auto_retry_end",
				success: true,
				attempt: 1,
				recoveredErrors: [recovered(keyed ? block.messagePersistenceKey() : undefined)],
			} as RetryEnd);

			expect(log).toContain("banner:clear");
			expect(rendered(block)).toContain(RECOVERY_NOTE);
			expect(rendered(block)).not.toContain(ERROR_TEXT);
		});
	}

	it("keeps the banner and restores nothing when the retry fails", async () => {
		const { log, recovery } = createRig();
		const block = erroredBlock();
		recovery.pinTurnError(block, ERROR_TEXT);

		await recovery.retryStarted(RETRY_START, block);
		await recovery.retryEnded({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "overloaded",
		} as RetryEnd);

		expect(log).toEqual([`banner:${ERROR_TEXT}`, "error:Retry failed after 3 attempts: overloaded"]);
		expect(rendered(block)).not.toContain(RECOVERY_NOTE);
	});

	it("brings the working loader back when it ends mid-stream, and leaves no countdown running", async () => {
		const timersBefore = vi.getTimerCount();
		const streaming = createRig({ streaming: true });
		await streaming.recovery.retryStarted(RETRY_START, undefined);
		expect(vi.getTimerCount()).toBeGreaterThan(timersBefore);
		await streaming.recovery.retryEnded({ type: "auto_retry_end", success: true, attempt: 1 } as RetryEnd);
		expect(streaming.log.filter(entry => entry === "working:show")).toEqual(["working:show"]);
		expect(streaming.ctx.retryLoader).toBeUndefined();
		expect(vi.getTimerCount()).toBe(timersBefore);

		const idle = createRig({ streaming: false });
		await idle.recovery.retryStarted(RETRY_START, undefined);
		await idle.recovery.retryEnded({ type: "auto_retry_end", success: true, attempt: 1 } as RetryEnd);
		expect(idle.log).not.toContain("working:show");
	});
});
