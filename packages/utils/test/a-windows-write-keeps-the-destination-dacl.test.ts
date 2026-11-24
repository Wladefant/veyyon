import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicWriteFilePreservingMode, removeWithRetries } from "@veyyon/utils";
import {
	closeWindowsWriteStage,
	publishWindowsWriteStage,
	reserveWindowsWriteStage,
	type WindowsWriteStage,
	writeWindowsWriteStage,
} from "@veyyon/utils/windows-file-replace";

describe.skipIf(process.platform !== "win32")("Windows security-preserving file writer", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "w-dacl-"));
	});

	afterEach(async () => {
		await removeWithRetries(dir);
	});

	function icacls(file: string, ...args: string[]): string {
		const result = spawnSync(
			path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
			[path.basename(file), ...args],
			{
				cwd: path.dirname(file),
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) throw new Error(`icacls ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
		return result.stdout;
	}

	/** The SDDL DACL of `file`, read with READ_CONTROL only, which no share mode blocks. */
	function dacl(file: string): string | undefined {
		const saved = path.join(dir, `acl-${path.basename(file)}.txt`);
		icacls(file, "/save", saved);
		const text = fs.readFileSync(saved, "utf16le");
		fs.unlinkSync(saved);
		return text.split(/\r?\n/)[1]?.split("S:", 1)[0];
	}

	function leftovers(): string[] {
		return fs.readdirSync(dir).filter(name => name.startsWith(".veyyon-"));
	}

	function restrictedFile(name: string): { file: string; original: string | undefined } {
		const file = path.join(dir, name);
		fs.writeFileSync(file, "initial\n");
		// An explicit deny on an UNPROTECTED DACL: the parent grants what this file refuses.
		icacls(file, "/deny", "*S-1-5-32-546:(R)");
		const original = dacl(file);
		expect(original).not.toMatch(/^D:[A-Z]*P[A-Z]*\(/);
		expect(original).toContain("(D;");
		return { file, original };
	}
	const aclTestTimeout = 35_000;

	it(
		"creates the stage of an unprotected destination with its explicit deny before any byte exists",
		() => {
			const { file, original } = restrictedFile("restricted.txt");
			const inherited = path.join(dir, "inherited.txt");
			fs.writeFileSync(inherited, "");
			expect(dacl(inherited)).not.toBe(original);
			const stage = reserveWindowsWriteStage(file);
			try {
				const stagePath = path.join(dir, stage.stageName);
				expect(fs.statSync(stagePath).size).toBe(0);
				expect(dacl(stagePath)).toBe(original);
				// No other handle with data access can exist on the stage, whatever its DACL grants.
				expect(() => fs.openSync(stagePath, "r")).toThrow();
			} finally {
				closeWindowsWriteStage(stage);
			}
			expect(leftovers()).toEqual([]);
			expect(fs.readFileSync(file, "utf8")).toBe("initial\n");
		},
		aclTestTimeout,
	);

	it(
		"publishes a restricted file after GC during native stage creation",
		() => {
			const { file, original } = restrictedFile("gc-\u03bb.txt");
			const writePointer = Buffer.prototype.writeBigUInt64LE;
			let forcedCollection = false;
			// Scope the stress point to the descriptor field, the last field set in OBJECT_ATTRIBUTES.
			// This runs after both nested pointers are packed and before the real NtCreateFile.
			const stress = spyOn(Buffer.prototype, "writeBigUInt64LE").mockImplementation(function (
				this: Buffer,
				value: bigint,
				offset?: number,
			) {
				const result = writePointer.call(this, value, offset);
				if (offset === 32 && value !== 0n) {
					for (let i = 0; i < 128; i++) Buffer.alloc(4096, i);
					Bun.gc(true);
					forcedCollection = true;
				}
				return result;
			});
			let stage: WindowsWriteStage;
			try {
				stage = reserveWindowsWriteStage(file);
			} finally {
				stress.mockRestore();
			}
			try {
				expect(forcedCollection).toBe(true);
				writeWindowsWriteStage(stage, Buffer.from("after GC\n"), true);
				publishWindowsWriteStage(stage);
			} finally {
				closeWindowsWriteStage(stage);
			}
			expect(fs.readFileSync(file, "utf8")).toBe("after GC\n");
			expect(dacl(file)).toBe(original);
			expect(leftovers()).toEqual([]);
		},
		aclTestTimeout,
	);

	it(
		"holds the staging file and directory handles until publication",
		() => {
			const { file, original } = restrictedFile("bound.txt");
			const stage = reserveWindowsWriteStage(file);
			try {
				const stagePath = path.join(dir, stage.stageName);
				expect(() => fs.renameSync(stagePath, path.join(dir, "moved.tmp"))).toThrow();
				expect(() => fs.unlinkSync(stagePath)).toThrow();
				expect(() => fs.renameSync(dir, `${dir}-moved`)).toThrow();
				writeWindowsWriteStage(stage, Buffer.from("updated\n"), true);
				publishWindowsWriteStage(stage);
			} finally {
				closeWindowsWriteStage(stage);
			}
			expect(fs.readFileSync(file, "utf8")).toBe("updated\n");
			expect(dacl(file)).toBe(original);
			expect(leftovers()).toEqual([]);
		},
		aclTestTimeout,
	);

	it("refuses a staged replacement if its destination is absent at the final check", () => {
		const file = path.join(dir, "removed.txt");
		fs.writeFileSync(file, "initial\n");
		const stage = reserveWindowsWriteStage(file);
		try {
			writeWindowsWriteStage(stage, Buffer.from("updated\n"), false);
			fs.renameSync(file, path.join(dir, "original.txt"));
			expect(() => publishWindowsWriteStage(stage)).toThrow(/Reopening the replacement target/);
		} finally {
			closeWindowsWriteStage(stage);
		}
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.readFileSync(path.join(dir, "original.txt"), "utf8")).toBe("initial\n");
		expect(leftovers()).toEqual([]);
	});

	it("refuses a staged replacement if the destination FileId changed at the final check", () => {
		const file = path.join(dir, "changed-id.txt");
		fs.writeFileSync(file, "initial\n");
		const stage = reserveWindowsWriteStage(file);
		try {
			writeWindowsWriteStage(stage, Buffer.from("updated\n"), false);
			fs.renameSync(file, path.join(dir, "original.txt"));
			fs.writeFileSync(file, "other\n");
			expect(() => publishWindowsWriteStage(stage)).toThrow(/destination changed/);
		} finally {
			closeWindowsWriteStage(stage);
		}
		expect(fs.readFileSync(file, "utf8")).toBe("other\n");
		expect(leftovers()).toEqual([]);
	});

	it("keeps a creation a creation: a file that appears before publication is never replaced", () => {
		const file = path.join(dir, "created.txt");
		const stage = reserveWindowsWriteStage(file);
		try {
			writeWindowsWriteStage(stage, Buffer.from("ours\n"), false);
			fs.writeFileSync(file, "racer\n");
			expect(() => publishWindowsWriteStage(stage)).toThrow(/no replacement/);
		} finally {
			closeWindowsWriteStage(stage);
		}
		expect(fs.readFileSync(file, "utf8")).toBe("racer\n");
		expect(leftovers()).toEqual([]);
	});

	it(
		"refuses to publish when the destination's DACL changes while the write is staged",
		() => {
			const { file, original } = restrictedFile("changed.txt");
			const stage = reserveWindowsWriteStage(file);
			let changed: string | undefined;
			try {
				writeWindowsWriteStage(stage, Buffer.from("stale\n"), false);
				icacls(file, "/deny", "*S-1-5-32-546:(W)");
				changed = dacl(file);
				expect(changed).not.toBe(original);
				expect(() => publishWindowsWriteStage(stage)).toThrow(/security changed/);
			} finally {
				closeWindowsWriteStage(stage);
			}
			expect(fs.readFileSync(file, "utf8")).toBe("initial\n");
			expect(dacl(file)).toBe(changed);
			expect(leftovers()).toEqual([]);
		},
		aclTestTimeout,
	);

	it("refuses a destination whose alternate data stream a replacement would drop", async () => {
		const file = path.join(dir, "streams.txt");
		fs.writeFileSync(file, "initial\n");
		fs.writeFileSync(`${file}:Zone.Identifier`, "[ZoneTransfer]\r\nZoneId=3\r\n");
		await expect(atomicWriteFilePreservingMode(file, "updated\n", { preserveWindowsDacl: true })).rejects.toThrow(
			/alternate data streams/,
		);
		expect(fs.readFileSync(file, "utf8")).toBe("initial\n");
		expect(fs.readFileSync(`${file}:Zone.Identifier`, "utf8")).toContain("ZoneId=3");
		expect(leftovers()).toEqual([]);
	});

	it("refuses a stream added to the destination after reservation", () => {
		const file = path.join(dir, "new-stream.txt");
		const stream = `${file}:Zone.Identifier`;
		fs.writeFileSync(file, "initial\n");
		const stage = reserveWindowsWriteStage(file);
		try {
			writeWindowsWriteStage(stage, Buffer.from("updated\n"), false);
			fs.writeFileSync(stream, "[ZoneTransfer]\r\nZoneId=3\r\n");
			expect(() => publishWindowsWriteStage(stage)).toThrow(/alternate data streams/);
		} finally {
			closeWindowsWriteStage(stage);
		}
		expect(fs.readFileSync(file, "utf8")).toBe("initial\n");
		expect(fs.readFileSync(stream, "utf8")).toBe("[ZoneTransfer]\r\nZoneId=3\r\n");
		expect(leftovers()).toEqual([]);
	});

	it("refuses to restore a read-only attribute that was removed while staging", () => {
		const file = path.join(dir, "changed-attributes.txt");
		fs.writeFileSync(file, "initial\n");
		fs.chmodSync(file, 0o444);
		expect(fs.statSync(file).mode & 0o200).toBe(0);
		const stage = reserveWindowsWriteStage(file);
		try {
			writeWindowsWriteStage(stage, Buffer.from("updated\n"), false);
			fs.chmodSync(file, 0o666);
			expect(() => publishWindowsWriteStage(stage)).toThrow(/attributes changed while the write was staged/);
		} finally {
			closeWindowsWriteStage(stage);
		}
		expect(fs.readFileSync(file, "utf8")).toBe("initial\n");
		expect(fs.statSync(file).mode & 0o200).toBe(0o200);
		expect(leftovers()).toEqual([]);
	});

	it(
		"publishes new bytes while a reader keeps the old file open",
		async () => {
			const { file, original } = restrictedFile("read-open.txt");
			const reader = fs.openSync(file, "r");
			try {
				await atomicWriteFilePreservingMode(file, "replacement\n", { preserveWindowsDacl: true });
				expect(fs.readFileSync(reader, "utf8")).toBe("initial\n");
				expect(fs.readFileSync(file, "utf8")).toBe("replacement\n");
				expect(dacl(file)).toBe(original);
			} finally {
				fs.closeSync(reader);
			}
			expect(leftovers()).toEqual([]);
		},
		aclTestTimeout,
	);

	it(
		"leaves the old bytes and DACL at the destination when the writer exits before publication",
		() => {
			const { file, original } = restrictedFile("interrupted.txt");
			const probe = path.join(dir, "exit-before-publish.ts");
			const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "../src/windows-file-replace.ts")).href;
			fs.writeFileSync(
				probe,
				`import { statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { reserveWindowsWriteStage, writeWindowsWriteStage } from ${JSON.stringify(moduleUrl)};
const stage = reserveWindowsWriteStage(process.argv[2]);
const bytes = Buffer.from("replacement\\n");
writeWindowsWriteStage(stage, bytes, true);
if (statSync(join(dirname(stage.target), stage.stageName)).size !== bytes.length) process.exit(22);
writeSync(1, "staged\\n");
process.exit(23);
`,
			);
			const child = spawnSync(process.execPath, [probe, file], {
				cwd: dir,
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
			});
			if (child.error) throw child.error;
			expect(child.stderr).toBe("");
			expect(child.status).toBe(23);
			expect(child.stdout).toBe("staged\n");
			expect(fs.readFileSync(file, "utf8")).toBe("initial\n");
			expect(dacl(file)).toBe(original);
		},
		aclTestTimeout,
	);

	it("does not replace a directory or touch its contents", async () => {
		const target = path.join(dir, "destination");
		fs.mkdirSync(target);
		fs.writeFileSync(path.join(target, "entry.txt"), "keep\n");
		await expect(
			atomicWriteFilePreservingMode(target, "replacement\n", { preserveWindowsDacl: true }),
		).rejects.toThrow(/it is a directory, and an atomic write would replace it with a regular file/);
		expect(() => reserveWindowsWriteStage(target)).toThrow(/NtCreateFile.*Win32 error/);
		expect(fs.readdirSync(target)).toEqual(["entry.txt"]);
		expect(fs.readFileSync(path.join(target, "entry.txt"), "utf8")).toBe("keep\n");
		expect(leftovers()).toEqual([]);
	});

	const otherVolume = process.env.VEYYON_TEST_SECONDARY_TEMP;
	it.skipIf(!otherVolume)(
		"refuses to publish a stage on another volume without copying or removing either original",
		async () => {
			if (!otherVolume) throw new Error("The cross-volume check needs a second scratch volume.");
			const foreignDir = fs.mkdtempSync(path.join(otherVolume, "w-dacl-"));
			const target = path.join(dir, "destination.txt");
			const foreign = path.join(foreignDir, path.basename(target));
			try {
				fs.writeFileSync(target, "destination\n");
				fs.writeFileSync(foreign, "foreign\n");
				// Match the file DACLs explicitly so the rename reaches the volume check,
				// regardless of inheritance or ACE order on the two scratch volumes.
				const aclFile = path.join(dir, "cross-volume-acl.txt");
				icacls(target, "/inheritance:d");
				icacls(target, "/save", aclFile);
				icacls(foreignDir, "/restore", aclFile);
				fs.unlinkSync(aclFile);
				const destination = reserveWindowsWriteStage(target);
				try {
					const source = reserveWindowsWriteStage(foreign);
					try {
						writeWindowsWriteStage(source, Buffer.from("replacement\n"), false);
						// Both stages are real. Place the foreign handle at the publication boundary.
						expect(() => publishWindowsWriteStage({ ...destination, stage: source.stage })).toThrow(
							/Publishing the replacement.*Win32 error 17/,
						);
					} finally {
						closeWindowsWriteStage(source);
					}
				} finally {
					closeWindowsWriteStage(destination);
				}
				expect(fs.readFileSync(target, "utf8")).toBe("destination\n");
				expect(fs.readFileSync(foreign, "utf8")).toBe("foreign\n");
				expect(fs.readdirSync(foreignDir)).toEqual([path.basename(foreign)]);
				expect(leftovers()).toEqual([]);
			} finally {
				await removeWithRetries(foreignDir);
			}
		},
	);

	it(
		"creates a missing file with the directory's normal inherited DACL",
		async () => {
			const reference = path.join(dir, "reference.txt");
			fs.writeFileSync(reference, "");
			const file = path.join(dir, "fresh.txt");
			await atomicWriteFilePreservingMode(file, "fresh\n", { preserveWindowsDacl: true });
			expect(fs.readFileSync(file, "utf8")).toBe("fresh\n");
			expect(dacl(file)).toBe(dacl(reference));
			expect(leftovers()).toEqual([]);
		},
		aclTestTimeout,
	);
});
