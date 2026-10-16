/**
 * The resolved-model stage: the discovery-derived model layers and provider discovery states the
 * registry resolves at launch, persisted beside the model cache as `resolved-models.json` so the
 * next launch restores them instead of resolving them again.
 *
 * The file is a JSON snapshot keyed by a fingerprint the registry computes; a fingerprint or
 * checksum mismatch, an invalid record, or a timestamp from the future reads as a miss, never as
 * a partial restore.
 */
import type { Api, Model } from "@veyyon/ai/types";
import { shareCompat } from "@veyyon/catalog/compat/share";
import { errorMessage, isRecord, logger } from "@veyyon/utils";
import { readJsonSnapshotSync, writeJsonSnapshotSync } from "@veyyon/utils/json-snapshot";
import type { ProviderDiscoveryState, ProviderDiscoveryStatus } from "./model-registry";

const PROVIDER_DISCOVERY_STATUSES: ReadonlySet<string> = new Set<ProviderDiscoveryStatus>([
	"idle",
	"ok",
	"empty",
	"cached",
	"unavailable",
	"unauthenticated",
]);

/**
 * Bump when the persisted static stage's contract changes: the resolved record
 * shape, a hardcoded model policy, or the merge semantics feeding the registry's
 * model load. The version prefixes every fingerprint, so old files miss instead of
 * serving state produced under retired rules — the same discipline as
 * `CACHE_SCHEMA_VERSION` in `@veyyon/catalog/model-cache`.
 */
export const REGISTRY_SNAPSHOT_VERSION = 10;

/** The resolved layers the registry's model load hands the writer, before compat is tabled. */
export interface StaticModelLayers {
	createdAt: number;
	// Persisted as an array: JSON.stringify turns a Set into `{}` and the
	// reader's Array.isArray guard would then reject every restore.
	cachedStandard: { models: Model<Api>[]; authoritativeFreshProviders: string[] };
	cachedDiscoveries: Model<Api>[];
	discoveryStates: ProviderDiscoveryState[];
}

/** A resolved model as the stage stores it: `compat` is an index into the stage's `compats`. */
type StagedModel = Omit<Model<Api>, "compat"> & { compat?: number };

interface StaticModelStage {
	createdAt: number;
	/**
	 * Each distinct compat record once. The layers resolve thousands of models over a few dozen
	 * records, and a copy per model was 64% of the file and of the text parsed at every launch.
	 */
	compats: Model<Api>["compat"][];
	cachedStandard: { models: StagedModel[]; authoritativeFreshProviders: string[] };
	cachedDiscoveries: StagedModel[];
	discoveryStates: ProviderDiscoveryState[];
}

/** What the reader hands back: the persisted array is a `Set` again by here. */
export interface RestoredStaticStage {
	cachedStandard: { models: Model<Api>[]; authoritativeFreshProviders: Set<string> };
	cachedDiscoveries: Model<Api>[];
	discoveryStates: ProviderDiscoveryState[];
}

/** Restore verified records, then validate the model and discovery-state shapes. `null` is a miss. */
export function readStaticModelStage(file: string, fingerprint: string): RestoredStaticStage | null {
	try {
		const stage = readJsonSnapshotSync(file, fingerprint);
		if (!isRecord(stage)) return null;
		const now = Date.now();
		if (typeof stage.createdAt !== "number" || !Number.isFinite(stage.createdAt) || now < stage.createdAt) {
			return null;
		}
		if (!isRecord(stage.cachedStandard)) return null;
		const compats = snapshotCompatTable(stage.compats);
		if (!compats) return null;
		const cachedStandard = snapshotModelArray(stage.cachedStandard.models, compats);
		const cachedDiscoveries = snapshotModelArray(stage.cachedDiscoveries, compats);
		if (!cachedStandard || !cachedDiscoveries) return null;
		if (!Array.isArray(stage.cachedStandard.authoritativeFreshProviders)) return null;
		const authoritativeFreshProviders = stage.cachedStandard.authoritativeFreshProviders.filter(
			(provider): provider is string => typeof provider === "string",
		);
		if (authoritativeFreshProviders.length !== stage.cachedStandard.authoritativeFreshProviders.length) return null;
		const discoveryStates = snapshotDiscoveryStateArray(stage.discoveryStates);
		if (!discoveryStates) return null;
		return {
			cachedStandard: {
				models: cachedStandard,
				authoritativeFreshProviders: new Set(authoritativeFreshProviders),
			},
			cachedDiscoveries,
			discoveryStates,
		};
	} catch {
		return null;
	}
}

/** Persist `layers` under `fingerprint`. A failed write is logged and leaves the next launch to miss. */
export function writeStaticModelStage(file: string, fingerprint: string, layers: StaticModelLayers): void {
	try {
		const compats: Model<Api>["compat"][] = [];
		const compatIndex = new Map<Model<Api>["compat"], number>();
		const stage: StaticModelStage = {
			createdAt: layers.createdAt,
			compats,
			cachedStandard: {
				models: stageModels(layers.cachedStandard.models, compats, compatIndex),
				authoritativeFreshProviders: layers.cachedStandard.authoritativeFreshProviders,
			},
			cachedDiscoveries: stageModels(layers.cachedDiscoveries, compats, compatIndex),
			discoveryStates: layers.discoveryStates,
		};
		writeJsonSnapshotSync(file, fingerprint, stage);
	} catch (error) {
		logger.debug("Static model stage snapshot not written", { error: errorMessage(error) });
	}
}

function stageModels(
	models: readonly Model<Api>[],
	compats: Model<Api>["compat"][],
	compatIndex: Map<Model<Api>["compat"], number>,
): StagedModel[] {
	return models.map(model => {
		const compat = model.compat;
		if (compat === undefined) return { ...model, compat: undefined };
		let index = compatIndex.get(compat);
		if (index === undefined) {
			index = compats.length;
			compats.push(compat);
			compatIndex.set(compat, index);
		}
		return { ...model, compat: index };
	});
}

/**
 * Validate the stage's compat table and share each record with every live model whose compat
 * is equal, as `buildModel` shares it. One call per distinct record rather than one per model.
 */
function snapshotCompatTable(value: unknown): Model<Api>["compat"][] | null {
	if (!Array.isArray(value) || !value.every(isRecord)) return null;
	return value.map(record => shareCompat(record as Model<Api>["compat"]));
}

/**
 * Validate an array of persisted model records shallowly and resolve each compat index against
 * `compats`. The snapshot's CRC-32 detects a payload other than the bytes this format's writer
 * produced; the guards reject invalid records, and an index naming no table entry, even when an
 * external writer recomputed the checksum.
 */
function snapshotModelArray(value: unknown, compats: readonly Model<Api>["compat"][]): Model<Api>[] | null {
	if (!Array.isArray(value)) return null;
	for (const entry of value) {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			typeof entry.provider !== "string" ||
			typeof entry.api !== "string"
		) {
			return null;
		}
		const index = entry.compat;
		if (index === undefined) continue;
		if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= compats.length) return null;
		entry.compat = compats[index];
	}
	// Shape-checked above; the record contract itself is owned by the writer.
	return value as Model<Api>[];
}

function snapshotDiscoveryStateArray(value: unknown): ProviderDiscoveryState[] | null {
	if (!Array.isArray(value)) return null;
	const states: ProviderDiscoveryState[] = [];
	for (const entry of value) {
		if (
			!isRecord(entry) ||
			typeof entry.provider !== "string" ||
			typeof entry.status !== "string" ||
			!PROVIDER_DISCOVERY_STATUSES.has(entry.status) ||
			typeof entry.optional !== "boolean" ||
			typeof entry.stale !== "boolean" ||
			(entry.fetchedAt !== undefined &&
				(typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt))) ||
			!Array.isArray(entry.models) ||
			!entry.models.every(model => typeof model === "string") ||
			(entry.error !== undefined && typeof entry.error !== "string")
		) {
			return null;
		}
		// Every field of ProviderDiscoveryState is checked above, including the
		// status union; the compiler cannot narrow a Record to it.
		states.push(entry as unknown as ProviderDiscoveryState);
	}
	return states;
}
