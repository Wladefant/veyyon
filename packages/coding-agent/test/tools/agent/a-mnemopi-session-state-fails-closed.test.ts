import { describe, expect, it } from "bun:test";
import type { MnemopiSessionState } from "../../../src/memory/mnemopi/state";
import type { ToolSession } from "../../../src/tools";
import { requireMnemopiSessionState } from "../../../src/tools/agent/memory-session";

function createDummyToolSession(mnemopiState?: MnemopiSessionState): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: true,
		settings: { get: () => undefined } as unknown as ToolSession["settings"],
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getMnemopiSessionState: () => mnemopiState,
	};
}

describe("requireMnemopiSessionState", () => {
	it("returns initialized state when session provides Mnemopi state", () => {
		const dummyState = { bank: "default" } as unknown as MnemopiSessionState;
		const session = createDummyToolSession(dummyState);
		const state = requireMnemopiSessionState(session);
		expect(state).toBe(dummyState);
	});

	it("fails closed with an error when Mnemopi backend is not initialized", () => {
		const session = createDummyToolSession(undefined);
		expect(() => requireMnemopiSessionState(session)).toThrow("Mnemopi backend is not initialised for this session.");
	});

	it("fails closed when getMnemopiSessionState method is absent", () => {
		const session = {
			cwd: "/tmp",
			hasUI: true,
			settings: { get: () => undefined } as unknown as ToolSession["settings"],
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		expect(() => requireMnemopiSessionState(session)).toThrow("Mnemopi backend is not initialised for this session.");
	});
});
