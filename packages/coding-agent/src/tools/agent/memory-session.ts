import type { HindsightSessionState } from "../../memory/hindsight/state";
import type { MnemopiSessionState } from "../../memory/mnemopi/state";
import type { ToolSession } from "../index";

/**
 * Whether the configured memory backend serves the recall, reflect and retain tools.
 */
export function servesMemoryTools(session: ToolSession): boolean {
	const backend = session.settings.get("memory.backend");
	return backend === "hindsight" || backend === "mnemopi";
}

/**
 * Obtain the initialized Mnemopi session state or fail closed with a clear error.
 */
export function requireMnemopiSessionState(session: ToolSession): MnemopiSessionState {
	const state = session.getMnemopiSessionState?.();
	if (!state) {
		throw new Error("Mnemopi backend is not initialised for this session.");
	}
	return state;
}

/**
 * Obtain the initialized Hindsight session state or fail closed with a clear error.
 */
export function requireHindsightSessionState(session: ToolSession): HindsightSessionState {
	const state = session.getHindsightSessionState?.();
	if (!state) {
		throw new Error("Hindsight backend is not initialised for this session.");
	}
	return state;
}
