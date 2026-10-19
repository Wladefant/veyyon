import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function resolveCloudflareShard(config = {}) {
	const veyyonShard = config.veyyonShard ?? config.VEYYON_CI_SHARD;
	const veyyonShards = config.veyyonShards ?? config.VEYYON_CI_SHARDS;
	const cfShardIndex = config.cfShardIndex ?? config.CF_SHARD_INDEX;
	const cfShardCount = config.cfShardCount ?? config.CF_SHARD_COUNT;
	const isRelease = Boolean(config.isRelease);

	const hasVeyyonShard = veyyonShard !== undefined && String(veyyonShard).trim() !== "";
	const hasVeyyonShards = veyyonShards !== undefined && String(veyyonShards).trim() !== "";
	const hasCfIndex = cfShardIndex !== undefined && String(cfShardIndex).trim() !== "";
	const hasCfCount = cfShardCount !== undefined && String(cfShardCount).trim() !== "";

	const hasVeyyon = hasVeyyonShard || hasVeyyonShards;
	const hasCf = hasCfIndex || hasCfCount;

	if (!hasVeyyon && !hasCf) {
		throw new Error(
			"Shard configuration missing: set either VEYYON_CI_SHARD and VEYYON_CI_SHARDS, or CF_SHARD_INDEX and CF_SHARD_COUNT",
		);
	}

	let normShardA;
	let normCountA;
	if (hasVeyyon) {
		if (!hasVeyyonShard) {
			throw new Error("VEYYON_CI_SHARD is required when VEYYON_CI_SHARDS is set");
		}
		const shardText = String(veyyonShard).trim();
		if (isRelease) {
			if (!/^[1-3]$/.test(shardText) && !/^(1[0-2]|[1-9])$/.test(shardText)) {
				throw new Error("VEYYON_CI_SHARD must be 1, 2, or 3 on cf-release branches");
			}
			normShardA = Number(shardText);
			const countText = hasVeyyonShards ? String(veyyonShards).trim() : "3";
			normCountA = /^\d+$/.test(countText) ? Number(countText) : 3;
		} else {
			if (!hasVeyyonShards) {
				throw new Error("VEYYON_CI_SHARDS is required when VEYYON_CI_SHARD is set");
			}
			const countText = String(veyyonShards).trim();
			if (countText !== "3" && countText !== "12") {
				throw new Error("VEYYON_CI_SHARDS=3 is required for ordinary branches (or VEYYON_CI_SHARDS=12)");
			}
			normCountA = Number(countText);
			if (normCountA === 3) {
				if (!/^[1-3]$/.test(shardText)) {
					throw new Error("VEYYON_CI_SHARD must be 1, 2, or 3");
				}
			} else {
				if (!/^(1[0-2]|[1-9])$/.test(shardText)) {
					throw new Error("VEYYON_CI_SHARD must be between 1 and 12");
				}
			}
			normShardA = Number(shardText);
		}
	}

	let normShardB;
	let normCountB;
	if (hasCf) {
		if (!hasCfIndex) {
			throw new Error("CF_SHARD_INDEX is required when CF_SHARD_COUNT is set");
		}
		const indexText = String(cfShardIndex).trim();
		if (!/^\d+$/.test(indexText)) {
			throw new Error(`CF_SHARD_INDEX must be a non-negative integer, got ${JSON.stringify(cfShardIndex)}`);
		}
		const rawIndex = Number(indexText);

		if (isRelease) {
			const countText = hasCfCount ? String(cfShardCount).trim() : "3";
			normCountB = /^\d+$/.test(countText) ? Number(countText) : 3;
			if (rawIndex < 0 || rawIndex >= normCountB) {
				throw new Error(`CF_SHARD_INDEX must be between 0 and ${normCountB - 1}, got ${rawIndex}`);
			}
			normShardB = rawIndex + 1;
		} else {
			if (!hasCfCount) {
				throw new Error("CF_SHARD_COUNT is required when CF_SHARD_INDEX is set");
			}
			const countText = String(cfShardCount).trim();
			if (countText !== "3" && countText !== "12") {
				throw new Error("CF_SHARD_COUNT must be 3 or 12 for ordinary branches");
			}
			normCountB = Number(countText);
			if (rawIndex < 0 || rawIndex >= normCountB) {
				throw new Error(
					normCountB === 12
						? `CF_SHARD_INDEX must be between 0 and 11, got ${rawIndex}`
						: `CF_SHARD_INDEX must be between 0 and ${normCountB - 1}, got ${rawIndex}`,
				);
			}
			normShardB = rawIndex + 1;
		}
	}

	if (hasVeyyon && hasCf) {
		if (normShardA !== normShardB || normCountA !== normCountB) {
			throw new Error(
				`Conflicting shard configuration: VEYYON_CI_SHARD=${veyyonShard}/${veyyonShards} (shard ${normShardA}/${normCountA}) conflicts with CF_SHARD_INDEX=${cfShardIndex}/${cfShardCount} (shard ${normShardB}/${normCountB})`,
			);
		}
	}

	const shard = normShardA ?? normShardB;
	const shardCount = normCountA ?? normCountB;
	return { shard, shardCount };
}

export function selectCloudflareLane(
	branchOrConfig,
	shardValue,
	shardCountValue,
	cfShardIndex,
	cfShardCount,
) {
	let branch;
	let config;

	if (branchOrConfig && typeof branchOrConfig === "object") {
		config = { ...branchOrConfig };
		branch = config.WORKERS_CI_BRANCH ?? config.branch;
	} else {
		branch = branchOrConfig;
		config = {
			veyyonShard: shardValue,
			veyyonShards: shardCountValue,
			cfShardIndex,
			cfShardCount,
		};
	}

	const isRelease = typeof branch === "string" && branch.startsWith("cf-release/");
	const { shard, shardCount } = resolveCloudflareShard({
		...config,
		isRelease,
	});

	if (isRelease) {
		const releaseMode = branch.slice("cf-release/".length);
		if (!releaseMode) throw new Error("cf-release branch must name a release mode");
		return {
			kind: shard === 1 ? "release" : "release-skip",
			releaseMode,
			shard,
		};
	}

	return { kind: "tests", shard, shardCount };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const route = selectCloudflareLane(process.env);
		const output = route.kind === "tests"
			? `${route.kind}|${route.shard}|${route.shardCount}`
			: `${route.kind}|${route.releaseMode}|${route.shard}`;
		process.stdout.write(`${output}\n`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
