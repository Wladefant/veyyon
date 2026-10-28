import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/agent/todo";

/** A todo phase called `name` holding one task per `[content, status]` pair. */
export function todoPhase(name: string, tasks: Array<[string, TodoItem["status"]]>): TodoPhase {
	return { name, tasks: tasks.map(([content, status]) => ({ content, status })) };
}
