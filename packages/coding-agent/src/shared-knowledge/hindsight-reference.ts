import type { HindsightReferenceConfig } from "./types";

const REFERENCE_NOTICE =
	"Shared Hindsight configuration reference only. Contains no credentials. No database migration is performed.";

/**
 * Type guard for HindsightReferenceConfig.
 */
export function isHindsightReferenceConfig(value: unknown): value is HindsightReferenceConfig {
	if (!value || typeof value !== "object") {
		return false;
	}
	if (!("backend" in value) || value.backend !== "hindsight") {
		return false;
	}
	return "_referenceNotice" in value;
}

/**
 * Extracts reviewed Hindsight configuration for cross-PC sharing as a reference.
 * Strictly excludes any credentials (e.g. `apiToken`), secrets, or database state.
 */
export function extractHindsightReference(
	source: Record<string, unknown>,
): HindsightReferenceConfig | undefined {
	let backend = source["memory.backend"];
	if (backend === undefined && typeof source.memory === "object" && source.memory !== null && "backend" in source.memory) {
		const mem = source.memory as Record<string, unknown>;
		backend = mem.backend;
	}

	// If memory backend is not hindsight, check if hindsight keys are explicitly set
	const hasHindsight = backend === "hindsight" || "hindsight.apiUrl" in source || "hindsight.bankId" in source;
	if (!hasHindsight) {
		return undefined;
	}

	const ref: HindsightReferenceConfig = {
		backend: "hindsight",
		_referenceNotice: REFERENCE_NOTICE,
	};

	// Helper to extract a string field
	const apiUrl = source["hindsight.apiUrl"];
	if (typeof apiUrl === "string") {
		ref.apiUrl = apiUrl;
	}

	const bankId = source["hindsight.bankId"];
	if (typeof bankId === "string") {
		ref.bankId = bankId;
	}

	const bankIdPrefix = source["hindsight.bankIdPrefix"];
	if (typeof bankIdPrefix === "string") {
		ref.bankIdPrefix = bankIdPrefix;
	}

	const scoping = source["hindsight.scoping"];
	if (typeof scoping === "string") {
		ref.scoping = scoping;
	}

	const bankMission = source["hindsight.bankMission"];
	if (typeof bankMission === "string") {
		ref.bankMission = bankMission;
	}

	const retainMission = source["hindsight.retainMission"];
	if (typeof retainMission === "string") {
		ref.retainMission = retainMission;
	}

	const autoRecall = source["hindsight.autoRecall"];
	if (typeof autoRecall === "boolean") {
		ref.autoRecall = autoRecall;
	}

	const autoRetain = source["hindsight.autoRetain"];
	if (typeof autoRetain === "boolean") {
		ref.autoRetain = autoRetain;
	}

	const retainMode = source["hindsight.retainMode"];
	if (typeof retainMode === "string") {
		ref.retainMode = retainMode;
	}

	const recallTypes = source["hindsight.recallTypes"];
	if (Array.isArray(recallTypes)) {
		ref.recallTypes = recallTypes.filter((item): item is string => typeof item === "string");
	}

	// Double check: strictly ensure NO apiToken exists in the output
	const mutableRef = ref as Record<string, unknown>;
	if ("apiToken" in mutableRef || "hindsight.apiToken" in mutableRef) {
		delete mutableRef.apiToken;
		delete mutableRef["hindsight.apiToken"];
	}

	return ref;
}

/**
 * Merges reference Hindsight configuration into a target settings dictionary.
 * Does not overwrite existing credentials, does not inject tokens, and never
 * triggers an automated database migration.
 */
export function applyHindsightReference(
	reference: HindsightReferenceConfig,
	target: Record<string, unknown>,
): Record<string, unknown> {
	const updated = { ...target };

	updated["memory.backend"] = "hindsight";

	if (reference.apiUrl) {
		updated["hindsight.apiUrl"] = reference.apiUrl;
	}
	if (reference.bankId) {
		updated["hindsight.bankId"] = reference.bankId;
	}
	if (reference.bankIdPrefix) {
		updated["hindsight.bankIdPrefix"] = reference.bankIdPrefix;
	}
	if (reference.scoping) {
		updated["hindsight.scoping"] = reference.scoping;
	}
	if (reference.bankMission) {
		updated["hindsight.bankMission"] = reference.bankMission;
	}
	if (reference.retainMission) {
		updated["hindsight.retainMission"] = reference.retainMission;
	}
	if (reference.autoRecall !== undefined) {
		updated["hindsight.autoRecall"] = reference.autoRecall;
	}
	if (reference.autoRetain !== undefined) {
		updated["hindsight.autoRetain"] = reference.autoRetain;
	}
	if (reference.retainMode) {
		updated["hindsight.retainMode"] = reference.retainMode;
	}
	if (reference.recallTypes) {
		updated["hindsight.recallTypes"] = [...reference.recallTypes];
	}

	return updated;
}
