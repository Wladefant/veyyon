/**
 * Veyyon CI Shard Partition Adapter (v1)
 *
 * Partitions test suites across Cloudflare Workers CI shards based strictly on
 * observed suite durations from remote audit runs.
 *
 * NOTE: Runtime estimates are never invented and timeout prevention is not
 * promised without remote execution proof. Partition assignments reflect historical
 * execution measurements recorded in audit inventory and prior run reviews.
 */

/**
 * Observed suite execution costs (in seconds) measured on Cloudflare Workers Builds Linux x64:
 * - tests/simulations: ~440.6s (Shard 3 baseline)
 * - plugins/hashline: ~379.0s (Shard 2 modern)
 * - packages/ai: ~76.8s (Shard 1 baseline)
 * - packages/agent: ~70.6s (Shard 1 baseline)
 * - packages/utils: ~40.7s (Shard 1 baseline)
 * - natives/bridge/bindings: ~25.0s (Shards 1 and 2 native mode)
 * - packages/catalog: ~15.0s (Shard 1 baseline)
 * - health-worker: ~4.5s (Shard 1 baseline)
 */
export const OBSERVED_SUITE_DURATIONS_SECONDS = Object.freeze({
	"tests/simulations": 440.6,
	"plugins/hashline": 379.0,
	"packages/ai": 76.8,
	"packages/agent": 70.6,
	"packages/utils": 40.7,
	"natives/bridge/bindings": 25.0,
	"packages/catalog": 15.0,
	"health-worker": 4.5,
	"plugins/argot": 8.2,
	"apps/stats": 12.4,
	"packages/tool-render": 14.1,
	"plugins/mode-swarm": 9.5,
	"plugins/mnemopi": 18.0,
	"plugins/web": 11.3,
});

export const DEFAULT_EXPECTED_SHARDS = 3;

/**
 * Explicit shard mapping based on observed execution times:
 * - Shard 1: health-worker, packages/ai, packages/agent, packages/utils, packages/catalog,
 *            packages/tool-render, scripts, and natives/bridge/bindings (baseline)
 * - Shard 2: plugins/hashline, plugins/argot, plugins/mode-swarm, plugins/web,
 *            and natives/bridge/bindings (modern)
 * - Shard 3: tests/simulations, apps/stats, plugins/mnemopi (baseline)
 */
export const SUITE_SHARD_ASSIGNMENTS = Object.freeze({
	"health-worker": 1,
	"packages/ai": 1,
	"packages/agent": 1,
	"packages/utils": 1,
	"packages/catalog": 1,
	"packages/tool-render": 1,
	scripts: 1,

	"plugins/hashline": 2,
	"plugins/argot": 2,
	"plugins/mode-swarm": 2,
	"plugins/web": 2,

	"tests/simulations": 3,
	"apps/stats": 3,
	"plugins/mnemopi": 3,
});

/**
 * Resolves the assigned shard for a given suite name.
 *
 * @param {string} suiteName - The name or path of the test suite/bucket.
 * @param {number} [expectedShards=3] - Total number of expected shards.
 * @returns {number | number[]} Assigned shard index (1-based), or array of shards if multi-shard.
 */
export function resolveShardForSuite(suiteName, expectedShards = DEFAULT_EXPECTED_SHARDS) {
	if (typeof suiteName !== "string" || !suiteName.trim()) {
		throw new TypeError("suiteName must be a non-empty string");
	}
	const normalized = suiteName.trim();

	// Native bindings run on both Shard 1 (baseline) and Shard 2 (modern)
	if (
		normalized === "natives/bridge/bindings" ||
		normalized.startsWith("natives/bridge/bindings/") ||
		normalized === "native"
	) {
		return [1, 2];
	}

	if (expectedShards === 3) {
		if (normalized in SUITE_SHARD_ASSIGNMENTS) {
			return SUITE_SHARD_ASSIGNMENTS[normalized];
		}
		for (const [prefix, shard] of Object.entries(SUITE_SHARD_ASSIGNMENTS)) {
			if (normalized.startsWith(`${prefix}/`) || normalized.startsWith(`${prefix} `)) {
				return shard;
			}
		}
	}

	// Deterministic fallback based on suite name hash if unmapped or custom shard count
	let hash = 0;
	for (let i = 0; i < normalized.length; i++) {
		hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
	}
	return (hash % expectedShards) + 1;
}

/**
 * Determines whether a suite should run on the given shard.
 *
 * @param {string} suiteName
 * @param {number} shardId - 1-based shard ID
 * @param {number} [expectedShards=3]
 * @returns {boolean}
 */
export function isSuiteAssignedToShard(suiteName, shardId, expectedShards = DEFAULT_EXPECTED_SHARDS) {
	if (!Number.isSafeInteger(shardId) || shardId < 1 || shardId > expectedShards) {
		throw new RangeError(`shardId must be between 1 and ${expectedShards}`);
	}
	const assigned = resolveShardForSuite(suiteName, expectedShards);
	if (Array.isArray(assigned)) {
		return assigned.includes(shardId);
	}
	return assigned === shardId;
}

/**
 * Filters a list of test suites to only those assigned to the specified shard.
 *
 * @param {readonly string[]} suites
 * @param {number} shardId
 * @param {number} [expectedShards=3]
 * @returns {string[]}
 */
export function filterSuitesForShard(suites, shardId, expectedShards = DEFAULT_EXPECTED_SHARDS) {
	if (!Array.isArray(suites)) {
		throw new TypeError("suites must be an array");
	}
	return suites.filter((suite) => isSuiteAssignedToShard(suite, shardId, expectedShards));
}

/**
 * Partitions an array of suites across all expected shards.
 *
 * @param {readonly string[]} suites
 * @param {number} [expectedShards=3]
 * @returns {Record<number, string[]>}
 */
export function partitionAllSuites(suites, expectedShards = DEFAULT_EXPECTED_SHARDS) {
	if (!Array.isArray(suites)) {
		throw new TypeError("suites must be an array");
	}
	/** @type {Record<number, string[]>} */
	const partitions = {};
	for (let s = 1; s <= expectedShards; s++) {
		partitions[s] = [];
	}
	for (const suite of suites) {
		const assigned = resolveShardForSuite(suite, expectedShards);
		if (Array.isArray(assigned)) {
			for (const shardId of assigned) {
				if (partitions[shardId]) partitions[shardId].push(suite);
			}
		} else if (partitions[assigned]) {
			partitions[assigned].push(suite);
		}
	}
	return partitions;
}

/**
 * Calculates the observed historical duration for a shard based on assigned suites.
 *
 * @param {number} shardId
 * @param {readonly string[]} suites
 * @returns {{ observedSeconds: number, measuredSuites: string[], unmeasuredSuites: string[] }}
 */
export function calculateObservedShardDuration(shardId, suites) {
	const assignedSuites = filterSuitesForShard(suites, shardId);
	let observedSeconds = 0;
	const measuredSuites = [];
	const unmeasuredSuites = [];

	for (const suite of assignedSuites) {
		const duration = OBSERVED_SUITE_DURATIONS_SECONDS[suite];
		if (typeof duration === "number") {
			observedSeconds += duration;
			measuredSuites.push(suite);
		} else {
			unmeasuredSuites.push(suite);
		}
	}

	return {
		observedSeconds,
		measuredSuites,
		unmeasuredSuites,
	};
}
