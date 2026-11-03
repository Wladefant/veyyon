/**
 * Owner-only discovery reads. Each case writes a real file with a real mode or ACL and asserts what the
 * async and sync readers return or refuse. No module is mocked.
 *
 * WHY: a discovery record another local user can read or write is not proof of ownership. A reader that
 * parses one anyway can be steered by a planted record. The cases below pin the refusal, and the
 * matching owner-only control proves the refusal is not a blanket failure.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyOwnerOnlyWindowsAcl, readOwnerOnlyFile, readOwnerOnlyFileSync } from "@veyyon/utils";

const posix = process.platform !== "win32";
const tempDirs: string[] = [];

/**
 * The reader run in a child process. A blocking FIFO open never returns, so the parent gives the child a
 * hard deadline and a hang becomes a failed test rather than a stuck suite.
 */
// Exception to the static-import rule: this dynamic import lives in a string run by the child interpreter,
// not in this module's graph. The child must load the reader itself, and its path arrives at run time in
// OWNER_ONLY_READ_MODULE, so no static import can express it.
const READER_CHILD = `
(async () => {
	const { readOwnerOnlyFile, readOwnerOnlyFileSync } = await import(process.env.OWNER_ONLY_READ_MODULE);
	const file = process.env.OWNER_ONLY_READ_FILE;
	try {
		const text =
			process.env.OWNER_ONLY_READ_MODE === "async" ? await readOwnerOnlyFile(file) : readOwnerOnlyFileSync(file);
		process.stdout.write(text);
	} catch (error) {
		process.stderr.write(error instanceof Error ? error.message : String(error));
		process.exit(3);
	}
})();
`;
const READER_MODULE = new URL("../src/owner-only-read.ts", import.meta.url).href;
const READER_DEADLINE_MS = 10_000;

function readInChild(file: string, mode: "async" | "sync"): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, ["-e", READER_CHILD], {
		env: {
			...process.env,
			OWNER_ONLY_READ_MODULE: READER_MODULE,
			OWNER_ONLY_READ_FILE: file,
			OWNER_ONLY_READ_MODE: mode,
		},
		encoding: "utf8",
		timeout: READER_DEADLINE_MS,
		killSignal: "SIGKILL",
		windowsHide: true,
	});
}

async function tempRecord(mode: number, body = '{"version":1}'): Promise<string> {
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
	tempDirs.push(dir);
	const file = path.join(dir, "record.json");
	await fsp.writeFile(file, body);
	if (posix) await fsp.chmod(file, mode);
	return file;
}

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("owner-only discovery reads on POSIX", () => {
	// WHY: a 0644 record is readable by every local user; refusing it is the only defense against a planted
	// claim. Both readers must refuse it, not return its contents.
	it("refuses a record other users can read, through both readers", async () => {
		const file = await tempRecord(0o644);
		await expect(readOwnerOnlyFile(file)).rejects.toThrow("readable or writable by other users");
		expect(() => readOwnerOnlyFileSync(file)).toThrow("readable or writable by other users");
	});

	// WHY: group or other write lets another user replace the content after a check. A write bit is refused
	// even when the read bit is owner-only.
	it("refuses a record other users can write", async () => {
		const file = await tempRecord(0o620);
		await expect(readOwnerOnlyFile(file)).rejects.toThrow("readable or writable by other users");
		expect(() => readOwnerOnlyFileSync(file)).toThrow("readable or writable by other users");
	});

	// WHY: the owner-only control. Without it the two refusals above could be a reader that rejects every
	// file. A 0600 record must read back exactly.
	it("reads an owner-only record through both readers", async () => {
		const file = await tempRecord(0o600, '{"version":1,"pid":42}');
		await expect(readOwnerOnlyFile(file)).resolves.toBe('{"version":1,"pid":42}');
		expect(readOwnerOnlyFileSync(file)).toBe('{"version":1,"pid":42}');
	});

	// WHY: a symlink to a private file would pass the mode check on its target. O_NOFOLLOW must refuse the
	// link itself, so a planted link cannot redirect the reader to another user's record.
	it("refuses a symlink even when its target is owner-only", async () => {
		const target = await tempRecord(0o600);
		const link = path.join(path.dirname(target), "link.json");
		await fsp.symlink(target, link);
		await expect(readOwnerOnlyFile(link)).rejects.toThrow("is a symbolic link");
		expect(() => readOwnerOnlyFileSync(link)).toThrow("is a symbolic link");
	});
	// WHY: a private file inside a replaceable parent can be redirected after its file-level check. Both
	// readers must reject the parent symlink before opening the record.
	it("refuses a symlinked parent directory through both readers", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(root);
		const target = path.join(root, "target");
		await fsp.mkdir(target);
		const file = path.join(target, "record.json");
		await fsp.writeFile(file, '{"version":1}');
		await fsp.chmod(file, 0o600);
		const link = path.join(root, "linked");
		await fsp.symlink(target, link, "dir");
		const linkedFile = path.join(link, "record.json");
		await expect(readOwnerOnlyFile(linkedFile)).rejects.toThrow("parent directory is a symbolic link");
		expect(() => readOwnerOnlyFileSync(linkedFile)).toThrow("parent directory is a symbolic link");
	});

	// WHY: a private file in a broadly accessible parent can be replaced or redirected by another user.
	// Parent and file permissions must both pass the same owner-only rule.
	it("refuses a POSIX parent directory with group or other access", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(root);
		const dir = path.join(root, "shared");
		await fsp.mkdir(dir, { mode: 0o700 });
		await fsp.chmod(dir, 0o750);
		const file = path.join(dir, "record.json");
		await fsp.writeFile(file, '{"version":1}', { mode: 0o600 });
		await expect(readOwnerOnlyFile(file)).rejects.toThrow("parent directory is accessible by other users");
		expect(() => readOwnerOnlyFileSync(file)).toThrow("parent directory is accessible by other users");
	});

	// WHY: the containing directory is also part of the trust boundary and must be owned by this process user.
	it("refuses a parent directory owned by another user", async () => {
		const file = await tempRecord(0o600);
		const uid = process.getuid?.() ?? 1000;
		const getuid = spyOn(process, "getuid").mockReturnValue(uid + 1);
		try {
			await expect(readOwnerOnlyFile(file)).rejects.toThrow("parent directory is owned by another user");
			expect(() => readOwnerOnlyFileSync(file)).toThrow("parent directory is owned by another user");
		} finally {
			getuid.mockRestore();
		}
	});



	// WHY: a directory named like a record is not a claim. The reader must refuse it, not throw a raw EISDIR
	// that a caller could mistake for an ordinary unreadable file.
	it("refuses a path that is not a regular file", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(dir);
		const asDir = path.join(dir, "record.json");
		await fsp.mkdir(asDir);
		await expect(readOwnerOnlyFile(asDir)).rejects.toThrow("not a regular file");
		expect(() => readOwnerOnlyFileSync(asDir)).toThrow("not a regular file");
	});

	// WHY: a FIFO with no writer makes a blocking open wait forever. The reader must refuse it on its
	// descriptor, so the open returns and the refusal is "not a regular file". The reader runs in a child
	// with a hard deadline: a blocking open shows up as a timeout (result.error), not a stuck test run.
	it.each(["sync", "async"] as const)("refuses a FIFO without blocking the %s reader", mode => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(dir);
		const fifo = path.join(dir, "record.json");
		const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5_000, windowsHide: true });
		expect(made.status).toBe(0);
		const result = readInChild(fifo, mode);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(3);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("not a regular file");
	}, 30_000);

	// WHY: a record larger than any a build writes is not one it published. The reader must refuse it before
	// reading the whole file into memory.
	it("refuses a record larger than a discovery record", async () => {
		const file = await tempRecord(0o600, "x".repeat(70 * 1024));
		await expect(readOwnerOnlyFile(file)).rejects.toThrow("larger than a discovery record");
		expect(() => readOwnerOnlyFileSync(file)).toThrow("larger than a discovery record");
	});

	// WHY: the owner check is the defense. A process with no user id cannot prove a record is its own, so the
	// reader must refuse an owner-only record rather than skip the uid comparison.
	it("refuses an owner-only record when the process user id is unavailable", async () => {
		const file = await tempRecord(0o600);
		const getuid = spyOn(process, "getuid").mockReturnValue(undefined as unknown as number);
		try {
			await expect(readOwnerOnlyFile(file)).rejects.toThrow("process.getuid is unavailable");
			expect(() => readOwnerOnlyFileSync(file)).toThrow("process.getuid is unavailable");
		} finally {
			getuid.mockRestore();
		}
	});

	// WHY: a missing record must still surface as ENOENT, because the production readers treat ENOENT as
	// "no owner" and any other error as a refusal to open.
	it("keeps the missing-file error code for a record that does not exist", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(dir);
		const file = path.join(dir, `absent-${crypto.randomUUID()}.json`);
		await expect(readOwnerOnlyFile(file)).rejects.toMatchObject({ code: "ENOENT" });
		let syncCode: unknown;
		try {
			readOwnerOnlyFileSync(file);
		} catch (error) {
			syncCode = (error as NodeJS.ErrnoException).code;
		}
		expect(syncCode).toBe("ENOENT");
	});
});

describe.skipIf(posix)("owner-only discovery reads on Windows", () => {
	// WHY: on Windows the mode bits say nothing; the inherited DACL is what other users read through. A record
	// with a broad allow ACE must be refused by the async and sync readers before any byte is parsed.
	it("refuses a record whose ACL grants read to another principal", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(dir);
		const file = path.join(dir, "record.json");
		await fsp.writeFile(file, '{"version":1}');
		await applyOwnerOnlyWindowsAcl(dir);
		await applyOwnerOnlyWindowsAcl(file);
		const granted = spawnSync("icacls", [file, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
		expect(granted.status).toBe(0);
		await expect(readOwnerOnlyFile(file)).rejects.toThrow("owner-only Windows ACL operation failed");
		expect(() => readOwnerOnlyFileSync(file)).toThrow("owner-only Windows ACL operation failed");
	});
	// WHY: a private record in a broadly accessible directory can be replaced or redirected by another user.
	// The directory itself must pass owner-plus-SYSTEM verification before the record can be opened.
	it("refuses a discovery directory with an Everyone read ACE", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(dir);
		const file = path.join(dir, "record.json");
		await fsp.writeFile(file, '{"version":1}');
		await applyOwnerOnlyWindowsAcl(dir);
		await applyOwnerOnlyWindowsAcl(file);
		const granted = spawnSync("icacls", [dir, "/grant", "*S-1-1-0:(RX)"], { windowsHide: true });
		expect(granted.status).toBe(0);
		await expect(readOwnerOnlyFile(file)).rejects.toThrow("owner-only Windows ACL operation failed");
		expect(() => readOwnerOnlyFileSync(file)).toThrow("owner-only Windows ACL operation failed");
	});


	// WHY: the Windows control. A record written through the owner-only writer must read back, so the refusal
	// above is the ACL and not a reader that refuses everything.
	it("reads a record written through the owner-only Windows ACL", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(dir);
		const file = path.join(dir, "record.json");
		await fsp.writeFile(file, '{"version":1}');
		await applyOwnerOnlyWindowsAcl(dir);
		await applyOwnerOnlyWindowsAcl(file);
		await expect(readOwnerOnlyFile(file)).resolves.toBe('{"version":1}');
		expect(readOwnerOnlyFileSync(file)).toBe('{"version":1}');
	});
});
describe("Windows owner-only discovery path policy", () => {
	// WHY: DOS device paths can address devices rather than discovery records. Reject them before opening.
	it.each([
		"\\\\.\\NUL",
		"\\\\?\\C:\\temp\\record.json",
		"C:\\temp\\CON.txt",
		"C:\\temp\\CON .txt",
		"C:\\CON\\record.json",
		"C:\\temp\\record.json:secret",
	] as const)(
		"refuses Windows DOS device path %s before opening it",
		async file => {
			await expect(readOwnerOnlyFile(file, { platform: "win32" })).rejects.toThrow("Windows device path");
			expect(() => readOwnerOnlyFileSync(file, { platform: "win32" })).toThrow("Windows device path");

			const allowed = await tempRecord(0o600, '{"version":1}');
			const options = {
				platform: "win32" as const,
				windowsAcl: {
					run: async () => ({ exitCode: 0, stdout: "OK", stderr: "" }),
					runSync: () => ({ exitCode: 0, stdout: "OK", stderr: "" }),
				},
			};
			await expect(readOwnerOnlyFile(allowed, options)).resolves.toBe('{"version":1}');
			expect(readOwnerOnlyFileSync(allowed, options)).toBe('{"version":1}');
		},
	);

	// WHY: a record ACL cannot protect a record in an unsafe parent. Readers must refuse it before parsing.
	it("refuses an unsafe containing directory and reads when both ACLs pass", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "owner-only-read-"));
		tempDirs.push(dir);
		const file = path.join(dir, "record.json");
		await fsp.writeFile(file, '{"version":1}');
		const denied = {
			platform: "win32" as const,
			windowsAcl: {
				run: async (_script: string, checkedPath: string) => {
					if (checkedPath === dir) throw new Error("parent ACL refused");
					return { exitCode: 0, stdout: "OK", stderr: "" };
				},
				runSync: (_script: string, checkedPath: string) => {
					if (checkedPath === dir) throw new Error("parent ACL refused");
					return { exitCode: 0, stdout: "OK", stderr: "" };
				},
			},
		};
		const checked: string[] = [];
		const steps: string[] = [];
		const options = {
			platform: "win32" as const,
			onStep: (step: string) => steps.push(step),
			windowsAcl: {
				run: async (_script: string, checkedPath: string) => {
					checked.push(checkedPath);
					return { exitCode: 0, stdout: "OK", stderr: "" };
				},
				runSync: (_script: string, checkedPath: string) => {
					checked.push(checkedPath);
					return { exitCode: 0, stdout: "OK", stderr: "" };
				},
			},
		};
		await expect(readOwnerOnlyFile(file, denied)).rejects.toThrow("parent ACL refused");
		expect(() => readOwnerOnlyFileSync(file, denied)).toThrow("parent ACL refused");

		await expect(readOwnerOnlyFile(file, options)).resolves.toBe('{"version":1}');
		expect(checked).toEqual([dir, file]);
		expect(steps).toEqual(["path", "ACL #1 (parent)", "lstat", "open", "stat", "ACL #2 (record)", "identity", "read"]);
		checked.length = 0;
		expect(readOwnerOnlyFileSync(file, options)).toBe('{"version":1}');
		expect(checked).toEqual([dir, file]);
	});

});
