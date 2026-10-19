import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readLaneTargets } from "./lane-targets.mjs";

const script = fileURLToPath(new URL("./lane-targets.mjs", import.meta.url));

test("readLaneTargets keeps listed paths in order and ignores blank and # lines", () => {
	const targets = readLaneTargets(
		"# selector proof\r\n\n  scripts/a.test.ts  \n# middle\n./scripts/b.test.ts\n\n",
	);
	assert.deepEqual(targets, ["scripts/a.test.ts", "scripts/b.test.ts"]);
});

test("readLaneTargets rejects a manifest that names no test path", () => {
	assert.throws(() => readLaneTargets("# only comments\n   \n"), /lists no test paths/);
});

test("CLI prints the targets one per line", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-targets-"));
	try {
		const manifest = path.join(dir, "lane-targets.txt");
		fs.writeFileSync(manifest, "# x\nscripts/a.test.ts\n\nscripts/b.test.ts\n");
		const result = spawnSync(process.execPath, [script, manifest], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout, "scripts/a.test.ts\nscripts/b.test.ts\n");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI exits non-zero when the manifest is missing, so the lane fails loudly", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-targets-"));
	try {
		const result = spawnSync(process.execPath, [script, path.join(dir, "absent.txt")], {
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /ERROR: /);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
