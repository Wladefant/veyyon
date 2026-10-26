/**
 * The `/todo` command: one implementation, two surfaces.
 *
 * The TUI controller and the text/ACP dispatcher both run {@link runTodoCommand}. What differs
 * between them is what the surface can do, and each difference is one optional member of
 * {@link TodoCommandPort}: a todo panel to redraw, a clipboard, an editor.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, titleCaseSentence, titleCaseWords } from "@veyyon/utils";
import { tokenizeQuotedArgs } from "@veyyon/utils/cli";
import type { AgentSession } from "../../session/agent-session";
import {
	applyOpsToPhases,
	getLatestTodoPhasesFromEntries,
	markdownToPhases,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
	type TodoItem,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "../../tools/agent/todo";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, parseSubcommand } from "./parse";

/** What the operator's editor produced: the saved text, or a notice when nothing was saved. */
export type TodoEditorResult = { saved: string } | { notice: string };

/** What `/todo` needs from whichever surface invoked it. */
export interface TodoCommandPort {
	session: Pick<AgentSession, "getTodoPhases" | "setTodoPhases">;
	/** The live agent, which receives the reminder that the list changed. */
	agent: Pick<AgentSession["agent"], "appendMessage">;
	sessionManager: Pick<SessionManager, "appendCustomEntry" | "appendMessage" | "getBranch" | "getCwd">;
	/** Redraw the surface's todo panel after a change; absent when the surface has none. */
	showTodos?: (phases: TodoPhase[]) => void;
	/** Put text on the clipboard; absent when the surface has none, and `copy` prints the list instead. */
	copy?: (text: string) => Promise<void>;
	/** Open Markdown in the operator's editor; absent when the surface has no editor. */
	editMarkdown?: (markdown: string) => Promise<TodoEditorResult>;
}

/** Result of running the command, for the surface to render. */
export interface TodoCommandOutcome {
	message: string;
	/** `error`: the command failed and changed nothing. `warning`: there was nothing to do. */
	level: "info" | "warning" | "error";
}

type TodoTargetVerb = "done" | "drop" | "rm";

interface TodoTaskMatch {
	task: TodoItem;
	phase: TodoPhase;
}

const UNKNOWN_VERB =
	"Unknown /todo subcommand.\nUse append, start, done, drop, rm, copy, export, import, edit, or help.";

const EMPTY_EDIT_TEMPLATE = "# Todos\n- [ ] (replace this with your tasks)\n";

function info(message: string): TodoCommandOutcome {
	return { message, level: "info" };
}

function warning(message: string): TodoCommandOutcome {
	return { message, level: "warning" };
}

function failure(message: string): TodoCommandOutcome {
	return { message, level: "error" };
}

function helpText(port: TodoCommandPort): string {
	return [
		"Usage: /todo <verb> [args]",
		"  /todo                              Show current todos",
		port.editMarkdown
			? "  /todo edit                         Open todos in $EDITOR"
			: "  /todo edit                         (TUI only) open in $EDITOR",
		port.copy
			? "  /todo copy                         Copy todos as Markdown to clipboard"
			: "  /todo copy                         Print todos as Markdown",
		"  /todo export [<path>]              Write todos to file (default: TODO.md)",
		"  /todo import [<path>]              Replace todos from file (default: TODO.md)",
		"  /todo append [<phase>] <task...>   Append a task; phase fuzzy-matched or auto-created",
		"  /todo start  <task>                Mark task in_progress (fuzzy content match)",
		"  /todo done   [<task|phase>]        Mark task/phase/all completed",
		"  /todo drop   [<task|phase>]        Mark task/phase/all abandoned",
		"  /todo rm     [<task|phase>]        Remove task/phase/all",
		"  /todo help                         Show this help",
	].join("\n");
}

function findPhaseFuzzy(phases: TodoPhase[], query: string): TodoPhase | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	const exact = phases.find(phase => phase.name.toLowerCase() === normalizedQuery);
	if (exact) return exact;
	const prefixMatches = phases.filter(phase => phase.name.toLowerCase().startsWith(normalizedQuery));
	if (prefixMatches.length === 1) return prefixMatches[0];
	const substringMatches = phases.filter(phase => phase.name.toLowerCase().includes(normalizedQuery));
	if (substringMatches.length === 1) return substringMatches[0];
	return undefined;
}

function findTaskFuzzy(phases: TodoPhase[], query: string): TodoTaskMatch | undefined {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return undefined;
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase() === normalizedQuery) return { task, phase };
		}
	}
	const matches: TodoTaskMatch[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.content.toLowerCase().includes(normalizedQuery)) matches.push({ task, phase });
		}
	}
	if (matches.length === 1) return matches[0];
	// An ambiguous query resolves to its one open task, if it has exactly one.
	const active = matches.filter(match => match.task.status === "in_progress" || match.task.status === "pending");
	if (active.length === 1) return active[0];
	return undefined;
}

/** The queries a task or phase argument is matched as: as typed, then without its quotes when that differs. */
function targetQueries(argument: string): string[] {
	const unquoted = tokenizeQuotedArgs(argument).join(" ");
	return unquoted && unquoted !== argument ? [argument, unquoted] : [argument];
}

/** The latest todo state: the session entries, or the live session state when the branch has none. */
function currentPhases(port: TodoCommandPort): TodoPhase[] {
	const fromEntries = getLatestTodoPhasesFromEntries(port.sessionManager.getBranch());
	return fromEntries.length > 0 ? fromEntries : port.session.getTodoPhases();
}

function reminderText(action: string, phases: TodoPhase[], removed: boolean): string {
	const md = phases.length === 0 ? "(empty)" : phasesToMarkdown(phases).trimEnd();
	const lines = ["<system-reminder>", `The user manually modified the todo list (${action}).`];
	if (removed) {
		lines.push(
			phases.length === 0
				? "The user intentionally cleared the todo list. Do NOT recreate or re-populate it unless the user explicitly asks; continue the current request without a todo list."
				: "The user intentionally removed the entries no longer shown below. Do NOT re-add them unless the user explicitly asks.",
		);
	}
	lines.push("Current todo list:", "", md, "</system-reminder>");
	return lines.join("\n");
}

/**
 * Replace the todo list and tell the agent.
 *
 * The list goes to the live session and to a custom entry, so a reload restores it. The reminder
 * goes to the live agent and to the session file, so the agent learns of the change on its next
 * turn and a resumed session holds the same message. A removal states that it was intended, so the
 * agent does not rebuild what was removed (#5258).
 */
function commitTodos(port: TodoCommandPort, phases: TodoPhase[], action: string, removed = false): void {
	port.session.setTodoPhases(phases);
	port.showTodos?.(phases);
	port.sessionManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases });
	const message = {
		role: "developer" as const,
		content: [{ type: "text" as const, text: reminderText(action, phases, removed) }],
		attribution: "user" as const,
		timestamp: Date.now(),
	};
	port.agent.appendMessage(message);
	port.sessionManager.appendMessage(message);
}

function countTasks(phases: TodoPhase[]): number {
	return phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
}

async function copyTodos(port: TodoCommandPort): Promise<TodoCommandOutcome> {
	const phases = currentPhases(port);
	if (!port.copy) {
		const markdown = phases.length === 0 ? "" : phasesToMarkdown(phases).trimEnd();
		return info(`Copy not available in ACP mode; printing instead:\n\n${markdown || "No todos."}`);
	}
	if (phases.length === 0) return warning("No todos to copy.");
	try {
		await port.copy(phasesToMarkdown(phases));
	} catch (error) {
		return failure(errorMessage(error));
	}
	return info("Copied todos as Markdown to clipboard.");
}

async function exportTodos(argument: string, port: TodoCommandPort): Promise<TodoCommandOutcome> {
	const phases = currentPhases(port);
	if (phases.length === 0) return warning("No todos to export.");
	let target: string;
	try {
		target = resolveTodoMarkdownPath(argument, port.sessionManager.getCwd());
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, phasesToMarkdown(phases), "utf8");
	} catch (error) {
		return failure(`Failed to write todos: ${errorMessage(error)}`);
	}
	return info(`Wrote todos to ${target}`);
}

async function importTodos(argument: string, port: TodoCommandPort): Promise<TodoCommandOutcome> {
	let source: string;
	let content: string;
	try {
		source = resolveTodoMarkdownPath(argument, port.sessionManager.getCwd());
		content = await fs.readFile(source, "utf8");
	} catch (error) {
		return failure(`Failed to read todos: ${errorMessage(error)}`);
	}
	const { phases, errors } = markdownToPhases(content);
	if (errors.length > 0) return failure(`Could not parse ${source}:\n  ${errors.join("\n  ")}`);
	commitTodos(port, phases, `/todo import ${source}`);
	return info(`Imported ${phases.length} phase(s), ${countTasks(phases)} task(s) from ${source}.`);
}

async function editTodos(port: TodoCommandPort): Promise<TodoCommandOutcome> {
	if (!port.editMarkdown) {
		return failure(
			"/todo edit requires the TUI editor; use /todo export then /todo import for non-interactive edits.",
		);
	}
	const current = currentPhases(port);
	const edited = await port.editMarkdown(current.length > 0 ? phasesToMarkdown(current) : EMPTY_EDIT_TEMPLATE);
	if ("notice" in edited) return warning(edited.notice);
	const { phases, errors } = markdownToPhases(edited.saved);
	if (errors.length > 0) return failure(`Could not parse Markdown:\n  ${errors.join("\n  ")}`);
	commitTodos(port, phases, "/todo edit");
	return info(`Todos updated from editor: ${phases.length} phase(s), ${countTasks(phases)} task(s).`);
}

function appendTodo(argument: string, port: TodoCommandPort): TodoCommandOutcome {
	const tokens = tokenizeQuotedArgs(argument);
	if (tokens.length === 0) return failure("Usage: /todo append [<phase>] <task...>");

	const phaseName = tokens.length === 1 ? undefined : tokens[0];
	const content = tokens.length === 1 ? tokens[0]! : tokens.slice(1).join(" ");
	const next = currentPhases(port).map(phase => ({ ...phase, tasks: phase.tasks.slice() }));
	let targetPhase: TodoPhase;

	if (phaseName) {
		const existing = findPhaseFuzzy(next, phaseName);
		targetPhase = existing ?? { name: titleCaseWords(phaseName), tasks: [] };
		if (!existing) next.push(targetPhase);
	} else if (next.length > 0) {
		targetPhase = next[next.length - 1]!;
	} else {
		targetPhase = { name: "Todos", tasks: [] };
		next.push(targetPhase);
	}

	const finalContent = titleCaseSentence(content);
	targetPhase.tasks.push({ content: finalContent, status: "pending" });
	commitTodos(port, next, `/todo append → ${targetPhase.name}`);
	return info(`Appended to ${targetPhase.name}: ${finalContent}`);
}

function startTodo(argument: string, port: TodoCommandPort): TodoCommandOutcome {
	if (!argument) return failure("Usage: /todo start <task>");
	const current = currentPhases(port);
	let hit: TodoTaskMatch | undefined;
	for (const query of targetQueries(argument)) {
		hit = findTaskFuzzy(current, query);
		if (hit) break;
	}
	if (!hit) return failure(`No task matched "${argument}". Use /todo to list current tasks.`);
	const { phases, errors } = applyOpsToPhases(current, [{ op: "start", task: hit.task.content }]);
	if (errors.length > 0) return failure(errors.join("; "));
	commitTodos(port, phases, `/todo start ${hit.task.content}`);
	return info(`Started: ${hit.task.content}`);
}

function targetTodo(verb: TodoTargetVerb, argument: string, port: TodoCommandPort): TodoCommandOutcome {
	const current = currentPhases(port);
	const removed = verb === "rm";
	const status = verb === "done" ? "completed" : "abandoned";
	if (!argument) {
		if (removed) {
			commitTodos(port, [], "/todo rm (all)", true);
			return info("Cleared all todos.");
		}
		const { phases, errors } = applyOpsToPhases(current, [{ op: verb }]);
		if (errors.length > 0) return failure(errors.join("; "));
		commitTodos(port, phases, `/todo ${verb} (all)`);
		return info(`Marked all tasks ${status}.`);
	}

	for (const query of targetQueries(argument)) {
		const taskHit = findTaskFuzzy(current, query);
		if (taskHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: verb, task: taskHit.task.content }]);
			if (errors.length > 0) return failure(errors.join("; "));
			commitTodos(port, phases, `/todo ${verb} ${taskHit.task.content}`, removed);
			return info(removed ? `Removed: ${taskHit.task.content}` : `Marked ${status}: ${taskHit.task.content}`);
		}
		const phaseHit = findPhaseFuzzy(current, query);
		if (phaseHit) {
			const { phases, errors } = applyOpsToPhases(current, [{ op: verb, phase: phaseHit.name }]);
			if (errors.length > 0) return failure(errors.join("; "));
			commitTodos(port, phases, `/todo ${verb} ${phaseHit.name}`, removed);
			return info(removed ? `Removed phase: ${phaseHit.name}` : `Marked phase ${phaseHit.name} ${status}.`);
		}
	}
	return failure(`No task or phase matched "${argument}".`);
}

/** Run `/todo <args>` against a surface. Every outcome, failures included, is a message to show. */
export async function runTodoCommand(args: string, port: TodoCommandPort): Promise<TodoCommandOutcome> {
	const trimmed = args.trim();
	if (!trimmed) {
		const phases = currentPhases(port);
		return info(
			phases.length === 0 ? "No todos. Use /todo append <task> to start one." : phasesToMarkdown(phases).trimEnd(),
		);
	}

	const { verb, rest: argument } = parseSubcommand(trimmed);
	switch (verb) {
		case "copy":
			return await copyTodos(port);
		case "export":
			return await exportTodos(argument, port);
		case "import":
			return await importTodos(argument, port);
		case "edit":
			return await editTodos(port);
		case "append":
			return appendTodo(argument, port);
		case "start":
			return startTodo(argument, port);
		case "done":
		case "drop":
		case "rm":
			return targetTodo(verb, argument, port);
		case "help":
		case "?":
			return info(helpText(port));
		default:
			return failure(UNKNOWN_VERB);
	}
}

/** ACP/text-mode `/todo` handler. Shared by both dispatchers via the spec. */
export async function handleTodoAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const outcome = await runTodoCommand(command.args, {
		session: runtime.session,
		agent: runtime.session.agent,
		sessionManager: runtime.sessionManager,
	});
	await runtime.output(outcome.message);
	return commandConsumed();
}
