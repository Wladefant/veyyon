import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";
import { ArtifactManager } from "../src/session/artifacts";

describe("artifact allocator multi-manager, multi-process, and legacy coexistence", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `veyyon-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	it("allocates distinct IDs across two preinitialized managers mixing sync and async operations", async () => {
		const dir = freshDir();
		const mgrA = new ArtifactManager(dir);
		const mgrB = new ArtifactManager(dir);

		// Pre-initialize both managers
		await mgrA.allocatePath("bash");
		await mgrB.allocatePath("bash");

		const allocatedA: string[] = [];
		const allocatedB: string[] = [];

		// Run mixed sync and async allocations across both managers
		const promises = [
			(async () => {
				for (let i = 0; i < 10; i++) {
					if (i % 2 === 0) {
						const res = await mgrA.allocatePath("task");
						allocatedA.push(res.id);
					} else {
						const res = mgrA.allocatePathSync("task");
						allocatedA.push(res.id);
					}
				}
			})(),
			(async () => {
				for (let i = 0; i < 10; i++) {
					if (i % 2 === 0) {
						const res = await mgrB.allocatePath("read");
						allocatedB.push(res.id);
					} else {
						const res = mgrB.allocatePathSync("read");
						allocatedB.push(res.id);
					}
				}
			})(),
		];

		await Promise.all(promises);

		const all = [...allocatedA, ...allocatedB];
		const unique = new Set(all);
		expect(unique.size).toBe(all.length);
	});

	it("preserves crash/failed reservation and advances counter without reusing IDs", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);

		// Allocate path (reserves ID 0) but fail to write/publish
		const first = await mgr.allocatePath("bash");
		expect(first.id).toBe("0");

		// A subsequent allocation must skip ID 0 and allocate ID 1
		const second = await mgr.allocatePath("bash");
		expect(second.id).toBe("1");

		// Even a fresh manager instance must not reuse ID 0 or 1
		const freshMgr = new ArtifactManager(dir);
		const third = await freshMgr.allocatePath("bash");
		expect(third.id).toBe("2");
	});

	it("does not reuse IDs after legacy markers are cleaned up", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);

		const id0 = await mgr.allocatePath("bash");
		const id1 = await mgr.allocatePath("bash");
		expect(id0.id).toBe("0");
		expect(id1.id).toBe("1");

		await fs.rm(path.join(dir, ".artifact-id-0"), { recursive: true, force: true });
		await fs.rm(path.join(dir, ".artifact-id-1"), { recursive: true, force: true });

		const freshMgr = new ArtifactManager(dir);
		const id2 = await freshMgr.allocatePath("bash");
		expect(Number(id2.id)).toBeGreaterThanOrEqual(2);
	});

	it("reconciles the counter before cleanup deletes legacy-published markers", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		const rollbackManager = new ArtifactManager(dir);

		expect(await rollbackManager.save("content-0", "bash")).toBe("0");
		expect(await rollbackManager.save("content-1", "bash")).toBe("1");
		expect(await rollbackManager.save("content-2", "bash")).toBe("2");
		for (let id = 3; id <= 5; id++) {
			fsSync.mkdirSync(path.join(dir, `.artifact-id-${id}`));
			fsSync.writeFileSync(path.join(dir, `${id}.legacy.log`), `legacy-${id}`);
		}
		fsSync.mkdirSync(path.join(dir, ".artifact-id-6"));
		fsSync.mkdirSync(path.join(dir, ".artifact-id-7"));

		const script = path.resolve(import.meta.dirname, "../../scripts/cleanup-artifact-markers.py");
		const pyBin = Bun.which("python3") ?? Bun.which("python") ?? "python3";
		const result = await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
			const proc = spawn(pyBin, [script, "--session-dir", dir, "--execute", "--min-age-hours", "0", "--json"], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			let stdout = "";
			proc.stdout.on("data", chunk => {
				stdout += chunk;
			});
			proc.on("error", reject);
			proc.on("close", code => resolve({ code, stdout }));
		});
		expect(result.code).toBe(0);
		const parsed: unknown = JSON.parse(result.stdout);
		const deleted = parsed && typeof parsed === "object" && "deleted" in parsed ? parsed.deleted : undefined;
		expect(deleted).toBe(6);

		const freshManager = new ArtifactManager(dir);
		const next = await freshManager.allocatePath("bash");
		expect(Number(next.id)).toBeGreaterThanOrEqual(8);
		for (const id of [0, 1, 2]) {
			expect(await fs.readFile(path.join(dir, `${id}.bash.log`), "utf8")).toBe(`content-${id}`);
		}
		for (let id = 3; id <= 5; id++) {
			expect(await fs.readFile(path.join(dir, `${id}.legacy.log`), "utf8")).toBe(`legacy-${id}`);
		}
	});

	// Existing counters must work without enumerating a large legacy directory.
	// Collisions still need a scan to catch legacy reservations beyond the counter.
	it("uses the persisted counter when directory enumeration is unavailable", () => {
		const dir = freshDir();
		expect(new ArtifactManager(dir).allocateId()).toBe(0);
		const scan = spyOn(fsSync, "readdirSync").mockImplementation(() => {
			throw Object.assign(new Error("Directory enumeration denied"), { code: "EACCES" });
		});
		try {
			expect(new ArtifactManager(dir).allocateId()).toBe(1);
		} finally {
			scan.mockRestore();
		}
	});

	it("persists WAL mode for the artifact counter", () => {
		const dir = freshDir();
		new ArtifactManager(dir).allocateId();
		const db = new Database(path.join(dir, ".artifact-ids.sqlite"));
		try {
			expect(db.query("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
		} finally {
			db.close();
		}
	});

	it("retries transient SQLITE_BUSY during WAL setup and completes allocation", () => {
		const dir = freshDir();
		let busyAttempts = 0;
		const origRun = Database.prototype.run;
		const spy = spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql: string, ...args: unknown[]) {
			if (typeof sql === "string" && sql.includes("PRAGMA journal_mode = WAL") && busyAttempts < 2) {
				busyAttempts++;
				const busyErr = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
				throw busyErr;
			}
			return origRun.call(this, sql, ...(args as []));
		});
		try {
			const mgr = new ArtifactManager(dir);
			expect(mgr.allocateId()).toBe(0);
			expect(busyAttempts).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});

	it("terminates after 4 attempts on persistent SQLITE_BUSY during WAL setup and surfaces error", () => {
		const dir = freshDir();
		let busyAttempts = 0;
		const origRun = Database.prototype.run;
		const spy = spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql: string, ...args: unknown[]) {
			if (typeof sql === "string" && sql.includes("PRAGMA journal_mode = WAL")) {
				busyAttempts++;
				const busyErr = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
				throw busyErr;
			}
			return origRun.call(this, sql, ...(args as []));
		});
		try {
			const mgr = new ArtifactManager(dir);
			expect(() => mgr.allocateId()).toThrow("database is locked");
			expect(busyAttempts).toBe(4);
		} finally {
			spy.mockRestore();
		}
	});

	it("surfaces non-SQLITE_BUSY error during WAL setup without retrying", () => {
		const dir = freshDir();
		let attempts = 0;
		const origRun = Database.prototype.run;
		const spy = spyOn(Database.prototype, "run").mockImplementation(function (this: Database, sql: string, ...args: unknown[]) {
			if (typeof sql === "string" && sql.includes("PRAGMA journal_mode = WAL")) {
				attempts++;
				const err = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
				throw err;
			}
			return origRun.call(this, sql, ...(args as []));
		});
		try {
			const mgr = new ArtifactManager(dir);
			expect(() => mgr.allocateId()).toThrow("disk I/O error");
			expect(attempts).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("rescans legacy reservations after a persisted counter collides", async () => {
		const dir = freshDir();
		expect(new ArtifactManager(dir).allocateId()).toBe(0);
		await fs.mkdir(path.join(dir, ".artifact-id-1"));
		await fs.mkdir(path.join(dir, ".artifact-id-20"));
		expect(new ArtifactManager(dir).allocateId()).toBe(21);
	});

	it("excludes hidden database and sidecars from listFiles", async () => {
		const dir = freshDir();
		const mgr = new ArtifactManager(dir);
		await mgr.save("hello", "bash");

		const files = await mgr.listFiles();
		// Database files (.artifact-ids.sqlite, -wal, -shm, -journal, etc.) must never show up in listFiles
		for (const file of files) {
			expect(file.startsWith(".artifact-ids.sqlite")).toBe(false);
			expect(file.startsWith(".artifact-id-")).toBe(false);
		}
	});

	it("fails closed on allocation directory scan failure other than ENOENT", async () => {
		// When readdir fails due to permission or other non-ENOENT error, allocateId must throw
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		// We can test non-ENOENT error by making dir a file instead of directory (ENOTDIR)
		const filePath = path.join(dir, "not-a-dir");
		await fs.writeFile(filePath, "test", "utf8");

		const mgr = new ArtifactManager(filePath);
		expect(() => mgr.allocateId()).toThrow();
	});

	it("does not produce duplicate IDs under two actual competing processes", async () => {
		const dir = freshDir();

		const scriptContent = `
import { ArtifactManager } from "${path.resolve(import.meta.dirname, "../src/session/artifacts").replace(/\\/g, "/")}";

const dir = process.argv[2];
const count = parseInt(process.argv[3], 10);
const mgr = new ArtifactManager(dir);

async function run() {
  const ids = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      const res = await mgr.allocatePath("proc");
      ids.push(res.id);
    } else {
      const res = mgr.allocatePathSync("proc");
      ids.push(res.id);
    }
  }
  process.stdout.write(JSON.stringify(ids));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
`;

		const scriptPath = path.join(dir, "worker.ts");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(scriptPath, scriptContent, "utf8");

		function runProc(): Promise<string[]> {
			const { promise, resolve, reject } = Promise.withResolvers<string[]>();
			const proc = spawn(process.execPath, ["run", scriptPath, dir, "20"], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			let out = "";
			proc.stdout.on("data", chunk => {
				out += chunk;
			});
			proc.on("close", code => {
				if (code === 0) {
					resolve(JSON.parse(out));
				} else {
					reject(new Error(`Worker exited with code ${code}`));
				}
			});
			return promise;
		}

		const [idsA, idsB] = await Promise.all([runProc(), runProc()]);
		const all = [...idsA, ...idsB];
		const unique = new Set(all);
		expect(all.length).toBe(40);
		expect(unique.size).toBe(40);
	});

	it("coexists without duplicates or clobbers between legacy allocator and current allocator processes", async () => {
		const dir = freshDir();

		// Legacy worker simulates the legacy mkdir allocator loop
		const legacyScript = `
import * as fsSync from "node:fs";
import * as path from "node:path";

const dir = process.argv[2];
const count = parseInt(process.argv[3], 10);

fsSync.mkdirSync(dir, { recursive: true });
let nextId = 0;

function allocateLegacyId() {
  for (;;) {
    const id = nextId++;
    try {
      fsSync.mkdirSync(path.join(dir, \`.artifact-id-\${id}\`));
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
    return id;
  }
}

const ids = [];
for (let i = 0; i < count; i++) {
  const id = allocateLegacyId();
  ids.push(String(id));
}
process.stdout.write(JSON.stringify(ids));
`;

		// New worker uses ArtifactManager
		const newScript = `
import { ArtifactManager } from "${path.resolve(import.meta.dirname, "../src/session/artifacts").replace(/\\/g, "/")}";

const dir = process.argv[2];
const count = parseInt(process.argv[3], 10);
const mgr = new ArtifactManager(dir);

async function run() {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const res = await mgr.allocatePath("new");
    ids.push(res.id);
  }
  process.stdout.write(JSON.stringify(ids));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
`;

		const legacyScriptPath = path.join(dir, "legacy_worker.ts");
		const newScriptPath = path.join(dir, "new_worker.ts");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(legacyScriptPath, legacyScript, "utf8");
		await fs.writeFile(newScriptPath, newScript, "utf8");

		function runWorker(script: string, count: number): Promise<string[]> {
			const { promise, resolve, reject } = Promise.withResolvers<string[]>();
			const proc = spawn(process.execPath, ["run", script, dir, String(count)], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			let out = "";
			proc.stdout.on("data", chunk => {
				out += chunk;
			});
			proc.on("close", code => {
				if (code === 0) {
					resolve(JSON.parse(out));
				} else {
					reject(new Error(`Worker ${script} exited with code ${code}`));
				}
			});
			return promise;
		}

		const [legacyIds, newIds] = await Promise.all([runWorker(legacyScriptPath, 15), runWorker(newScriptPath, 15)]);
		const all = [...legacyIds, ...newIds];
		const unique = new Set(all);
		expect(all.length).toBe(30);
		expect(unique.size).toBe(30);
	});

	it("coexists under sequential rollback where new allocator exits leaving unpublished tail markers and legacy process resumes", async () => {
		const dir = freshDir();

		// Worker 1: new allocator process reserves IDs, publishes some, and leaves unpublished tail reservations before exiting.
		const newWorkerScript = `
import * as fsSync from "node:fs";
import * as path from "node:path";
import { ArtifactManager } from "${path.resolve(import.meta.dirname, "../src/session/artifacts").replace(/\\/g, "/")}";

const dir = process.argv[2];
const mgr = new ArtifactManager(dir);

async function run() {
  // Save 3 published artifacts (IDs 0, 1, 2)
  const saved0 = await mgr.save("content-0", "bash");
  const saved1 = await mgr.save("content-1", "bash");
  const saved2 = await mgr.save("content-2", "bash");

  // Allocate 2 more IDs (IDs 3, 4) without publishing content (failed/unpublished tail)
  const alloc3 = await mgr.allocatePath("bash");
  const alloc4 = await mgr.allocatePath("bash");

  process.stdout.write(JSON.stringify({
    saved: [saved0, saved1, saved2],
    unpublished: [alloc3.id, alloc4.id],
  }));
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
`;

		// Worker 2: legacy allocator process starts fresh after new allocator exited.
		// Legacy allocator scans ONLY published N.*.log on init, then uses mkdir .artifact-id-N to reserve.
		const legacyResumeScript = `
import * as fsSync from "node:fs";
import * as path from "node:path";

const dir = process.argv[2];
const count = parseInt(process.argv[3], 10);

fsSync.mkdirSync(dir, { recursive: true });

// Legacy init: scans ONLY published N.*.log files
let maxId = -1;
const entries = fsSync.readdirSync(dir);
for (const entry of entries) {
  const match = entry.match(/^(\\d+)\\..*\\.log$/);
  if (match) {
    const id = parseInt(match[1], 10);
    if (id > maxId) maxId = id;
  }
}
let nextId = Math.max(0, maxId + 1);

function allocateLegacyId() {
  for (;;) {
    const id = nextId++;
    try {
      fsSync.mkdirSync(path.join(dir, \`.artifact-id-\${id}\`));
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
    return id;
  }
}

const ids = [];
for (let i = 0; i < count; i++) {
  const id = allocateLegacyId();
  // Legacy also writes its artifact log
  const filePath = path.join(dir, \`\${id}.legacy.log\`);
  if (fsSync.existsSync(filePath)) {
    throw new Error(\`Clobber detected: \${filePath} already exists!\`);
  }
  fsSync.writeFileSync(filePath, \`legacy-content-\${id}\`, "utf8");
  ids.push(String(id));
}
process.stdout.write(JSON.stringify(ids));
`;

		const newScriptPath = path.join(dir, "new_tail_worker.ts");
		const legacyScriptPath = path.join(dir, "legacy_resume_worker.ts");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(newScriptPath, newWorkerScript, "utf8");
		await fs.writeFile(legacyScriptPath, legacyResumeScript, "utf8");

		function runProcess(script: string, args: string[]): Promise<any> {
			const { promise, resolve, reject } = Promise.withResolvers<any>();
			const proc = spawn(process.execPath, ["run", script, ...args], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			let out = "";
			proc.stdout.on("data", chunk => {
				out += chunk;
			});
			proc.on("close", code => {
				if (code === 0) {
					resolve(JSON.parse(out));
				} else {
					reject(new Error(`Worker ${script} exited with code ${code}`));
				}
			});
			return promise;
		}

		// 1. Run new allocator process to completion
		const newResult = await runProcess(newScriptPath, [dir]);
		expect(newResult.saved).toEqual(["0", "1", "2"]);
		expect(newResult.unpublished).toEqual(["3", "4"]);

		// Verify the markers for unpublished IDs 3 and 4 exist in the directory
		const entriesAfterNew = await fs.readdir(dir);
		expect(entriesAfterNew).toContain(".artifact-id-3");
		expect(entriesAfterNew).toContain(".artifact-id-4");

		// 2. Run legacy allocator process (which resumes sequentially)
		// Legacy scans published files (0, 1, 2) -> max is 2 -> nextId starts at 3.
		// When it tries to allocate 3, mkdir .artifact-id-3 gets EEXIST!
		// When it tries to allocate 4, mkdir .artifact-id-4 gets EEXIST!
		// So legacy skips 3 and 4, and allocates 5, 6, 7!
		const legacyIds: string[] = await runProcess(legacyScriptPath, [dir, "3"]);
		expect(legacyIds).toEqual(["5", "6", "7"]);

		// Confirm no prior ID was returned or overwritten
		const allAllocated = [...newResult.saved, ...newResult.unpublished, ...legacyIds];
		const unique = new Set(allAllocated);
		expect(allAllocated.length).toBe(8);
		expect(unique.size).toBe(8);

		// Verify none of the published files from new allocator were overwritten
		const file0 = await fs.readFile(path.join(dir, "0.bash.log"), "utf8");
		const file1 = await fs.readFile(path.join(dir, "1.bash.log"), "utf8");
		const file2 = await fs.readFile(path.join(dir, "2.bash.log"), "utf8");
		expect(file0).toBe("content-0");
		expect(file1).toBe("content-1");
		expect(file2).toBe("content-2");

		// 3. Age all markers (>24h) and run cleanup-artifact-markers.py --execute
		const oldEpoch = Math.floor(Date.now() / 1000) - 48 * 3600;
		for (const name of await fs.readdir(dir)) {
			if (name.startsWith(".artifact-id-")) {
				await fs.utimes(path.join(dir, name), oldEpoch, oldEpoch);
			}
		}
		const cleanupScript = path.resolve(import.meta.dirname, "../../scripts/cleanup-artifact-markers.py");
		const pyBin = Bun.which("python3") ?? Bun.which("python") ?? "python3";
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(
				pyBin,
				[cleanupScript, "--session-dir", dir, "--execute", "--min-age-hours", "24"],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let stderr = "";
			proc.stderr.on("data", chunk => {
				stderr += chunk;
			});
			proc.on("close", code => {
				if (code === 0) resolve();
				else reject(new Error(`Cleanup script exited with ${code}: ${stderr}`));
			});
		});

		// Verify markers 5, 6, 7 (<= max_published_id 7) were cleaned up
		const entriesAfterCleanup = await fs.readdir(dir);
		expect(entriesAfterCleanup).not.toContain(".artifact-id-5");
		expect(entriesAfterCleanup).not.toContain(".artifact-id-6");
		expect(entriesAfterCleanup).not.toContain(".artifact-id-7");

		// 4. Third fresh SQLite allocator resumes after cleanup removed collision sentinels 5..7
		const resumeNewScript = `
import { ArtifactManager } from "${path.resolve(import.meta.dirname, "../src/session/artifacts").replace(/\\/g, "/")}";
const dir = process.argv[2];
const mgr = new ArtifactManager(dir);
async function run() {
  const saved8 = await mgr.save("content-8", "bash");
  const saved9 = await mgr.save("content-9", "bash");
  process.stdout.write(JSON.stringify([saved8, saved9]));
}
run().catch(err => { console.error(err); process.exit(1); });
`;
		const resumeNewScriptPath = path.join(dir, "resume_new_worker.ts");
		await fs.writeFile(resumeNewScriptPath, resumeNewScript, "utf8");
		const resumedNewIds: string[] = await runProcess(resumeNewScriptPath, [dir]);
		expect(Number(resumedNewIds[0])).toBeGreaterThanOrEqual(8);
		expect(resumedNewIds).toEqual(["8", "9"]);

		// Verify legacy published files 5, 6, 7 are completely intact
		expect(await fs.readFile(path.join(dir, "5.legacy.log"), "utf8")).toBe("legacy-content-5");
		expect(await fs.readFile(path.join(dir, "6.legacy.log"), "utf8")).toBe("legacy-content-6");
		expect(await fs.readFile(path.join(dir, "7.legacy.log"), "utf8")).toBe("legacy-content-7");
	});

	it("scans legacy directory outside SQLite write transaction during initial and EEXIST recovery", async () => {
		const dir = freshDir();
		await fs.mkdir(dir, { recursive: true });
		// Pre-create legacy artifacts 0..99 and a gap marker at 150
		for (let i = 0; i < 100; i++) {
			await fs.mkdir(path.join(dir, `.artifact-id-${i}`));
			await fs.writeFile(path.join(dir, `${i}.legacy.log`), `legacy-${i}`, "utf8");
		}
		await fs.mkdir(path.join(dir, ".artifact-id-150"));

		const mgrA = new ArtifactManager(dir);
		const mgrB = new ArtifactManager(dir);
		const idA = mgrA.allocateId();
		const idB = mgrB.allocateId();
		expect(idA).toBe(151);
		expect(idB).toBe(152);
	});
});
