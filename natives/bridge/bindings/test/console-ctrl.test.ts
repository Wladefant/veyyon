import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	installConsoleCtrlHandler,
	removeConsoleCtrlHandler,
} from "../native/index.js";

describe("console control diagnostic recorder", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "console-ctrl-test-"));
	});

	afterEach(async () => {
		removeConsoleCtrlHandler();
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {}
	});

	it("rejects empty or whitespace path", () => {
		const emptyRes = installConsoleCtrlHandler("");
		expect(emptyRes.installed).toBe(false);
		expect(emptyRes.status).toBe("empty_path");
		expect(emptyRes.path).toBeUndefined();

		const wsRes = installConsoleCtrlHandler("   ");
		expect(wsRes.installed).toBe(false);
		expect(wsRes.status).toBe("empty_path");
	});

	it("installs, reinstalls, and removes on Windows or reports unsupported on other platforms", () => {
		const log1 = path.join(testDir, "test1.log");
		const log2 = path.join(testDir, "test2.log");

		const res1 = installConsoleCtrlHandler(log1);
		if (process.platform === "win32") {
			expect(res1.installed).toBe(true);
			expect(res1.supported).toBe(true);
			expect(res1.status).toBe("installed");
			expect(res1.path).toBe(log1);

			// Reinstall with a new path
			const res2 = installConsoleCtrlHandler(log2);
			expect(res2.installed).toBe(true);
			expect(res2.supported).toBe(true);
			expect(res2.status).toBe("reinstalled");
			expect(res2.path).toBe(log2);

			// Remove
			expect(removeConsoleCtrlHandler()).toBe(true);
			// Second remove is a no-op
			expect(removeConsoleCtrlHandler()).toBe(false);
		} else {
			expect(res1.installed).toBe(false);
			expect(res1.supported).toBe(false);
			expect(res1.status).toBe("unsupported_platform");
			expect(res1.path).toBeUndefined();
			expect(removeConsoleCtrlHandler()).toBe(false);
		}
	});
});
