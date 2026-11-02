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
import { applyOwnerOnlyWindowsAcl, verifyOwnerOnlyWindowsAcl, verifyOwnerOnlyWindowsAclSync } from "../src/windows-acl";

test.skipIf(process.platform !== "win32")(
	"private ACL verification has no shell startup dependency",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-acl-launch-"));
		try {
			const record = path.join(directory, "owner.json");
			await fs.writeFile(record, "{}");
			await applyOwnerOnlyWindowsAcl(directory);
			await applyOwnerOnlyWindowsAcl(record);
			const spawn = vi.spyOn(childProcess, "spawn");
			const spawnSync = vi.spyOn(childProcess, "spawnSync");
			for (let index = 0; index < 5; index++) {
				await verifyOwnerOnlyWindowsAcl(directory);
				await verifyOwnerOnlyWindowsAcl(record);
				verifyOwnerOnlyWindowsAclSync(record);
			}
			expect(spawn).not.toHaveBeenCalled();
			expect(spawnSync).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	120_000,
);
