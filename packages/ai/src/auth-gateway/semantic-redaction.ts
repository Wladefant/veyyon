import { Buffer } from "node:buffer";

export const GATEWAY_SEMANTIC_MAX_HELD_FRAMES = 64;
export const GATEWAY_SEMANTIC_MAX_HELD_BYTES = 64 * 1024;

type Slot = { owner: Record<string, unknown>; key: string; channel: string };
type Frame = { raw: string; prefix?: string; value?: Record<string, unknown>; slots: Slot[]; completed: string[]; changed: boolean };

/** Keep possible credential prefixes private until the next semantic delta resolves them. */
export class GatewaySemanticRedactor {
	readonly #pending: Frame[] = [];
	readonly #tails = new Map<string, string>();
	#heldBytes = 0;
	constructor(private readonly secrets: readonly string[]) {}

	push(raw: string, final = false): string {
		let errorBoundary = false;
		if (raw) {
			const frame: Frame = { raw, slots: [], completed: [], changed: false };
			const match = /^((?:[^\n]*\n)*data: )([^\n]*)\n\n$/.exec(raw);
			if (match?.[2] === "[DONE]") final = true;
			if (match && match[2] !== "[DONE]") {
				try {
					const value: unknown = JSON.parse(match[2]);
					if (value && typeof value === "object" && !Array.isArray(value)) {
						const parsed = value as Record<string, unknown>;
						frame.value = parsed;
						if (parsed.type === "error" || parsed.type === "response.failed") {
							// Held deltas flush through the redaction pass with trailing prefixes masked. The unmasked prefix stays in tails, so a later continuation is still redacted.
							errorBoundary = true;
							final = true;
						} else {
							frame.prefix = match[1];
							this.#slots(frame.value, frame.slots);
							if (parsed.type === "done" || parsed.type === "response.completed") final = true;
						}
					}
				} catch { /* Non-JSON SSE data still passes through the byte redactor. */ }
			}
			this.#pending.push(frame);
			this.#heldBytes += Buffer.byteLength(raw, "utf8");
		}
		const channels = new Map<string, { frame: Frame; slot: Slot }[]>();
		const completed = new Set<string>();
		for (const frame of this.#pending) {
			for (const slot of frame.slots) {
				completed.delete(slot.channel);
				const parts = channels.get(slot.channel) ?? [];
				parts.push({ frame, slot });
				channels.set(slot.channel, parts);
			}
			for (const prefix of frame.completed) for (const channel of channels.keys()) {
				if (channel.startsWith(prefix)) completed.add(channel);
			}
		}
		let prefixPending = false;
		const capped = this.#pending.length >= GATEWAY_SEMANTIC_MAX_HELD_FRAMES || this.#heldBytes >= GATEWAY_SEMANTIC_MAX_HELD_BYTES;
		const nextTails = new Map<string, string>();
		let historyCount = this.#tails.size;
		let historyBytes = 0;
		for (const tail of this.#tails.values()) historyBytes += Buffer.byteLength(tail, "utf8");
		for (const [channel, parts] of channels) {
			const history = this.#tails.get(channel) ?? "";
			const text = history + parts.map(({ slot }) => String(slot.owner[slot.key])).join("");
			const ranges: { start: number; end: number }[] = [];
			for (const secret of this.secrets) {
				if (!secret) continue;
				let start = text.indexOf(secret);
				while (start >= 0) {
					ranges.push({ start, end: start + secret.length });
					start = text.indexOf(secret, start + secret.length);
				}
			}
			let longestPrefix = 0;
			for (const secret of this.secrets) for (let length = 1; length < secret.length && length <= text.length; length++) {
				if (text.endsWith(secret.slice(0, length))) longestPrefix = Math.max(longestPrefix, length);
			}
			const candidateBytes = Buffer.byteLength(text.slice(text.length - longestPrefix), "utf8");
			const historyFull = historyCount + (!history && longestPrefix ? 1 : 0) > GATEWAY_SEMANTIC_MAX_HELD_FRAMES
				|| historyBytes - Buffer.byteLength(history, "utf8") + candidateBytes > GATEWAY_SEMANTIC_MAX_HELD_BYTES;
			if (longestPrefix && (capped || historyFull || errorBoundary)) ranges.push({ start: text.length - longestPrefix, end: text.length });
			ranges.sort((a, b) => a.start - b.start || b.end - a.end);
			const merged: typeof ranges = [];
			for (const range of ranges) {
				const previous = merged.at(-1);
				if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
				else merged.push({ ...range });
			}
			let offset = history.length;
			for (const { frame, slot } of parts) {
				const original = String(slot.owner[slot.key]);
				let output = "";
				let cursor = 0;
				for (const range of merged) {
					const start = Math.max(0, range.start - offset);
					const end = Math.min(original.length, range.end - offset);
					if (end <= start) continue;
					output += original.slice(cursor, start);
					if (range.start >= offset || offset === history.length) output += "[REDACTED]";
					cursor = end;
				}
				output += original.slice(cursor);
				if (output !== original) { slot.owner[slot.key] = output; frame.changed = true; }
				offset += original.length;
			}
			const pendingText = parts.map(({ slot }) => String(slot.owner[slot.key])).join("");
			// After an error the held prefix was masked in the output, so history keeps the unmasked text to match a continuation.
			const retained = errorBoundary ? text : history + pendingText;
			let tail = "";
			for (const secret of this.secrets) {
				for (let length = 1; length < secret.length && length <= retained.length; length++) {
					if (retained.endsWith(secret.slice(0, length)) && length > tail.length) tail = secret.slice(0, length);
				}
			}
			historyCount += (tail ? 1 : 0) - (history ? 1 : 0);
			historyBytes += Buffer.byteLength(tail, "utf8") - Buffer.byteLength(history, "utf8");
			if (historyCount > GATEWAY_SEMANTIC_MAX_HELD_FRAMES || historyBytes > GATEWAY_SEMANTIC_MAX_HELD_BYTES) {
				throw new Error("Gateway semantic privacy history exceeded");
			}
			nextTails.set(channel, tail);
			if (tail && pendingText && !completed.has(channel)) prefixPending = true;
		}
		if (prefixPending && !final && !capped) return "";
		const output = this.#pending.map(frame => frame.changed ? `${frame.prefix}${JSON.stringify(frame.value)}\n\n` : frame.raw).join("");
		this.#pending.length = 0;
		this.#heldBytes = 0;
		for (const [channel, tail] of nextTails) {
			if (tail) this.#tails.set(channel, tail);
			else this.#tails.delete(channel);
		}
		return output;
	}

	#completed(value: Record<string, unknown>): string[] {
		switch (value.type) {
			case "text_end": return ["text_delta"];
			case "thinking_end": return ["thinking_delta"];
			case "toolcall_end": return [`toolcall_delta:${value.contentIndex}:`];
			case "content_block_stop": return ["anthropic::text", "anthropic::thinking", `anthropic:${value.index}:partial_json`];
			case "response.output_text.done": return ["response.output_text.delta"];
			case "response.reasoning_text.done": return ["response.reasoning_text.delta"];
			case "response.function_call_arguments.done": return [`response.function_call_arguments.delta:${value.output_index ?? value.item_id ?? ""}:`];
		}
		return Array.isArray(value.choices)
			? value.choices.filter(choice => choice.finish_reason != null).map(choice => `chat:${choice.index}:`)
			: [];
	}

	#slots(value: Record<string, unknown>, slots: Slot[]): void {
		const add = (owner: Record<string, unknown>, key: string, channel: string): void => {
			if (typeof owner[key] === "string") slots.push({ owner, key, channel });
		};
		if (typeof value.delta === "string") {
			const channel = value.type === "text_delta" || value.type === "thinking_delta"
				|| value.type === "response.output_text.delta" || value.type === "response.reasoning_text.delta"
				? String(value.type)
				: `${value.type}:${value.contentIndex ?? value.output_index ?? value.item_id ?? ""}:${value.content_index ?? ""}`;
			add(value, "delta", channel);
		} else if (value.delta && typeof value.delta === "object") {
			const delta = value.delta as Record<string, unknown>;
			for (const key of ["text", "thinking", "partial_json"]) {
				add(delta, key, `anthropic:${key === "partial_json" ? value.index : ""}:${key}`);
			}
		}
		if (Array.isArray(value.choices)) for (const choice of value.choices) {
			if (!choice?.delta) continue;
			const delta = choice.delta as Record<string, unknown>;
			for (const key of ["content", "reasoning_content"]) add(delta, key, `chat:${choice.index}:${key}`);
			if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) {
				if (call?.function) add(call.function, "arguments", `chat:${choice.index}:tool:${call.index}`);
			}
		}
	}
}
