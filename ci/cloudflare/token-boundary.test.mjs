import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const lane = new URL("./lane-tests.sh", import.meta.url);

test("repository child boundary strips Cloudflare token and preserves other env", () => {
	const sentinel = "fake-cloudflare-token-for-boundary-test";
	const parentBefore = process.env.CLOUDFLARE_API_TOKEN;
	const child = spawnSync(
		"bash",
		[
			lane.pathname,
			"--test-token-boundary",
			"node",
			"-e",
			"if (process.env.CLOUDFLARE_API_TOKEN !== undefined || process.env.BOUNDARY_ORDINARY_VALUE !== 'kept') process.exit(7)",
		],
		{
			encoding: "utf8",
			env: { ...process.env, CLOUDFLARE_API_TOKEN: sentinel, BOUNDARY_ORDINARY_VALUE: "kept" },
		},
	);

	assert.equal(child.status, 0, `child boundary failed: ${child.stderr}`);
	assert.equal(child.stdout, "");
	assert.equal(process.env.CLOUDFLARE_API_TOKEN, parentBefore);
});
