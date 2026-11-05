/**
 * Proxy-reference lookup over the bundled model catalog.
 *
 * A scalar lookup ({@link resolveBundledModelReference}) reads the catalog's model ids and parses
 * only the models whose ids reach the lookup's keys, then enriches the matched model's provider. The
 * full index ({@link getBundledModelReferenceIndex}) enriches every provider and is built once, on
 * first request. Consumers that need non-bundled reference data use the pure builder directly
 * ({@link buildModelReferenceIndex}).
 *
 * A compiled build stores which bundled model each scalar lookup resolved to, or that it resolved to
 * none, in the profile's model-reference cache under the build's id. A later launch of the same build
 * reads the answer from there instead of indexing the catalog's 4,400 model ids, which is about 4 ms of
 * a launch whose model is a custom one.
 */
import { BuildStore } from "@veyyon/utils/build-store";
import { getModelReferenceCachePath } from "@veyyon/utils/dirs";
import {
	type BundledModelKeys,
	type GeneratedProvider,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	readBundledModelKeys,
} from "../models";
import type { Api, Model } from "../types";
import {
	buildModelReferenceIndex,
	createLazyModelReferenceIndex,
	type ModelReferenceCandidate,
	type ModelReferenceIndex,
	type ModelReferenceLookup,
	resolveModelReference,
} from "./reference";

/** A stored answer: the bundled model's provider and id, or null when the id resolved to none. */
type StoredReference = readonly [provider: string, id: string] | null;

function isStoredReference(value: unknown): value is StoredReference {
	return (
		value === null ||
		(Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "string")
	);
}

/**
 * The answers of the running build. An answer depends on the catalog the build embeds and on the lookup
 * rules it was built with, so it is keyed by the build id; a run from source has none and stores nothing.
 */
const referenceStore = new BuildStore<StoredReference>({
	build: process.env.VEYYON_BUILD_ID,
	filePath: getModelReferenceCachePath,
	version: 1,
	isValue: isStoredReference,
});

let bundledModels: readonly Model<Api>[] | undefined;

function getBundledModelList(): readonly Model<Api>[] {
	bundledModels ??= getBundledProviders().flatMap(
		provider => getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[],
	);
	return bundledModels;
}

let referenceIndex: ModelReferenceIndex | undefined;

/**
 * The lookup over one read of the catalog's model ids. Keyed weakly: the read is released when the
 * task that made it ends, and the lookup and the records it parsed go with it.
 */
const metadataLookups = new WeakMap<BundledModelKeys, ModelReferenceLookup<ModelReferenceCandidate>>();

/** Proxy-reference index over the bundled catalog. */
export function getBundledModelReferenceIndex(): ModelReferenceIndex {
	referenceIndex ??= buildModelReferenceIndex(getBundledModelList());
	return referenceIndex;
}

/**
 * Resolve a (possibly proxied/affixed) model id to its bundled upstream reference,
 * enriching only the matched model's provider rather than the entire catalog.
 */
export function resolveBundledModelReference(modelId: string): Model<Api> | undefined {
	if (referenceIndex) {
		return resolveModelReference(modelId, referenceIndex);
	}
	const stored = referenceStore.get(modelId);
	if (stored !== undefined) {
		return stored === null ? undefined : getBundledModel(stored[0] as GeneratedProvider, stored[1]);
	}
	const keys = readBundledModelKeys();
	let lookup = metadataLookups.get(keys);
	if (lookup === undefined) {
		lookup = createLazyModelReferenceIndex(keys.ids, keys.candidateAt);
		metadataLookups.set(keys, lookup);
	}
	const candidate = resolveModelReference(modelId, lookup);
	referenceStore.put(modelId, candidate ? [candidate.provider, candidate.id] : null);
	if (!candidate) {
		return undefined;
	}
	return getBundledModel(candidate.provider as GeneratedProvider, candidate.id);
}
