/**
 * normalizeApprovalMode: undefined → auto (the shipped default); known modes +
 * aliases exact; unrecognized non-empty → ask (fail closed, never the default).
 */
import { describe, expect, it } from "bun:test";
import { normalizeApprovalMode } from "@veyyon/coding-agent/tools/core/approval";

describe("normalizeApprovalMode fail-closed property", () => {
	it("undefined maps to the shipped default", () => {
		expect(normalizeApprovalMode(undefined)).toBe("auto");
	});

	const accepted: Array<[string, string]> = [
		["plan", "plan"],
		["ask", "ask"],
		["ask-command", "ask-command"],
		["auto", "auto"],
		["always-ask", "ask"],
		["auto-edit", "ask-command"],
		["write", "ask-command"],
		["yolo", "yolo"],
	];
	for (const [input, want] of accepted) {
		it(`accepts ${input} → ${want}`, () => {
			// normalizeApprovalMode returns the narrow AutonomyLevel union; `want` is a
			// plain string, so widen the matcher to compare their runtime values.
			expect(normalizeApprovalMode(input)).toBe<string>(want);
		});
	}

	const typos = ["askk", "YOLO", "Yolo", "auto_edit", "autoedit", "full", "deny", "", " ", "null"];
	for (const t of typos) {
		it(`fail-closed ${JSON.stringify(t)} → ask`, () => {
			expect(normalizeApprovalMode(t)).toBe("ask");
		});
	}

	it("no typo reaches the default; every one lands on ask", () => {
		for (const t of ["askk", "bogus", "auto-edit ", " plan", "YOLO"]) {
			expect(normalizeApprovalMode(t)).toBe("ask");
		}
	});
});
