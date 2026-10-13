import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("PC2 installer preserves existing data and configures credential-free references", () => {
	const result = spawnSync("python3", [join(import.meta.dir, "install_pc2_test.py"), "-v"], {
		timeout: 30000,
		encoding: "utf8",
		windowsHide: true,
	});
	expect(result.error).toBeUndefined();
	expect(result.status, result.stdout + result.stderr).toBe(0);
});
