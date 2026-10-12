import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "./worker.mjs";

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("isolated CI health Worker returns HTTP 200 and ok", async () => {
	const response = await worker.fetch(new Request("https://example.invalid/health"));
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "ok");
});

test("Workers Builds trigger covers all non-main branches and all paths", async () => {
	const trigger = await readJson("./trigger.json");
	assert.equal(trigger.build_command, "bash ci/cloudflare/lane-tests.sh");
	assert.equal(trigger.deploy_command, "npx wrangler@4 versions upload --config ci/cloudflare/wrangler.jsonc");
	assert.deepEqual(trigger.branch_includes, ["*"]);
	assert.deepEqual(trigger.branch_excludes, ["main"]);
	assert.deepEqual(trigger.path_includes, ["*"]);
});

test("health Worker configuration cannot route or publish a preview", async () => {
	const config = await readJson("./wrangler.jsonc");
	assert.equal(config.name, "veyyon-ci-health");
	assert.equal(config.main, "worker.mjs");
	assert.equal(config.compatibility_date, "2026-10-12");
	assert.equal(config.workers_dev, false);
	assert.equal(config.preview_urls, false);
	assert.deepEqual(config.routes, []);
});

test("health Worker upload targets the shared Cloudflare CI account", async () => {
	const config = await readJson("./wrangler.jsonc");
	assert.equal(config.account_id, "a0d288d1c95470cd009cc6e0df7accb7");
});
