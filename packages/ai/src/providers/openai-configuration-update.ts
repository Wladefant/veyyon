import { createHash } from "node:crypto";

/** A supported Responses endpoint changes effort without changing the cached request prefix. */
export interface ConfigurationUpdateItem {
	type: "configuration_update";
	reasoning: { effort: string };
}

interface EffortTransition<TEffort extends string> {
	index: number;
	anchor: string;
	effort: TEffort;
}

export interface OpenAIEffortControlState<TEffort extends string = string> {
	sessionId: string;
	baseEffort?: TEffort;
	currentEffort?: TEffort;
	transitions: EffortTransition<TEffort>[];
}

export function createOpenAIEffortControlState<TEffort extends string>(
	sessionId = "",
): OpenAIEffortControlState<TEffort> {
	return { sessionId, transitions: [] };
}

const MAX_EFFORT_CONTROL_STATES = 16;

function getOrCreateOpenAIEffortControlState<TEffort extends string>(
	states: Map<string, OpenAIEffortControlState<TEffort>>,
	key: string,
	sessionId: string,
): OpenAIEffortControlState<TEffort> {
	const existing = states.get(key);
	if (existing) {
		states.delete(key);
		states.set(key, existing);
		return existing;
	}
	const created = createOpenAIEffortControlState<TEffort>(sessionId);
	states.set(key, created);
	if (states.size > MAX_EFFORT_CONTROL_STATES) {
		const oldest = states.keys().next().value;
		if (oldest !== undefined) states.delete(oldest);
	}
	return created;
}

/** Keep the fork's key-based LRU accessor for its existing Responses caller. */
export function getOpenAIEffortControlState<TEffort extends string>(
	states: Map<string, OpenAIEffortControlState<TEffort>>,
	key: string,
	sessionId = key,
): OpenAIEffortControlState<TEffort> {
	return getOrCreateOpenAIEffortControlState(states, key, sessionId);
}

/**
 * A side request plans against a copy of its parent's state. Its effort changes
 * never enter the parent's state.
 */
export function resolveOpenAIEffortControlState<TEffort extends string>(
	states: Map<string, OpenAIEffortControlState<TEffort>>,
	keyOf: (sessionId: string) => string,
	sessionId: string,
	parentSessionId: string | undefined,
): OpenAIEffortControlState<TEffort> {
	if (parentSessionId === undefined || parentSessionId === sessionId) {
		return getOrCreateOpenAIEffortControlState(states, keyOf(sessionId), sessionId);
	}
	const parent = states.get(keyOf(parentSessionId));
	return parent ? { ...structuredClone(parent), sessionId } : createOpenAIEffortControlState(sessionId);
}

/** Release every state entry owned by one provider session. */
export function releaseOpenAIEffortControlSession<TEffort extends string>(
	states: Map<string, OpenAIEffortControlState<TEffort>>,
	sessionId: string,
): void {
	for (const [key, state] of states) {
		if (state.sessionId === sessionId) states.delete(key);
	}
}

interface AnchorableItem {
	type?: string | null;
	role?: string;
	id?: string | null;
	status?: string | null;
}

function effortControlAnchor(input: readonly AnchorableItem[], index: number): string {
	const item = input[index - 1];
	if (!item) return "";
	// Replay removes lifecycle fields without changing the conversation.
	const { id: _id, status: _status, ...stable } = item;
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Pin request-level effort and replay transitions at their original transcript positions.
 * `minimized` changes the in-conversation level without changing the cached request prefix.
 */
export function planStableOpenAIEffort<TItem extends AnchorableItem, TEffort extends string>(
	state: OpenAIEffortControlState<TEffort>,
	input: Array<TItem | ConfigurationUpdateItem>,
	requested: TEffort,
	minimized?: TEffort,
): TEffort {
	for (const transition of state.transitions) {
		if (transition.index > input.length || transition.anchor !== effortControlAnchor(input, transition.index)) {
			state.baseEffort = undefined;
			state.currentEffort = undefined;
			state.transitions = [];
			break;
		}
	}
	if (state.baseEffort === undefined) {
		state.baseEffort = requested;
		state.currentEffort = requested;
		return requested;
	}
	const effort = minimized ?? requested;
	if (state.currentEffort !== effort) {
		const last = input[input.length - 1];
		const index = last && "role" in last && last.role === "user" ? input.length - 1 : input.length;
		const existing = state.transitions.find(transition => transition.index === index);
		if (existing) existing.effort = effort;
		else state.transitions.push({ index, anchor: effortControlAnchor(input, index), effort });
		let preceding = state.baseEffort;
		let precedingIndex = -1;
		for (const transition of state.transitions) {
			if (transition.index < index && transition.index > precedingIndex) {
				preceding = transition.effort;
				precedingIndex = transition.index;
			}
		}
		if (effort === preceding)
			state.transitions = state.transitions.filter(transition => transition.index !== index);
		state.currentEffort = effort;
	}
	state.transitions.sort((a, b) => a.index - b.index);
	let offset = 0;
	for (const transition of state.transitions) {
		input.splice(transition.index + offset, 0, {
			type: "configuration_update",
			reasoning: { effort: transition.effort },
		});
		offset++;
	}
	return state.baseEffort;
}
