/**
 * Hidden messages a turn gains from what the session holds: the persisted todo
 * state appended to a goal continuation, and the notices a magic keyword in the
 * prompt text adds. Both read the session through {@link TurnNoticeHost}, which
 * the session satisfies structurally.
 */
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { escapeXmlText, prompt } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import type { DiscoverableTool } from "../discovery/tool-index";
import { containsOrchestrate } from "../modes/keywords/orchestrate-keyword";
import { containsUltrathink } from "../modes/keywords/ultrathink-keyword";
import { containsWorkflow } from "../modes/keywords/workflow-keyword";
import { goalsPrompts } from "../prompts/goals/rows";
import {
	boundedTodoPreviewText,
	prioritizeTodoItems,
	TODO_ITEM_PREVIEW_WIDTH,
	type TodoPhase,
} from "../tools/agent/todo";
import { TOOL } from "../tools/core/builtin-names";
import { ORCHESTRATE_NOTICE, renderWorkflowNotice, ULTRATHINK_NOTICE } from "./magic-keyword-notices";
import type { CustomMessage } from "./messages";
import { incompleteTodoItems } from "./todo-reminder";
import { parseTurnBudgetDirective } from "./turn-budget";

/** What the turn notices read from the session. */
export interface TurnNoticeHost {
	readonly settings: Settings;
	readonly sessionManager: Pick<SessionManager, "beginTurnBudget">;
	getActiveToolNames(): string[];
	getDiscoverableTools(filter?: { source?: DiscoverableTool["source"] }): DiscoverableTool[];
	getTodoPhases(): TodoPhase[];
}

export type MagicKeyword = "orchestrate" | "ultrathink" | "workflow";

function sanitizeGoalTodoText(text: string): string {
	return escapeXmlText(text)
		.replace(/\r\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/**
 * The `<todo_context>` block a goal continuation carries, or `undefined` when
 * todos are off, the todo tool is neither active nor discoverable, or no phase
 * holds a task.
 */
export function buildGoalTodoContext(host: TurnNoticeHost): string | undefined {
	if (!host.settings.get("todo.enabled")) return undefined;
	const activeToolNames = host.getActiveToolNames();
	const canCallTodoTool = activeToolNames.includes(TOOL.todo);
	const canDiscoverTodoTool =
		!canCallTodoTool && host.getDiscoverableTools({ source: "builtin" }).some(tool => tool.name === TOOL.todo);
	const canActivateTodoTool = canDiscoverTodoTool && activeToolNames.includes(TOOL.search_tool_bm25);
	if (!canCallTodoTool && !canDiscoverTodoTool) return undefined;
	const phases = host.getTodoPhases().filter(phase => phase.tasks.length > 0);
	if (phases.length === 0) return undefined;

	const tasks = phases.flatMap(phase => phase.tasks);
	const closed = tasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const openItems = prioritizeTodoItems(incompleteTodoItems(phases));
	const next = openItems[0];
	const nextItem = next
		? {
				status: next.status,
				text: sanitizeGoalTodoText(
					boundedTodoPreviewText(`${next.content} (${next.phase})`, TODO_ITEM_PREVIEW_WIDTH),
				),
			}
		: undefined;

	return prompt.render(goalsPrompts["goals/goal-todo-context"].text, {
		canCallTodoTool,
		canActivateTodoTool,
		closed: String(closed),
		nextItem,
		open: String(openItems.length),
		total: String(tasks.length),
	});
}

export function magicKeywordEnabled(settings: Settings, keyword: MagicKeyword): boolean {
	return settings.get("magicKeywords.enabled") && settings.get(`magicKeywords.${keyword}`);
}

/**
 * Open the turn's token budget from a budget directive in `text`, and return
 * the hidden notice for each enabled magic keyword `text` contains. The
 * workflow notice is added only while the task tool is active.
 */
export function createMagicKeywordNotices(host: TurnNoticeHost, text: string): CustomMessage[] {
	const settings = host.settings;
	const timestamp = Date.now();
	const turnBudget = parseTurnBudgetDirective(settings, text);
	host.sessionManager.beginTurnBudget(turnBudget?.total ?? null, turnBudget?.hard ?? false);
	const keywordNotices: CustomMessage[] = [];
	if (magicKeywordEnabled(settings, "ultrathink") && containsUltrathink(text)) {
		keywordNotices.push({
			role: "custom",
			customType: "ultrathink-notice",
			content: ULTRATHINK_NOTICE,
			display: false,
			attribution: "user",
			timestamp,
		});
	}
	if (magicKeywordEnabled(settings, "orchestrate") && containsOrchestrate(text)) {
		keywordNotices.push({
			role: "custom",
			customType: "orchestrate-notice",
			content: ORCHESTRATE_NOTICE,
			display: false,
			attribution: "user",
			timestamp,
		});
	}
	if (
		magicKeywordEnabled(settings, "workflow") &&
		containsWorkflow(text) &&
		host.getActiveToolNames().includes(TOOL.task)
	) {
		keywordNotices.push({
			role: "custom",
			customType: "workflow-notice",
			content: renderWorkflowNotice({ taskBatch: settings.get("agent.batch") }),
			display: false,
			attribution: "user",
			timestamp,
		});
	}
	return keywordNotices;
}
