/**
 * Turn preludes: the hidden blocks a turn carries ahead of the message that starts it.
 *
 * This is a session collaborator with no state of its own. It reaches the session only through
 * {@link TurnPreludesHost}.
 *
 * - **The session-state block** ({@link TurnPreludes.sessionState},
 *   {@link TurnPreludes.restateSessionState}) states the date and the working directory, and is
 *   built only when the live context does not already carry the same block.
 * - **The delegate reminder** ({@link TurnPreludes.eagerTask}) tells the main agent to hand
 *   substantial work to the task tool, on the first user message of a transcript.
 * - **The post-compaction nudges** ({@link TurnPreludes.postCompactionNudges}) restate the todo and
 *   delegate reminders on the turn that resumes after a compaction summarized the originals away.
 */
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { prompt } from "@veyyon/utils";
import { localCalendarDate } from "@veyyon/utils/local-time";
import type { Settings } from "../../config/settings";
import { sessionPrompts } from "../../prompts/session/rows";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import { enabledAgentNames, resolveDelegation } from "../../task/agent-settings";
import { TOOL } from "../../tools/core/builtin-names";
import { shortenPath } from "../../tools/core/render-utils";
import { normalizePromptPath } from "../../utils/prompt-path";
import type { CustomMessage } from "../messages";
import { SESSION_STATE_MESSAGE_TYPE } from "../nudges";
import { lastDeliveredBlock } from "./memory-context";
import type { TodoRuntime } from "./todo-runtime";

/** What {@link TurnPreludes} needs from the session that holds it. */
export interface TurnPreludesHost {
	/**
	 * Session settings. `resolveDelegation` takes the handle and reads the delegation strength and the
	 * agent table from it; the delegate reminder also reads `agent.batch`.
	 */
	readonly settings: Settings;
	/** The transcript: its working directory, and the file a restated session-state block is recorded in. */
	readonly sessionStore: Pick<SessionManager, "getCwd" | "appendCustomMessageEntry">;
	/** The todo board, whose reminder opens the post-compaction nudges. */
	readonly todo: Pick<TodoRuntime, "eagerPrelude">;
	/** Whether this session is a spawned agent rather than the main one. */
	readonly isSubagent: boolean;
	/** The live context, in the order the next request sends it. */
	messages(): readonly AgentMessage[];
	/** Append a message to the live context. */
	appendMessage(message: AgentMessage): void;
	/** The tool registered under `name`, active or not. */
	tool(name: string): AgentTool | undefined;
	/** The names of the tools the next request offers. */
	activeToolNames(): string[];
	/** Whether plan mode is on. */
	planModeEnabled(): boolean;
}

export class TurnPreludes {
	readonly #host: TurnPreludesHost;

	constructor(host: TurnPreludesHost) {
		this.#host = host;
	}

	/**
	 * The date and working directory as they stand now, or null when the live context
	 * already carries exactly this block.
	 *
	 * Deduped against the messages the next request sends, not against a record of what
	 * was sent: a compaction, a shake or a rewind that drops the block, and a prompt that
	 * is abandoned after building it, all leave a context without it, and the block is
	 * stated again. Re-sending an unchanged block that is still there would grow the
	 * context every turn for no new information.
	 */
	sessionState(): CustomMessage | null {
		const content = prompt
			.render(sessionPrompts["session/session-state"].text, {
				date: localCalendarDate(Date.now()),
				cwd: shortenPath(normalizePromptPath(this.#host.sessionStore.getCwd())),
			})
			.trim();
		if (content === lastDeliveredBlock(this.#host.messages(), SESSION_STATE_MESSAGE_TYPE)) return null;
		return {
			role: "custom",
			customType: SESSION_STATE_MESSAGE_TYPE,
			content,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * Put the session-state block back into the live context and the session file after a
	 * compaction summarized it away. A compaction between the calls of one run has no prompt
	 * after it to restate the date and working directory, so they go in here, ahead of the next
	 * request, as a plain append: a step-boundary aside would force an extra model turn when the
	 * compaction lands on the run's last turn.
	 */
	restateSessionState(): void {
		const message = this.sessionState();
		if (!message) return;
		this.#host.appendMessage(message);
		this.#host.sessionStore.appendCustomMessageEntry(
			SESSION_STATE_MESSAGE_TYPE,
			message.content,
			false,
			undefined,
			"agent",
		);
	}

	/** The wire names the eager reminders cite the task and todo tools by, and whether tasks batch. */
	eagerContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#host.tool(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName(TOOL.task), todo: wireName(TOOL.todo) },
			taskBatch: this.#host.settings.get("agent.batch"),
		};
	}

	/**
	 * The hidden reminder to delegate through the task tool, or undefined when nothing warrants it.
	 *
	 * `promptText` is the message starting the turn; undefined means the turn resumes after a
	 * compaction, which skips the first-message gates.
	 */
	eagerTask(promptText: string | undefined): AgentMessage | undefined {
		const host = this.#host;
		// Resolved against the agents the live task tool will actually accept: a
		// reminder to delegate, in a session where every agent is disabled, is an
		// instruction the model can only fail to follow.
		if (!resolveDelegation(host.settings, enabledAgentNames(host.tool(TOOL.task))).required) {
			return undefined;
		}
		// Main agent only: agents keep `task` active (the parent only filters `todo`),
		// so a salient delegate-reminder there would amplify nested fan-out. Gate on the
		// resolved agent kind, not the id, so a top-level session with a custom `agentId`
		// still gets the reminder.
		if (host.isSubagent) return undefined;
		if (host.planModeEnabled()) return undefined;
		// First-message-only gates are skipped post-compaction (`promptText === undefined`),
		// where there is no fresh user message to suppress the reminder for.
		if (promptText !== undefined) {
			if (host.messages().some(m => m.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!host.activeToolNames().includes(TOOL.task)) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(turnControlPrompts["turn-control/eager-task"].text, this.eagerContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/**
	 * The eager task and todo reminders to re-inject on the auto-continuation turn that
	 * follows a compaction. The first-message preludes are the oldest messages, so
	 * compaction summarizes them away and the agent silently loses the delegate-via-tasks
	 * and phased-todo guidance mid-work; this re-asserts them, reminder-only (the todo
	 * builder drops its forced tool_choice when `promptText` is undefined). Each builder
	 * still applies its own mode / agent-kind / plan-mode / tool-active / surviving-todo
	 * gates, so an empty array means nothing currently warrants a nudge.
	 */
	postCompactionNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.#host.todo.eagerPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.eagerTask(undefined);
		if (task) nudges.push(task);
		return nudges;
	}
}
