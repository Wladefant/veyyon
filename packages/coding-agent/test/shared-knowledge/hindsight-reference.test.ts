import { describe, expect, it } from "bun:test";
import {
	applyHindsightReference,
	extractHindsightReference,
	isHindsightReferenceConfig,
	validateHindsightReference,
} from "../../src/shared-knowledge/hindsight-reference";
import type { HindsightReferenceConfig } from "../../src/shared-knowledge/types";

const NOTICE = "Shared Hindsight configuration reference only. Contains no credentials. No database migration is performed.";

function reference(overrides: Record<string, unknown> = {}): HindsightReferenceConfig {
	return {
		backend: "hindsight",
		_referenceNotice: NOTICE,
		apiUrl: "https://hindsight.example.com",
		bankId: "team-memory",
		scoping: "per-project-tagged",
		retainMode: "full-session",
		autoRecall: true,
		autoRetain: false,
		recallTypes: ["observation"],
		...overrides,
	} as unknown as HindsightReferenceConfig;
}

function refusalOf(value: unknown): string {
	try {
		validateHindsightReference(value);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the reference to be refused");
}

describe("validateHindsightReference", () => {
	it("accepts a reference that carries only declared, credential-free fields", () => {
		expect(() => validateHindsightReference(reference())).not.toThrow();
		expect(isHindsightReferenceConfig(reference())).toBe(true);
	});

	it("refuses a non-object and an arrayed value", () => {
		expect(refusalOf(null)).toBe("Invalid Hindsight reference object");
		expect(refusalOf([])).toBe("Invalid Hindsight reference object");
	});

	it("refuses an unknown key, which is where a credential would arrive", () => {
		expect(refusalOf(reference({ apiKey: "x" }))).toBe("Unknown Hindsight reference keys");
	});

	it("refuses a wrong backend or a wrong reference notice", () => {
		expect(refusalOf(reference({ backend: "other" }))).toBe("Invalid Hindsight reference identity");
		expect(refusalOf(reference({ _referenceNotice: "anything" }))).toBe("Invalid Hindsight reference identity");
	});

	it("refuses a credential-bearing, query-bearing, or non-http API URL", () => {
		expect(refusalOf(reference({ apiUrl: "https://user:pw@hindsight.example.com" }))).toBe(
			"Credential-bearing or unsupported Hindsight URL",
		);
		expect(refusalOf(reference({ apiUrl: "https://hindsight.example.com/?token=1" }))).toBe(
			"Credential-bearing or unsupported Hindsight URL",
		);
		expect(refusalOf(reference({ apiUrl: "ftp://hindsight.example.com" }))).toBe(
			"Credential-bearing or unsupported Hindsight URL",
		);
		expect(refusalOf(reference({ apiUrl: "not a url" }))).toBe("Invalid Hindsight reference field: apiUrl");
	});

	it("refuses a string field that carries a control character or a secret", () => {
		const secret = ["sk", "a".repeat(24)].join("-");
		expect(refusalOf(reference({ bankMission: `use ${secret}` }))).toBe(
			"Invalid Hindsight reference field: bankMission",
		);
		expect(refusalOf(reference({ bankMission: "line\nbreak" }))).toBe(
			"Invalid Hindsight reference field: bankMission",
		);
	});

	it("refuses an identifier with a space, a scoping outside the setting's values, and a retain mode outside them", () => {
		expect(refusalOf(reference({ bankId: "team memory" }))).toBe("Invalid Hindsight reference field: bankId");
		expect(refusalOf(reference({ scoping: "galaxy" }))).toBe("Invalid Hindsight reference field: scoping");
		expect(refusalOf(reference({ retainMode: "weekly" }))).toBe("Invalid Hindsight reference field: retainMode");
	});

	it("refuses a non-boolean flag and a recall type list with a non-string member", () => {
		expect(refusalOf(reference({ autoRecall: "yes" }))).toBe("Invalid Hindsight reference field: autoRecall");
		expect(refusalOf(reference({ recallTypes: ["ok", 3] }))).toBe("Invalid Hindsight reference field: recallTypes");
	});
});

describe("extractHindsightReference", () => {
	it("reads only the declared fields from a flat settings map", () => {
		const extracted = extractHindsightReference({
			"memory.backend": "hindsight",
			"hindsight.bankId": "team-memory",
			"hindsight.autoRecall": true,
			"ui.theme": "dark",
		});
		expect(extracted).toEqual({
			backend: "hindsight",
			_referenceNotice: NOTICE,
			bankId: "team-memory",
			autoRecall: true,
		});
	});

	it("reads the nested memory form", () => {
		expect(extractHindsightReference({ memory: { backend: "hindsight", hindsight: { bankId: "b1" } } })).toEqual({
			backend: "hindsight",
			_referenceNotice: NOTICE,
			bankId: "b1",
		});
	});

	it("returns undefined when the settings do not select hindsight", () => {
		expect(extractHindsightReference({ "ui.theme": "dark" })).toBeUndefined();
	});

	it("refuses a direct form that carries an unknown key or another backend", () => {
		expect(() => extractHindsightReference({ backend: "hindsight", bogus: 1 })).toThrow(
			"Unknown Hindsight reference keys",
		);
		expect(() => extractHindsightReference({ backend: "mem0" })).toThrow("Invalid Hindsight reference identity");
	});
});

describe("applyHindsightReference", () => {
	it("writes the reference fields onto the target and keeps the destination's own settings and credentials", () => {
		const reviewed = reference({ bankIdPrefix: undefined });
		const target: Record<string, unknown> = { theme: "dark", "hindsight.apiKey": "keep-local" };
		const updated = applyHindsightReference(reviewed, target);

		expect(updated.theme).toBe("dark");
		expect(updated["hindsight.apiKey"]).toBe("keep-local");
		expect(updated["memory.backend"]).toBe("hindsight");
		expect(updated["hindsight.bankId"]).toBe("team-memory");
		expect(updated["hindsight.autoRetain"]).toBe(false);
		expect(updated["hindsight.backend"]).toBeUndefined();
		expect(Object.hasOwn(updated, "hindsight.bankIdPrefix")).toBe(false);
		expect(updated["hindsight.recallTypes"]).toEqual(["observation"]);
		expect(updated["hindsight.recallTypes"]).not.toBe(reviewed.recallTypes);
	});

	it("refuses to apply a reference that fails validation", () => {
		expect(() => applyHindsightReference(reference({ _referenceNotice: "x" }), {})).toThrow(
			"Invalid Hindsight reference identity",
		);
	});
});
