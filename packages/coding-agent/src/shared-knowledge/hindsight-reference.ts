import { CONTEXT_SETTINGS } from "../config/settings-domains/context";
import { scanContentForSecrets } from "./allowlist";
import type { HindsightReferenceConfig } from "./types";

const REFERENCE_NOTICE =
	"Shared Hindsight configuration reference only. Contains no credentials. No database migration is performed.";
const STRING_FIELDS = ["apiUrl", "bankId", "bankIdPrefix", "scoping", "bankMission", "retainMission", "retainMode"] as const;
const BOOLEAN_FIELDS = ["autoRecall", "autoRetain"] as const;
const ALLOWED_KEYS: Record<string, true> = {
	backend: true, _referenceNotice: true, apiUrl: true, bankId: true, bankIdPrefix: true,
	scoping: true, bankMission: true, retainMission: true, retainMode: true,
	autoRecall: true, autoRetain: true, recallTypes: true,
};

/** Validate without putting untrusted values into errors or logs. */
export function validateHindsightReference(value: unknown): asserts value is HindsightReferenceConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Hindsight reference object");
	const ref = value as Record<string, unknown>;
	if (Object.keys(ref).some(key => !Object.hasOwn(ALLOWED_KEYS, key))) throw new Error("Unknown Hindsight reference keys");
	if (ref.backend !== "hindsight" || ref._referenceNotice !== REFERENCE_NOTICE) throw new Error("Invalid Hindsight reference identity");
	for (const key of STRING_FIELDS) {
		if (ref[key] === undefined) continue;
		if (typeof ref[key] !== "string" || !ref[key] || /[\x00-\x1f\x7f]/.test(ref[key]) || !scanContentForSecrets(ref[key]).valid) throw new Error(`Invalid Hindsight reference field: ${key}`);
	}
	for (const key of ["bankId", "bankIdPrefix", "scoping", "retainMode"] as const) {
		if (ref[key] !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(ref[key] as string)) throw new Error(`Invalid Hindsight reference field: ${key}`);
	}
	if (ref.scoping !== undefined && !CONTEXT_SETTINGS["hindsight.scoping"].values.some(value => value === ref.scoping)) throw new Error("Invalid Hindsight reference field: scoping");
	if (ref.retainMode !== undefined && !CONTEXT_SETTINGS["hindsight.retainMode"].values.some(value => value === ref.retainMode)) throw new Error("Invalid Hindsight reference field: retainMode");
	for (const key of BOOLEAN_FIELDS) if (ref[key] !== undefined && typeof ref[key] !== "boolean") throw new Error(`Invalid Hindsight reference field: ${key}`);
	if (ref.recallTypes !== undefined && (!Array.isArray(ref.recallTypes) || ref.recallTypes.some(v => typeof v !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v)))) throw new Error("Invalid Hindsight reference field: recallTypes");
	if (ref.apiUrl !== undefined) {
		let url: URL;
		try { url = new URL(ref.apiUrl as string); } catch { throw new Error("Invalid Hindsight reference field: apiUrl"); }
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Credential-bearing or unsupported Hindsight URL");
	}
}

export function isHindsightReferenceConfig(value: unknown): value is HindsightReferenceConfig {
	try { validateHindsightReference(value); return true; } catch { return false; }
}

/** Extract only declared reference fields from typed options or real parsed settings. */
export function extractHindsightReference(source: Record<string, unknown>): HindsightReferenceConfig | undefined {
	const memory = source.memory && typeof source.memory === "object" && !Array.isArray(source.memory) ? source.memory as Record<string, unknown> : {};
	const nestedValue = source.hindsight ?? memory.hindsight;
	const nested = nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue) ? nestedValue as Record<string, unknown> : {};
	const direct = "backend" in source || STRING_FIELDS.some(key => key in source) || BOOLEAN_FIELDS.some(key => key in source) || "recallTypes" in source;
	if (!direct && source["memory.backend"] !== "hindsight" && memory.backend !== "hindsight" && !Object.keys(source).some(key => key.startsWith("hindsight.")) && !Object.keys(nested).length) return undefined;
	if (direct && Object.keys(source).some(key => !Object.hasOwn(ALLOWED_KEYS, key))) throw new Error("Unknown Hindsight reference keys");
	if (direct && ((source.backend !== undefined && source.backend !== "hindsight") ||
		(source._referenceNotice !== undefined && source._referenceNotice !== REFERENCE_NOTICE))) throw new Error("Invalid Hindsight reference identity");
	const ref: Record<string, unknown> = { backend: "hindsight", _referenceNotice: REFERENCE_NOTICE };
	for (const key of [...STRING_FIELDS, ...BOOLEAN_FIELDS, "recallTypes"]) {
		const value = direct ? source[key] : source[`hindsight.${key}`] ?? nested[key];
		if (value !== undefined) ref[key] = value;
	}
	validateHindsightReference(ref);
	return ref;
}

/** Keep credentials and unrelated settings on the destination machine. */
export function applyHindsightReference(reference: HindsightReferenceConfig, target: Record<string, unknown>): Record<string, unknown> {
	validateHindsightReference(reference);
	const updated = { ...target, "memory.backend": "hindsight" };
	for (const key of [...STRING_FIELDS, ...BOOLEAN_FIELDS, "recallTypes"]) {
		const value = reference[key as keyof HindsightReferenceConfig];
		if (value !== undefined) (updated as Record<string, unknown>)[`hindsight.${key}`] = Array.isArray(value) ? [...value] : value;
	}
	return updated;
}
