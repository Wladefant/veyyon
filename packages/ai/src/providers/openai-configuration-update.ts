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
	baseEffort?: TEffort;
	currentEffort?: TEffort;
	transitions: EffortTransition<TEffort>[];
}

export function createOpenAIEffortControlState<TEffort extends string>(): OpenAIEffortControlState<TEffort> {
	return { transitions: [] };
}

/** Keep at most sixteen conversations, refreshing an existing conversation's LRU slot. */
export function getOpenAIEffortControlState<TEffort extends string>(
	states: Map<string, OpenAIEffortControlState<TEffort>>,
	key: string,
): OpenAIEffortControlState<TEffort> {
	const existing = states.get(key);
	if (existing) {
		states.delete(key);
		states.set(key, existing);
		return existing;
	}
	const created = createOpenAIEffortControlState<TEffort>();
	states.set(key, created);
	if (states.size > 16) {
		const oldest = states.keys().next().value;
		if (oldest !== undefined) states.delete(oldest);
	}
	return created;
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

/** Mutates a freshly built transcript; never pass an input already carrying configuration updates. */
export function planStableOpenAIEffort<TItem extends AnchorableItem, TEffort extends string>(
	state: OpenAIEffortControlState<TEffort>,
	input: Array<TItem | ConfigurationUpdateItem>,
	requested: TEffort,
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
	if (state.currentEffort !== requested) {
		const last = input[input.length - 1];
		const index = last && "role" in last && last.role === "user" ? input.length - 1 : input.length;
		const existing = state.transitions.find(transition => transition.index === index);
		if (existing) existing.effort = requested;
		else state.transitions.push({ index, anchor: effortControlAnchor(input, index), effort: requested });
		let preceding = state.baseEffort;
		let precedingIndex = -1;
		for (const transition of state.transitions) {
			if (transition.index < index && transition.index > precedingIndex) {
				preceding = transition.effort;
				precedingIndex = transition.index;
			}
		}
		if (requested === preceding)
			state.transitions = state.transitions.filter(transition => transition.index !== index);
		state.currentEffort = requested;
	}
	state.transitions.sort((a, b) => a.index - b.index);
	let offset = 0;
	for (const transition of state.transitions) {
		input.splice(transition.index + offset++, 0, {
			type: "configuration_update",
			reasoning: { effort: transition.effort },
		});
	}
	return state.baseEffort;
}
