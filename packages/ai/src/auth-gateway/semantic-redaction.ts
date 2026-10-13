type Slot = { owner: Record<string, unknown>; key: string; channel: string };
type Frame = { raw: string; prefix?: string; value?: Record<string, unknown>; slots: Slot[]; changed: boolean };

/** Keep possible credential prefixes private until the next semantic delta resolves them. */
export class GatewaySemanticRedactor {
	readonly #pending: Frame[] = [];
	constructor(private readonly secrets: readonly string[]) {}

	push(raw: string, final = false): string {
		if (raw) {
			const frame: Frame = { raw, slots: [], changed: false };
			const match = /^((?:[^\n]*\n)*data: )([^\n]*)\n\n$/.exec(raw);
			if (match && match[2] !== "[DONE]") {
				try {
					const value: unknown = JSON.parse(match[2]);
					if (value && typeof value === "object" && !Array.isArray(value)) {
						frame.value = value as Record<string, unknown>;
						frame.prefix = match[1];
						this.#slots(frame.value, frame.slots);
					}
				} catch { /* Non-JSON SSE data still passes through the byte redactor. */ }
			}
			this.#pending.push(frame);
		}
		const channels = new Map<string, { frame: Frame; slot: Slot }[]>();
		for (const frame of this.#pending) for (const slot of frame.slots) {
			const parts = channels.get(slot.channel) ?? [];
			parts.push({ frame, slot });
			channels.set(slot.channel, parts);
		}
		let prefixPending = false;
		for (const parts of channels.values()) {
			const text = parts.map(({ slot }) => String(slot.owner[slot.key])).join("");
			const ranges: { start: number; end: number }[] = [];
			for (const secret of this.secrets) {
				if (!secret) continue;
				let start = text.indexOf(secret);
				while (start >= 0) {
					ranges.push({ start, end: start + secret.length });
					start = text.indexOf(secret, start + secret.length);
				}
			}
			ranges.sort((a, b) => a.start - b.start || b.end - a.end);
			const merged: typeof ranges = [];
			for (const range of ranges) {
				const previous = merged.at(-1);
				if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
				else merged.push({ ...range });
			}
			let offset = 0;
			for (const { frame, slot } of parts) {
				const original = String(slot.owner[slot.key]);
				let output = "";
				let cursor = 0;
				for (const range of merged) {
					const start = Math.max(0, range.start - offset);
					const end = Math.min(original.length, range.end - offset);
					if (end <= start) continue;
					output += original.slice(cursor, start);
					if (range.start >= offset) output += "[REDACTED]";
					cursor = end;
				}
				output += original.slice(cursor);
				if (output !== original) { slot.owner[slot.key] = output; frame.changed = true; }
				offset += original.length;
			}
			const safe = parts.map(({ slot }) => String(slot.owner[slot.key])).join("");
			for (const secret of this.secrets) {
				for (let length = 1; length < secret.length && length <= safe.length; length++) {
					if (safe.endsWith(secret.slice(0, length))) { prefixPending = true; break; }
				}
			}
		}
		if (prefixPending && !final) return "";
		const output = this.#pending.map(frame => frame.changed ? `${frame.prefix}${JSON.stringify(frame.value)}\n\n` : frame.raw).join("");
		this.#pending.length = 0;
		return output;
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
