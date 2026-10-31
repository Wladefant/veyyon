/**
 * WHY THIS EXISTS. The JS eval host and its worker exchange failures as plain payloads, because a
 * thrown `Error` does not survive the worker channel with its class. A failed tool call crosses from
 * host to worker and a failed cell crosses back, and both sides branch on what arrives: a
 * cancellation must stay a `ToolAbortError` or the run reports a cancelled cell as a crash, and a
 * `ToolError` must stay one or its message renders as an internal fault with a stack.
 *
 * WHAT IT COVERS. Every kind of thrown value the codec distinguishes, each sent through
 * `structuredClone` as the channel does: a cancellation under either name, an empty cancellation, a
 * tool error by class and by name alone, an ordinary error, and a thrown non-Error.
 *
 * WHAT IT DOES NOT CATCH. It does not start a worker, so a call site that sends a raw `Error`
 * instead of a payload is out of reach here; `js-context-manager.test.ts` drives the real channel.
 */
import { describe, expect, it } from "bun:test";
import { cancellationError } from "@veyyon/utils/abortable";
import { ToolAbortError, ToolError } from "../../tools/core/tool-errors";
import { errorFromPayload, toErrorPayload } from "../js/error-payload";

function acrossChannel(thrown: unknown): Error {
	return errorFromPayload(structuredClone(toErrorPayload(thrown)));
}

describe("an error crossing the eval worker channel", () => {
	it("arrives as a ToolAbortError when it was any cancellation, with its message and stack", () => {
		for (const thrown of [cancellationError("cell stopped"), new ToolAbortError("cell stopped")]) {
			const received = acrossChannel(thrown);
			expect(received).toBeInstanceOf(ToolAbortError);
			expect(received.message).toBe("cell stopped");
			expect(received.stack).toBe((thrown as Error).stack);
		}
	});

	it("names an empty cancellation instead of arriving blank", () => {
		const received = acrossChannel(new ToolAbortError(""));
		expect(received).toBeInstanceOf(ToolAbortError);
		expect(received.message).toBe("Execution aborted");
	});

	it("arrives as a ToolError when it was one by class or by name alone", () => {
		const renamed = new Error("path is outside the workspace");
		renamed.name = "ToolError";
		for (const thrown of [new ToolError("path is outside the workspace"), renamed]) {
			const received = acrossChannel(thrown);
			expect(received).toBeInstanceOf(ToolError);
			expect(received).not.toBeInstanceOf(ToolAbortError);
			expect(received.name).toBe("ToolError");
			expect(received.message).toBe("path is outside the workspace");
			expect(received.stack).toBe(thrown.stack);
		}
	});

	it("keeps an ordinary error's name and message without promoting it", () => {
		const thrown = new TypeError("x is not a function");
		const received = acrossChannel(thrown);
		expect(received).not.toBeInstanceOf(ToolError);
		expect(received).not.toBeInstanceOf(ToolAbortError);
		expect(received.name).toBe("TypeError");
		expect(received.message).toBe("x is not a function");
		expect(received.stack).toBe(thrown.stack);
	});

	it("turns a thrown non-Error into a plain Error carrying its string form", () => {
		expect([acrossChannel("boom"), acrossChannel(42)].map(e => [e.name, e.message])).toEqual([
			["Error", "boom"],
			["Error", "42"],
		]);
	});
});
