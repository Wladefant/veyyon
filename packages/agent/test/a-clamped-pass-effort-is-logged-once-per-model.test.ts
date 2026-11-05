import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { generateHandoff } from "@veyyon/agent-core/compaction";
import { clampPassEffort } from "@veyyon/agent-core/effort-clamp";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { logger } from "@veyyon/utils";
import { createAssistantText, requireBundledModel } from "./helpers";

/**
 * WHY: an internal pass that requests a fixed effort the model does not accept logs the move, and it
 * logged the move once per request. A staged compaction sends one request per segment, so one compaction
 * of a 146 MB session on a model with no effort control logged the same warning 133 times. The move is a
 * property of the model row, so it is logged once per process for each pass, model and requested effort.
 *
 * Class closed: a repeated move logged again by any pass that clamps through `clampPassEffort`, which is
 * every compaction request (summary, turn prefix, handoff) and both memory passes. The dedupe never hides a
 * different move: another effort, another model or another pass each log their own line, and every request
 * still sends the clamped effort.
 *
 * Not caught: a pass that clamps through `clampThinkingLevelForModel` directly and logs on its own. Nothing
 * enumerates the passes.
 *
 * Each case clones a bundled row under a fresh id. The log state is per process, and another file in the
 * same run may already have logged the bundled row.
 */

interface Logged {
	message: string;
	meta: unknown;
}

function captureWarnings(): Logged[] {
	const logged: Logged[] = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, meta?: unknown) => {
		logged.push({ message, meta });
	});
	return logged;
}

function freshRow(provider: string, id: string): Model {
	const model = requireBundledModel(provider, id);
	return { ...model, id: `${id}-${crypto.randomUUID()}` };
}

/** Reasoning row with no effort ladder: every requested effort clamps to the provider default. */
function noEffortRow(): Model {
	return freshRow("xai-oauth", "grok-4.20-0309-reasoning");
}

const history: AgentMessage[] = [{ role: "user", content: "start work", timestamp: 1 }, createAssistantText("started")];

function moved(pass: string, model: Model, requested: Effort): Logged {
	return {
		message: `${pass} effort is not accepted by the model; using the nearest supported level`,
		meta: { model: `${model.provider}/${model.id}`, requested, using: "provider default" },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a pass effort the model does not accept", () => {
	it("is logged once across every request a compaction pass sends, and every request sends the clamp", async () => {
		const logged = captureWarnings();
		const send = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantText("handoff"));
		const model = noEffortRow();

		for (let request = 0; request < 3; request++) {
			await generateHandoff(history, model, "test-key", {
				systemPrompt: ["sp"],
				tools: [],
				thinkingLevel: ThinkingLevel.High,
			});
		}

		expect(logged).toEqual([moved("Compaction", model, Effort.High)]);
		expect(send.mock.calls.map(call => call[2]?.reasoning)).toEqual([undefined, undefined, undefined]);
	});

	it("is logged again for another effort, another model or another pass, and once each", () => {
		const logged = captureWarnings();
		const first = noEffortRow();
		const second = noEffortRow();

		const sent = [
			clampPassEffort(first, Effort.High, "Compaction"),
			clampPassEffort(first, Effort.High, "Compaction"),
			clampPassEffort(first, Effort.Low, "Compaction"),
			clampPassEffort(second, Effort.High, "Compaction"),
			clampPassEffort(first, Effort.High, "Memory pass"),
			clampPassEffort(first, Effort.Low, "Compaction"),
			clampPassEffort(second, Effort.High, "Memory pass"),
			clampPassEffort(second, Effort.High, "Memory pass"),
		];

		expect(sent).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
		expect(logged).toEqual([
			moved("Compaction", first, Effort.High),
			moved("Compaction", first, Effort.Low),
			moved("Compaction", second, Effort.High),
			moved("Memory pass", first, Effort.High),
			moved("Memory pass", second, Effort.High),
		]);
	});
});

describe("a pass effort the model accepts", () => {
	it("is sent as requested and logged nowhere", () => {
		const logged = captureWarnings();
		const model = freshRow("anthropic", "claude-sonnet-4-5");

		expect(clampPassEffort(model, Effort.High, "Compaction")).toBe(Effort.High);
		expect(clampPassEffort(model, Effort.Low, "Memory pass")).toBe(Effort.Low);
		expect(logged).toEqual([]);
	});
});
