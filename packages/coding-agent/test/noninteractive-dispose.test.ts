/**
 * Contract: the print-mode assistant-error/aborted exit path MUST run the
 * awaited `session.dispose()` (which contains the bounded browser reaper
 * `releaseTabsForOwner`) before terminating the process. It previously called
 * `process.exit(1)` ahead of the `dispose()` at the end of `runPrintMode`, so
 * an owned Chromium survived the exit.
 */
import { describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { type PrintModeSession, runPrintMode } from "../src/modes/print-mode";
import * as telemetryExport from "../src/telemetry-export";

/** Stand-in for `process.exit`: it terminates, so nothing after it should run. */
class ProcessExit extends Error {
	constructor(readonly code: number) {
		super(`process.exit(${code})`);
	}
}

describe("print-mode error exit disposes the session before exit", () => {
	it("disposes on the assistant-error path before process.exit(1)", async () => {
		const order: string[] = [];
		const errorMsg: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "error",
			errorMessage: "boom",
			timestamp: 1,
		};
		const session: PrintModeSession = {
			subscribe: () => () => {},
			prompt: async () => false,
			displayAssistantContent: () => [],
			obfuscateProviderText: (text: string) => text,
			state: { messages: [errorMsg] },
			sessionManager: { getHeader: () => undefined },
			prepareForHeadlessAdvisorDrain: () => {},
			waitForAdvisorCatchup: async () => {
				order.push("catchup");
				return true;
			},
			dispose: async () => {
				order.push("dispose");
			},
		};

		const exitSpy = spyOn(process, "exit").mockImplementation(((code: number) => {
			order.push("exit");
			throw new ProcessExit(code);
		}) as never);
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
		const flushSpy = spyOn(telemetryExport, "flushTelemetryExport").mockImplementation(async () => {
			order.push("flush");
		});
		try {
			await runPrintMode(session, { mode: "text", initialMessage: "hi" });
		} catch (err) {
			if (!(err instanceof ProcessExit)) throw err;
		} finally {
			exitSpy.mockRestore();
			stderrSpy.mockRestore();
			flushSpy.mockRestore();
		}

		expect(order).toEqual(["catchup", "flush", "dispose", "exit"]);
	});
});
