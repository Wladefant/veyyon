/**
 * WHY THIS SUITE EXISTS:
 * A session dying repeatedly on provider stream failures previously left only
 * debug-level `agent_end` trace records which dropped `errorMessage`, `errorStatus`,
 * and `errorId`. Without actionable trace records in the main log, root cause was
 * trapped solely in the session transcript.
 *
 * WHAT THIS SUITE CLOSES:
 * A turn ending in a provider error surfaces one warn-level log carrying
 * `provider`, `model`, `errorMessage`, `errorStatus`, and `errorId`.
 *
 * GAPS LEFT OPEN:
 * Transport-level network diagnostics remain in provider-specific log entries.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { logger } from "@veyyon/utils";
import { logProviderTurnError } from "../../src/session/agent-session";

function makeMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o",
		usage: {} as AssistantMessage["usage"],
		stopReason: "error",
		timestamp: 1,
		...overrides,
	};
}

describe("a provider turn error is logged at warn with error fields", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits a warn log with the provider error fields for stopReason:error", () => {
		const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, meta?: Record<string, unknown>) => {
			warnings.push({ message, meta });
		});

		logProviderTurnError(
			makeMessage({
				errorMessage: "stream stall: idle watchdog fired",
				errorStatus: 500,
				errorId: 42,
			}),
		);

		const warn = warnings.find(e => e.message === "agent turn ended with provider error");
		expect(warn).toBeDefined();
		expect(warn?.meta).toMatchObject({
			provider: "openai",
			model: "gpt-4o",
			errorMessage: "stream stall: idle watchdog fired",
			errorStatus: 500,
			errorId: 42,
		});
	});

	it("does not emit for a successful stop", () => {
		const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, meta?: Record<string, unknown>) => {
			warnings.push({ message, meta });
		});

		logProviderTurnError(makeMessage({ stopReason: "stop", errorMessage: undefined }));
		expect(warnings.some(e => e.message === "agent turn ended with provider error")).toBe(false);
	});
});
