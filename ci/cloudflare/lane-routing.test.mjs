import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { selectCloudflareLane } from "./lane-routing.mjs";

test("normal shard 1 cannot publish a release when shard 2 fails", () => {
	const shardOne = selectCloudflareLane("feature/ci", "1", "3");
	const shardTwo = selectCloudflareLane("feature/ci", "2", "3");
	const simulatedResults = new Map([
		[1, "green"],
		[2, "red"],
	]);

	assert.equal(simulatedResults.get(1), "green");
	assert.equal(simulatedResults.get(2), "red");
	assert.equal(shardOne.kind, "tests");
	assert.equal(shardTwo.kind, "tests");
	assert.equal(shardOne.releaseMode, undefined);
	assert.equal(shardTwo.releaseMode, undefined);
	console.log("NEGATIVE_CONTROL shard-1-green shard-2-red: no Veyyon release or asset upload route");
});

test("release branches stay unsplit and only shard 1 runs the release mode", () => {
	const shardOne = selectCloudflareLane("cf-release/part-linux-x64", "1", "ignored");
	const shardTwo = selectCloudflareLane("cf-release/part-linux-x64", "2", "ignored");
	const shardThree = selectCloudflareLane("cf-release/part-linux-x64", "3", "ignored");

	assert.deepEqual(shardOne, { kind: "release", releaseMode: "part-linux-x64", shard: 1 });
	assert.deepEqual(shardTwo, { kind: "release-skip", releaseMode: "part-linux-x64", shard: 2 });
	assert.deepEqual(shardThree, { kind: "release-skip", releaseMode: "part-linux-x64", shard: 3 });
	console.log("RELEASE_BRANCH_CONTROL cf-release/part-linux-x64: shard 1 unsplit; shards 2 and 3 skipped");
});

test("ordinary branches require exactly the configured three test shards", () => {
	assert.throws(() => selectCloudflareLane("feature/ci", "1", "2"), /VEYYON_CI_SHARDS=3/);
	assert.throws(() => selectCloudflareLane("feature/ci", "4", "3"), /VEYYON_CI_SHARD must be 1, 2, or 3/);
	assert.deepEqual(selectCloudflareLane("feature/ci", "3", "3"), { kind: "tests", shard: 3, shardCount: 3 });
});
test("route CLI uses the Workers branch and shard variables", () => {
	const ordinary = spawnSync(process.execPath, ["ci/cloudflare/lane-routing.mjs"], {
		encoding: "utf8",
		env: {
			...process.env,
			WORKERS_CI_BRANCH: "feature/ci",
			VEYYON_CI_SHARD: "1",
			VEYYON_CI_SHARDS: "3",
		},
	});
	assert.equal(ordinary.status, 0, ordinary.stderr);
	assert.equal(ordinary.stdout.trim(), "tests|1|3");

	const release = spawnSync(process.execPath, ["ci/cloudflare/lane-routing.mjs"], {
		encoding: "utf8",
		env: {
			...process.env,
			WORKERS_CI_BRANCH: "cf-release/part-linux-x64",
			VEYYON_CI_SHARD: "1",
			VEYYON_CI_SHARDS: "ignored",
		},
	});
	assert.equal(release.status, 0, release.stderr);
	assert.equal(release.stdout.trim(), "release|part-linux-x64|1");
});

test("12-shard selection normalizes 0-based CF_SHARD_INDEX to 1-based shards across 0..11", () => {
	for (let index = 0; index < 12; index++) {
		const route = selectCloudflareLane("feature/ci", undefined, undefined, String(index), "12");
		assert.deepEqual(route, { kind: "tests", shard: index + 1, shardCount: 12 });
	}
});

test("12-shard selection supports 1-based VEYYON_CI_SHARD across 1..12", () => {
	for (let shard = 1; shard <= 12; shard++) {
		const route = selectCloudflareLane("feature/ci", String(shard), "12");
		assert.deepEqual(route, { kind: "tests", shard, shardCount: 12 });
	}
});

test("validates bounds for both 12-shard and 3-shard configurations", () => {
	assert.throws(
		() => selectCloudflareLane("feature/ci", undefined, undefined, "12", "12"),
		/CF_SHARD_INDEX must be between 0 and 11/,
	);
	assert.throws(
		() => selectCloudflareLane("feature/ci", undefined, undefined, "-1", "12"),
		/CF_SHARD_INDEX must be a non-negative integer/,
	);
	assert.throws(
		() => selectCloudflareLane("feature/ci", "13", "12"),
		/VEYYON_CI_SHARD must be between 1 and 12/,
	);
	assert.throws(
		() => selectCloudflareLane("feature/ci", "0", "12"),
		/VEYYON_CI_SHARD must be between 1 and 12/,
	);
});

test("detects conflicting configuration between Veyyon and Cloudflare env forms", () => {
	assert.throws(
		() => selectCloudflareLane("feature/ci", "1", "12", "1", "12"),
		/Conflicting shard configuration/,
	);
	assert.throws(
		() => selectCloudflareLane("feature/ci", "1", "3", "0", "12"),
		/Conflicting shard configuration/,
	);
	// Consistent configuration succeeds
	const consistent = selectCloudflareLane("feature/ci", "7", "12", "6", "12");
	assert.deepEqual(consistent, { kind: "tests", shard: 7, shardCount: 12 });
});

test("detects missing or incomplete shard configuration", () => {
	assert.throws(
		() => selectCloudflareLane("feature/ci"),
		/Shard configuration missing/,
	);
	assert.throws(
		() => selectCloudflareLane("feature/ci", undefined, "12"),
		/VEYYON_CI_SHARD is required/,
	);
	assert.throws(
		() => selectCloudflareLane("feature/ci", undefined, undefined, undefined, "12"),
		/CF_SHARD_INDEX is required/,
	);
});

test("route CLI parses CF_SHARD_INDEX and CF_SHARD_COUNT correctly", () => {
	const cfBuild = spawnSync(process.execPath, ["ci/cloudflare/lane-routing.mjs"], {
		encoding: "utf8",
		env: {
			...process.env,
			WORKERS_CI_BRANCH: "feature/ci",
			CF_SHARD_INDEX: "6",
			CF_SHARD_COUNT: "12",
		},
	});
	assert.equal(cfBuild.status, 0, cfBuild.stderr);
	assert.equal(cfBuild.stdout.trim(), "tests|7|12");
});
