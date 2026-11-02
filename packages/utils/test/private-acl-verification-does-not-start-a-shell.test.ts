/**
 * WHY: each discovery read launched two PowerShell processes. Under concurrent lane startup their
 * 15-second deadlines expired before ACL verification, refusing unrelated child sessions.
 * The real protected file must be checked without starting a shell, including cold native setup.
 * This guards local NTFS verification, not remote filesystem latency or ACL application.
 */
import { expect, test, vi } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readOwnerOnlyFile, readOwnerOnlyFileSync } from "../src/owner-only-read";
import { applyOwnerOnlyWindowsAcl } from "../src/windows-acl";

test.skipIf(process.platform !== "win32")(
	"private ACL verification has no shell startup dependency",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-acl-launch-"));
		try {
			const record = path.join(directory, "owner.json");
			await fs.writeFile(record, '{"kind":"terminal-owner"}');
			await applyOwnerOnlyWindowsAcl(directory);
			await applyOwnerOnlyWindowsAcl(record);
			const unavailable = () => {
				throw new Error("PowerShell startup unavailable");
			};
			vi.spyOn(childProcess, "spawn").mockImplementation(unavailable);
			vi.spyOn(childProcess, "spawnSync").mockImplementation(unavailable);
			expect(await readOwnerOnlyFile(record)).toBe('{"kind":"terminal-owner"}');
			expect(readOwnerOnlyFileSync(record)).toBe('{"kind":"terminal-owner"}');
			const inherited = path.join(directory, "inherited.json");
			await fs.writeFile(inherited, '{"kind":"untrusted"}');
			await expect(readOwnerOnlyFile(inherited)).rejects.toThrow("ACL inheritance is enabled");
			expect(() => readOwnerOnlyFileSync(inherited)).toThrow("ACL inheritance is enabled");
		} finally {
			vi.restoreAllMocks();
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	120_000,
);
