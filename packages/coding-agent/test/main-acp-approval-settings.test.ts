import { describe, expect, it } from "bun:test";
import type { Args } from "@veyyon/coding-agent/cli/args";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { __applyLaunchSettingOverridesForTests } from "@veyyon/coding-agent/main";

function args(overrides: Partial<Args> = {}): Args {
	return {
		mode: "acp",
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		...overrides,
	};
}

describe("ACP approval settings", () => {
	it("uses auto for plain ACP when persisted approval mode is yolo", () => {
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		__applyLaunchSettingOverridesForTests(args(), settings);
		expect(settings.get("tools.approvalMode")).toBe("auto");
	});

	it("preserves explicit --approval-mode yolo", () => {
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		__applyLaunchSettingOverridesForTests(args({ approvalMode: "yolo" }), settings);
		expect(settings.get("tools.approvalMode")).toBe("yolo");
	});

	it("preserves --yolo", () => {
		const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
		__applyLaunchSettingOverridesForTests(args({ autoApprove: true }), settings);
		expect(settings.get("tools.approvalMode")).toBe("yolo");
	});

	it.each(["ask", "plan"] as const)("preserves configured %s", mode => {
		const settings = Settings.isolated({ "tools.approvalMode": mode });
		__applyLaunchSettingOverridesForTests(args(), settings);
		expect(settings.get("tools.approvalMode")).toBe(mode);
	});
});
