/**
 * normalizeApprovalMode fails closed on typos (ask, never yolo).
 */
import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode } from "../src/tools/core/approval";

describe("normalizeApprovalMode", () => {
	/**
	 * Locks the schema default and the normalizer on the same rung. `auto` is the
	 * configured default for `tools.approvalMode`, and a caller that reaches the
	 * normalizer with nothing set gets the rung a fresh install ships with, so
	 * the two must not drift: a normalizer answering anything else would hand
	 * unconfigured sessions a different autonomy than the settings screen shows.
	 */
	it("maps undefined to auto, matching the tools.approvalMode schema default", () => {
		expect(normalizeApprovalMode(undefined)).toBe("auto");
	});

	/**
	 * Locks each legacy config value onto the ladder rung that replaced it.
	 * `always-ask` became `ask`, and `write`/`auto-edit` both became
	 * `ask-command`, so an operator who never edits their settings keeps the
	 * autonomy they chose instead of silently sliding up or down the ladder.
	 */
	it("maps known modes and aliases exactly", () => {
		expect(normalizeApprovalMode("plan")).toBe("plan");
		expect(normalizeApprovalMode("ask")).toBe("ask");
		expect(normalizeApprovalMode("ask-command")).toBe("ask-command");
		expect(normalizeApprovalMode("auto")).toBe("auto");
		expect(normalizeApprovalMode("yolo")).toBe("yolo");
		expect(normalizeApprovalMode("always-ask")).toBe("ask");
		expect(normalizeApprovalMode("auto-edit")).toBe("ask-command");
		expect(normalizeApprovalMode("write")).toBe("ask-command");
	});

	it("typos and garbage fail closed to ask, never yolo", () => {
		for (const bad of ["askk", "Ask", " YOLO ", "plan ", "default", "", "null", "true"]) {
			expect(normalizeApprovalMode(bad)).toBe("ask");
			expect(normalizeApprovalMode(bad)).not.toBe("yolo");
		}
	});
});
