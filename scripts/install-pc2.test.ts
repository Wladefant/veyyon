import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveConfigEnvReference } from "../packages/coding-agent/src/config/config-value-resolution";

test("PC2 installer preserves existing data and configures credential-free references", () => {
	const py = process.platform === "win32" ? "python" : "python3";
	const result = spawnSync(py, [join(import.meta.dir, "install_pc2_test.py"), "-v"], {
		timeout: 30000,
		encoding: "utf8",
		windowsHide: true,
	});
	expect(result.error).toBeUndefined();
	expect(result.status, result.stdout + result.stderr).toBe(0);
});

test("PC2 device bearer references expand from environment and fail when absent", () => {
	const previous = process.env.VEYYON_DEVICE_BEARER;
	try {
		process.env.VEYYON_DEVICE_BEARER = "test-device-bearer-not-a-provider-secret";
		expect(resolveConfigEnvReference("${VEYYON_DEVICE_BEARER}")).toEqual({
			ok: true,
			value: "test-device-bearer-not-a-provider-secret",
		});
		delete process.env.VEYYON_DEVICE_BEARER;
		expect(resolveConfigEnvReference("${VEYYON_DEVICE_BEARER}").ok).toBe(false);
	} finally {
		if (previous === undefined) delete process.env.VEYYON_DEVICE_BEARER;
		else process.env.VEYYON_DEVICE_BEARER = previous;
	}
});
