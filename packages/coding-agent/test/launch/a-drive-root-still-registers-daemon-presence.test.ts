import { afterEach, describe, expect, it, vi } from "bun:test";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@veyyon/utils";
import { registerDaemonProjectPresence } from "../../src/launch/presence";

/**
 * WHY THIS EXISTS. `canonicalProjectDir` (`src/launch/paths.ts`) is the single gate every
 * daemon-presence registration passes through, and it recovered only `ENOENT` from `fs.realpath`. On a
 * Windows drive root — the report names `R:\` — `realpath` can fail with `EISDIR` instead, and that
 * throw aborted startup, so the CLI was unusable from that directory. The class this closes is not one
 * drive letter: it is "a `realpath` failure that still names a directory the caller can address must not
 * abort presence registration".
 *
 * HOW THE FAILURE IS RAISED. Measured on the Windows 11 host this suite runs on, under Bun,
 * `fs.realpath("C:\\")` SUCCEEDS and returns `C:` — so the drive root itself cannot raise the error
 * here. It is injected with the exact shape the report carries (`code: EISDIR`, `syscall: lstat`,
 * `errno: -21`) at the one path `canonicalProjectDir` resolves, which is the same call the captured
 * failure came from.
 *
 * GAP THIS DOES NOT COVER. `EISDIR` is the only extra code recovered, so a third `realpath` failure
 * code from some other Windows mount would still abort. The second case below pins that a genuine
 * permission failure still propagates, so the recovery cannot widen into "swallow everything".
 */

const EISDIR_SHAPE = { code: "EISDIR", errno: -21, syscall: "lstat" } as const;

describe("daemon presence registration from a path whose realpath fails", () => {
	const dirs: string[] = [];
	const originalRealpath = fs.realpath.bind(fs);

	async function scratch(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-eisdir-"));
		dirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) await removeWithRetries(dir);
	});

	/** Make `realpath` fail, for exactly `resolvedTarget`, with the given error. */
	function failRealpathFor(resolvedTarget: string, error: Error): () => number {
		let calls = 0;
		vi.spyOn(fs, "realpath").mockImplementation((async (p: PathLike) => {
			if (path.resolve(String(p)) === resolvedTarget) {
				calls++;
				throw error;
			}
			return originalRealpath(p);
		}) as typeof fs.realpath);
		return () => calls;
	}

	it("registers presence instead of aborting when realpath reports EISDIR", async () => {
		const projectDir = await scratch();
		const runtimeDir = path.join(projectDir, "runtime");
		const error = Object.assign(new Error("EISDIR: illegal operation on a directory"), EISDIR_SHAPE);
		const realpathCalls = failRealpathFor(path.resolve(projectDir), error);

		const presence = await registerDaemonProjectPresence(projectDir, runtimeDir);
		expect(realpathCalls()).toBe(1);
		// The presence entry is what keeps the project broker alive, so registering and
		// listing one entry is the observable contract, not the return value's shape.
		expect(await fs.readdir(path.join(runtimeDir, "clients"))).toHaveLength(1);
		await presence.close();
	});

	it("still propagates a realpath failure that does not name an addressable directory", async () => {
		const projectDir = await scratch();
		const runtimeDir = path.join(projectDir, "runtime");
		const error = Object.assign(new Error("EACCES: permission denied"), {
			errno: -13,
			syscall: "lstat",
		});
		failRealpathFor(path.resolve(projectDir), error);

		await expect(registerDaemonProjectPresence(projectDir, runtimeDir)).rejects.toThrow("permission denied");
	});
});
