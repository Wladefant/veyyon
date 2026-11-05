/**
 * What a turn sends to the vocalizer under each `speech.mode`: streamed text in `assistant` and `all`, streamed
 * thinking only in `all`, and the whole final message once at turn end in `yield`. An abort stops speech at once and
 * is never spoken afterwards, and a disabled setting speaks nothing.
 *
 * The mode table is checked against the values the setting declares, so a new mode fails here until its routing is
 * recorded. The vocalizer's own queueing and playback are out of scope: its methods are replaced by a recorder.
 *
 * Subject: `modes/terminal/controllers/turn-speech.ts`, driven through `EventController`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { emptyUsage } from "@veyyon/catalog/models";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { vocalizer } from "@veyyon/coding-agent/speech/tts/vocalizer";
import { initTheme } from "@veyyon/coding-agent/theme/theme";

type SpeechMode = (typeof SETTINGS_SCHEMA)["speech.mode"]["values"][number];

const SPOKEN_TEXT = "Hello there. ";
const THOUGHT = "Weighing it. ";

function assistantMessage(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: THOUGHT },
			{ type: "text", text: SPOKEN_TEXT },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason,
		timestamp: 0,
	};
}

function createContext(): InteractiveModeContext {
	const session = { isStreaming: false, isCompacting: false, settings: { get: () => "off" } };
	return {
		isInitialized: true,
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingTools: new Map(),
		settledToolCalls: new Set(),
		noteDisplayableThinkingContent: () => false,
		ui: { requestRender: () => {} },
		session,
		viewSession: session,
	} as unknown as InteractiveModeContext;
}

/** One whole turn: a streamed thought, streamed text, the message end and the turn end. */
function turn(stopReason: AssistantMessage["stopReason"] = "stop"): AgentSessionEvent[] {
	const message = assistantMessage(stopReason);
	return [
		{ type: "turn_start" },
		{
			type: "message_update",
			message,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: THOUGHT, partial: message },
		},
		{
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: SPOKEN_TEXT, partial: message },
		},
		{ type: "message_end", message },
		{ type: "turn_end", message, toolResults: [] },
	];
}

let spoken: string[] = [];

async function play(events: readonly AgentSessionEvent[]): Promise<string[]> {
	const controller = new EventController(createContext());
	spoken = [];
	for (const event of events) await controller.handleEvent(event);
	controller.dispose();
	return spoken;
}

async function useSpeech(enabled: boolean, mode: SpeechMode): Promise<void> {
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: { "speech.enabled": enabled, "speech.mode": mode, "completion.notify": "off" },
	});
}

beforeAll(() => {
	initTheme();
});

beforeEach(() => {
	vi.spyOn(vocalizer, "clear").mockImplementation(() => {
		spoken.push("clear");
	});
	vi.spyOn(vocalizer, "flush").mockImplementation(() => {
		spoken.push("flush");
	});
	vi.spyOn(vocalizer, "pushDelta").mockImplementation(text => {
		spoken.push(`stream ${text}`);
	});
	vi.spyOn(vocalizer, "speak").mockImplementation(text => {
		spoken.push(`speak ${text}`);
	});
	vi.spyOn(vocalizer, "setEnhancer").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("a spoken turn", () => {
	const ROUTING: Record<SpeechMode, string[]> = {
		all: ["clear", `stream ${THOUGHT}`, `stream ${SPOKEN_TEXT}`, "flush", "flush"],
		assistant: ["clear", `stream ${SPOKEN_TEXT}`, "flush", "flush"],
		yield: ["clear", `speak ${SPOKEN_TEXT.trim()}`],
	};
	// The streamed deltas went out before the abort was known; the message end clears them and nothing follows.
	const ABORTED: Record<SpeechMode, string[]> = {
		all: ["clear", `stream ${THOUGHT}`, `stream ${SPOKEN_TEXT}`, "clear", "flush"],
		assistant: ["clear", `stream ${SPOKEN_TEXT}`, "clear", "flush"],
		yield: ["clear", "clear"],
	};

	it("records a routing for every mode the setting declares", () => {
		const declared = [...SETTINGS_SCHEMA["speech.mode"].values].sort();
		expect(Object.keys(ROUTING).sort()).toEqual(declared);
		expect(Object.keys(ABORTED).sort()).toEqual(declared);
	});

	for (const mode of SETTINGS_SCHEMA["speech.mode"].values) {
		it(`speaks what the ${mode} mode selects, in order`, async () => {
			await useSpeech(true, mode);
			expect(await play(turn())).toEqual(ROUTING[mode]);
		});

		it(`stops speech at an abort and never speaks the aborted text in the ${mode} mode`, async () => {
			await useSpeech(true, mode);
			expect(await play(turn("aborted"))).toEqual(ABORTED[mode]);
		});

		it(`speaks nothing in the ${mode} mode while speech is off`, async () => {
			await useSpeech(false, mode);
			// The turn start still silences anything left over from an earlier turn.
			expect(await play(turn())).toEqual(["clear"]);
		});
	}

	it("speaks a yield turn only when it ends on an assistant message", async () => {
		await useSpeech(true, "yield");
		const userTurnEnd: AgentSessionEvent = {
			type: "turn_end",
			message: { role: "user", content: SPOKEN_TEXT, timestamp: 0 },
			toolResults: [],
		};
		expect(await play([{ type: "turn_start" }, userTurnEnd])).toEqual(["clear"]);
	});
});
