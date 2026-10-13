import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function selectCloudflareLane(branch, shardValue, shardCountValue) {
	const shardText = String(shardValue ?? "");
	const shard = Number(shardText);

	if (typeof branch === "string" && branch.startsWith("cf-release/")) {
		if (!/^[1-3]$/.test(shardText)) {
			throw new Error("VEYYON_CI_SHARD must be 1, 2, or 3 on cf-release branches");
		}
		const releaseMode = branch.slice("cf-release/".length);
		if (!releaseMode) throw new Error("cf-release branch must name a release mode");
		return {
			kind: shard === 1 ? "release" : "release-skip",
			releaseMode,
			shard,
		};
	}

	if (!/^[1-3]$/.test(shardText)) {
		throw new Error("VEYYON_CI_SHARD must be 1, 2, or 3");
	}
	if (shardCountValue !== "3") throw new Error("VEYYON_CI_SHARDS=3 is required for ordinary branches");
	return { kind: "tests", shard, shardCount: 3 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const route = selectCloudflareLane(
			process.env.WORKERS_CI_BRANCH,
			process.env.VEYYON_CI_SHARD,
			process.env.VEYYON_CI_SHARDS,
		);
		const output = route.kind === "tests"
			? `${route.kind}|${route.shard}|${route.shardCount}`
			: `${route.kind}|${route.releaseMode}|${route.shard}`;
		process.stdout.write(`${output}\n`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
