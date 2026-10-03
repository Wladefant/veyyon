/**
 * WHY: clearing a retained mount used to remove its files before stopping it.
 * Exercise the real scanner and clear handler over every native backend and
 * both mount layouts. Overlayfs stop failures preserve data; Projfs is refused
 * because its process-local stop can return success without stopping anything.
 * The native boundary is substituted; actual OS unmounting is not proved here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as child_process from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@veyyon/natives";
import * as utils from "@veyyon/utils";
import { clearWorktrees } from "../../src/cli/worktree-cli";
import { retainIsolationWorkspace } from "../../src/task/isolation-runner";
import {
	ISOLATION_CLAIM_FILE,
	ISOLATION_OWNER_FILE,
	type IsolationOwnerRecord,
	readIsolationOwner,
	RETAINED_BACKEND_FILE,
	writeRetainedBackend,
} from "../../src/task/isolation-ownership";
import { ensureIsolation, getRepoRoot, getTaskIsolationSegment } from "../../src/task/worktree";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("retained-isolation-clear-");
const backends = Object.entries(natives.IsoBackendKind).flatMap(([name, backend]) =>
	typeof backend === "number" ? [{ name, backend }] : [],
);
const mountingNames: Record<string, true | undefined> = { Overlayfs: true, Projfs: true };
let root: string;
let stdout: string;
let previousExitCode: typeof process.exitCode;

beforeEach(async () => {
	root = makeTempDir();
	stdout = "";
	previousExitCode = process.exitCode;
	process.exitCode = 0;
	await fs.mkdir(path.join(root, "workspaces"));
	vi.spyOn(utils, "getWorktreesDir").mockReturnValue(path.join(root, "workspaces"));
	vi.spyOn(console, "log").mockImplementation(line => {
		stdout = String(line);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode ?? 0;
});

async function makeWorkspace(names: readonly string[] = ["m"]): Promise<string> {
	const workspace = path.join(root, "workspaces", "retained");
	for (const name of names) {
		await fs.mkdir(path.join(workspace, name), { recursive: true });
		await fs.writeFile(path.join(workspace, name, "changes.txt"), "unrecovered changes");
	}
	return workspace;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.stat(file);
		return true;
	} catch (error) {
		if (utils.isEnoent(error)) return false;
		throw error;
	}
}

describe("retained isolation cleanup", () => {
	it("requires a decision when the native backend registry grows", () => {
		expect(
			backends
				.filter(({ name }) => !(mountingNames[name] === true))
				.map(({ name }) => name)
				.sort(),
		).toEqual(["Apfs", "Btrfs", "LinuxReflink", "Rcopy", "WindowsBlockClone", "Zfs"]);
	});

	for (const { name, backend } of backends) {
		for (const mountName of ["m", "merged"]) {
			it(`clears ${name} in the ${mountName} layout without deleting a live mount first`, async () => {
				const workspace = await makeWorkspace([mountName]);
				await writeRetainedBackend(workspace, backend);
				const proof = path.join(root, "stop-proof.txt");
				vi.spyOn(natives, "isoStop").mockImplementation(async (receivedBackend, candidate) => {
					if (name === "Projfs") return;
					if (!(mountingNames[name] === true)) throw new Error("A copy/snapshot backend must not be stopped");
					expect(receivedBackend).toBe(backend);
					expect(candidate).toBe(path.join(workspace, mountName));
					const content = await fs.readFile(path.join(candidate, "changes.txt"), "utf8");
					await fs.writeFile(proof, content);
				});

				await clearWorktrees({ all: false, dryRun: false, json: true });

				if (name === "Projfs") {
					const result = JSON.parse(stdout);
					expect(result).toMatchObject({ removed: 0, failed: 1, results: [{ ok: false }] });
					expect(result.results[0].error).toContain("Projfs");
					expect(await fs.readFile(path.join(workspace, mountName, "changes.txt"), "utf8")).toBe(
						"unrecovered changes",
					);
					expect(await exists(proof)).toBe(false);
					expect(process.exitCode).toBe(1);
					return;
				}
				expect(JSON.parse(stdout)).toMatchObject({ removed: 1, failed: 0 });
				expect(await exists(workspace)).toBe(false);
				if (mountingNames[name] === true) {
					expect(await fs.readFile(proof, "utf8")).toBe("unrecovered changes");
				} else {
					expect(await exists(proof)).toBe(false);
				}
			});
		}
	}

	for (const { name, backend } of backends.filter(({ name }) => name === "Overlayfs")) {
		it(`preserves ${name} data and reports a failed clear when stopping rejects`, async () => {
			const workspace = await makeWorkspace();
			await writeRetainedBackend(workspace, backend);
			vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("Unmount refused"));

			await clearWorktrees({ all: false, dryRun: false, json: true });

			expect(JSON.parse(stdout)).toMatchObject({
				removed: 0,
				failed: 1,
				results: [{ ok: false, error: "Unmount refused" }],
			});
			expect(await fs.readFile(path.join(workspace, "m", "changes.txt"), "utf8")).toBe("unrecovered changes");
			expect(process.exitCode).toBe(1);
		});
	}

	it("waits for stopping to finish before removing the workspace", async () => {
		const workspace = await makeWorkspace();
		await writeRetainedBackend(workspace, natives.IsoBackendKind.Overlayfs);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let stopped = false;
		const originalRm = fs.rm;
		vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
			if (file === workspace) expect(stopped).toBe(true);
			await originalRm(file, options);
		});
		vi.spyOn(natives, "isoStop").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			stopped = true;
		});
		const clearing = clearWorktrees({ all: false, dryRun: false, json: true });
		try {
			await Promise.race([
				entered.promise,
				clearing.then(() => {
					throw new Error("Cleanup completed before requesting the stop");
				}),
			]);
			expect(await fs.readFile(path.join(workspace, "m", "changes.txt"), "utf8")).toBe("unrecovered changes");
		} finally {
			release.resolve();
			await clearing;
		}
		expect(JSON.parse(stdout)).toMatchObject({ removed: 1, failed: 0 });
		expect(await exists(workspace)).toBe(false);
	});

	it("stops every known mount directory before removing their shared container", async () => {
		const workspace = await makeWorkspace(["m", "merged"]);
		await writeRetainedBackend(workspace, natives.IsoBackendKind.Overlayfs);
		const stopped: string[] = [];
		vi.spyOn(natives, "isoStop").mockImplementation(async (_, candidate) => {
			stopped.push(path.basename(candidate));
			expect(await fs.readFile(path.join(candidate, "changes.txt"), "utf8")).toBe("unrecovered changes");
		});
		await clearWorktrees({ all: false, dryRun: false, json: true });
		expect(stopped.sort()).toEqual(["m", "merged"]);
		expect(JSON.parse(stdout)).toMatchObject({ removed: 1, failed: 0 });
	});

	it("does not stop or remove a retained mount during a dry run", async () => {
		const workspace = await makeWorkspace();
		await writeRetainedBackend(workspace, natives.IsoBackendKind.Overlayfs);
		vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("Dry run touched the mount"));
		await clearWorktrees({ all: false, dryRun: true, json: true });
		expect(JSON.parse(stdout)).toEqual({ wouldRemove: [workspace] });
		expect(await fs.readFile(path.join(workspace, "m", "changes.txt"), "utf8")).toBe("unrecovered changes");
		expect(process.exitCode).toBe(0);
	});

	it("preserves workspace data when retained backend metadata is missing", async () => {
		const workspace = await makeWorkspace();
		vi.spyOn(natives, "isoStop").mockRejectedValue(new Error("Unknown workspace was stopped"));
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const result = JSON.parse(stdout);
		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.results[0].error).toContain("Missing retained backend metadata");
		expect(await fs.readFile(path.join(workspace, "m", "changes.txt"), "utf8")).toBe("unrecovered changes");
	});

	it("preserves workspace data and refuses clear when retained metadata is corrupted", async () => {
		const workspace = await makeWorkspace();
		await fs.writeFile(path.join(workspace, RETAINED_BACKEND_FILE), "{ invalid json }");
		vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		const result = JSON.parse(stdout);
		expect(result).toMatchObject({ removed: 0, failed: 1, results: [{ ok: false }] });
		expect(result.results[0].error).toContain("Failed to parse retained mount metadata");
		expect(await fs.readFile(path.join(workspace, "m", "changes.txt"), "utf8")).toBe("unrecovered changes");
		expect(process.exitCode).toBe(1);
	});

	it("preserves workspace data and refuses clear when retained metadata has an invalid backend", async () => {
		const workspace = await makeWorkspace();
		await fs.writeFile(
			path.join(workspace, RETAINED_BACKEND_FILE),
			JSON.stringify({ backend: "not-a-number", retainedAt: new Date().toISOString() }),
		);
		vi.spyOn(natives, "isoStop").mockResolvedValue(undefined);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		const result = JSON.parse(stdout);
		expect(result).toMatchObject({ removed: 0, failed: 1, results: [{ ok: false }] });
		expect(result.results[0].error).toContain("Invalid retained mount metadata");
		expect(await fs.readFile(path.join(workspace, "m", "changes.txt"), "utf8")).toBe("unrecovered changes");
		expect(process.exitCode).toBe(1);
	});

	it("preserves an in-flight isolation claim and sentinel across ordinary clear and clear --all", async () => {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		child_process.execFileSync("git", ["init", "-q", repo]);

		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});

		const id = "in-flight-task-claim";
		const inIsoStart = Promise.withResolvers<void>();
		const releaseIsoStart = Promise.withResolvers<void>();
		let isoStartCalled = false;
		let claimedBaseDir = "";

		vi.spyOn(natives, "isoStart").mockImplementation(async (_, _source, mergedDir) => {
			isoStartCalled = true;
			claimedBaseDir = path.dirname(mergedDir);
			inIsoStart.resolve();
			await releaseIsoStart.promise;
			await fs.mkdir(mergedDir, { recursive: true });
		});

		// Task A calls real ensureIsolation and pauses inside substituted native isoStart before m exists
		const taskAPromise = ensureIsolation(repo, id);
		await inIsoStart.promise;
		expect(isoStartCalled).toBe(true);
		expect(await exists(claimedBaseDir)).toBe(true);

		// Verify m does not exist yet
		const mountDir = path.join(claimedBaseDir, "m");
		expect(await exists(mountDir)).toBe(false);

		// Place sentinel file at the claim root
		const sentinel = path.join(claimedBaseDir, "sentinel.txt");
		await fs.writeFile(sentinel, "in-flight-claim-sentinel");

		// Task B: same-id second call must be rejected
		await expect(ensureIsolation(repo, id)).rejects.toThrow("refusing replacement");
		expect(await fs.readFile(sentinel, "utf8")).toBe("in-flight-claim-sentinel");

		// Real ordinary clear: live claims are omitted from ordinary clear
		await clearWorktrees({ all: false, dryRun: true, json: true });
		expect(stdout).not.toContain("would remove");
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const ordinaryResult = JSON.parse(stdout);
		expect(ordinaryResult).toMatchObject({ removed: 0, kept: 1 });
		expect(await exists(claimedBaseDir)).toBe(true);
		expect(await fs.readFile(sentinel, "utf8")).toBe("in-flight-claim-sentinel");
		// Real --all clear: clearWorktrees({ all: true, dryRun: false, json: true })
		await clearWorktrees({ all: true, dryRun: false, json: true });
		const allResult = JSON.parse(stdout);
		expect(allResult).toMatchObject({ removed: 0, failed: 1 });
		expect(allResult.results[0].error).toContain("Missing retained backend metadata");
		expect(await exists(claimedBaseDir)).toBe(true);
		expect(await fs.readFile(sentinel, "utf8")).toBe("in-flight-claim-sentinel");

		// Task C: third same-id allocation must still be rejected
		await expect(ensureIsolation(repo, id)).rejects.toThrow("refusing replacement");
		expect(await exists(claimedBaseDir)).toBe(true);
		expect(await fs.readFile(sentinel, "utf8")).toBe("in-flight-claim-sentinel");

		// Release native boundary
		releaseIsoStart.resolve();
		const handle = await taskAPromise;
		expect(handle.mergedDir).toBe(mountDir);
		expect(await exists(mountDir)).toBe(true);
		expect(await fs.readFile(sentinel, "utf8")).toBe("in-flight-claim-sentinel");

		// Allowed retained copy cleanup assertion:
		const retained = await retainIsolationWorkspace(handle.mergedDir, handle.backend);
		expect(retained.sidecarOk).toBe(true);
		expect(await exists(retained.dir)).toBe(true);

		// Clearing worktrees now cleanly removes the retained copy workspace
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const retainedClearResult = JSON.parse(stdout);
		expect(retainedClearResult).toMatchObject({ removed: 1, failed: 0 });
		expect(await exists(retained.dir)).toBe(false);
	});

	it("P1 ABA regression: stale clear authorization does not delete new claim instance at same path", async () => {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		child_process.execFileSync("git", ["init", "-q", repo]);

		const id = "p1-aba-clear-race";
		const repoRootDir = await getRepoRoot(repo);
		const segment = getTaskIsolationSegment(repoRootDir, id);
		const canonicalDir = path.join(path.join(root, "workspaces"), segment);

		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});

		vi.spyOn(natives, "isoStart").mockImplementation(async (_, _source, mergedDir) => {
			await fs.mkdir(mergedDir, { recursive: true });
			await fs.writeFile(path.join(mergedDir, "old-changes.txt"), "old-changes");
		});

		const setupHandle = await ensureIsolation(repo, id);
		expect(await exists(canonicalDir)).toBe(true);

		const originalRename = fs.rename;
		let renameFailures = 0;
		vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
			if (oldPath === canonicalDir) {
				renameFailures++;
				throw new Error("EBUSY: simulated locked file during rename");
			}
			return originalRename(oldPath, newPath);
		});

		const retained = await retainIsolationWorkspace(setupHandle.mergedDir, setupHandle.backend);
		vi.restoreAllMocks();
		vi.spyOn(utils, "getWorktreesDir").mockReturnValue(path.join(root, "workspaces"));
		vi.spyOn(console, "log").mockImplementation(line => {
			stdout = String(line);
		});

		const oldSentinel = path.join(canonicalDir, "old-sentinel.txt");
		await fs.writeFile(oldSentinel, "old-sentinel");
		expect(renameFailures).toBe(3);
		expect(retained.sidecarOk).toBe(true);
		expect(await exists(canonicalDir)).toBe(true);
		expect(await exists(path.join(canonicalDir, RETAINED_BACKEND_FILE))).toBe(true);

		const initialOwner = await readIsolationOwner(canonicalDir);

		// Clear B removes the old retained root cleanly
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const clearBResult = JSON.parse(stdout);
		expect(clearBResult).toMatchObject({ removed: 1, failed: 0 });
		expect(await exists(canonicalDir)).toBe(false);

		// Task A now claims the same path with real ensureIsolation
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockImplementation(async (_, _source, mergedDir) => {
			await fs.mkdir(mergedDir, { recursive: true });
		});

		const taskAHandle = await ensureIsolation(repo, id);
		expect(await exists(canonicalDir)).toBe(true);
		const newSentinel = path.join(canonicalDir, "task-a-sentinel.txt");
		await fs.writeFile(newSentinel, "task-a-data");

		const newOwner = await readIsolationOwner(canonicalDir);
		expect(newOwner).not.toBeNull();
		if (initialOwner) {
			expect(newOwner!.token).not.toBe(initialOwner.token);
		}

		// Clear C running on the target (with stale target entry) must fail closed because
		// the new claim is not authorized by retained backend metadata and owner is live!
		stdout = "";
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const clearCResult = JSON.parse(stdout);
		expect(clearCResult).toMatchObject({ removed: 0, failed: 1 });
		expect(clearCResult.results[0].error).toContain("Missing retained backend metadata");
		expect(clearCResult.results[0].error).toContain("active live owner");

		// Task A's reservation and sentinel must be intact!
		expect(await exists(canonicalDir)).toBe(true);
		expect(await exists(newSentinel)).toBe(true);
		expect(await fs.readFile(newSentinel, "utf8")).toBe("task-a-data");
	});

	it("P2 regression: dead child process abandoned empty reservation is reclaimable by clear and allocation", async () => {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		child_process.execFileSync("git", ["init", "-q", repo]);

		const id = "p2-abandoned-empty";
		const repoRootDir = await getRepoRoot(repo);
		const segment = getTaskIsolationSegment(repoRootDir, id);
		const canonicalDir = path.join(path.join(root, "workspaces"), segment);

		const childScriptPath = path.join(root, `child-crash-${Date.now()}.test.ts`);
		const childScript = `
import { vi, spyOn } from "bun:test";
import * as natives from ${JSON.stringify(import.meta.resolve("@veyyon/natives"))};
import * as utils from ${JSON.stringify(import.meta.resolve("@veyyon/utils"))};
import { ensureIsolation } from ${JSON.stringify(path.resolve(__dirname, "../../src/task/worktree.ts"))};

const workspacesDir = process.env.TEST_WORKSPACES_DIR!;
const repo = process.env.TEST_REPO_DIR!;
const id = process.env.TEST_TASK_ID!;

process.env.VEYYON_WORKTREE_DIR = workspacesDir;
utils.setWorktreesDir(workspacesDir);

const mockSpy = (typeof vi !== "undefined" && vi.spyOn) ? vi.spyOn : spyOn;
mockSpy(natives, "isoResolve").mockReturnValue({
	kind: natives.IsoBackendKind.Rcopy,
	candidates: [natives.IsoBackendKind.Rcopy],
	fellBack: false,
	reason: undefined,
});

mockSpy(natives, "isoStart").mockImplementation(async () => {
	process.exit(42);
});

try {
	await ensureIsolation(repo, id);
} catch (err) {
	console.error("CHILD_ERR:", err);
	process.exit(1);
}
`;
		await fs.writeFile(childScriptPath, childScript, "utf8");

		try {
			const childRes = child_process.spawnSync("bun", ["test", childScriptPath], {
				cwd: process.cwd(),
				env: {
					...process.env,
					TEST_WORKSPACES_DIR: path.join(root, "workspaces"),
					TEST_REPO_DIR: repo,
					TEST_TASK_ID: id,
				},
				encoding: "utf8",
			});
			if (childRes.status !== 42) {
				console.error("CHILD STDERR:", childRes.stderr);
				console.error("CHILD STDOUT:", childRes.stdout);
			}
			expect(childRes.status).toBe(42);
		} finally {
			await fs.rm(childScriptPath, { force: true });
		}
		// Verify on-disk state: canonicalDir exists, has ONLY owner record, NO "m"
		expect(await exists(canonicalDir)).toBe(true);
		expect(await exists(path.join(canonicalDir, "m"))).toBe(false);
		expect(await exists(path.join(canonicalDir, ISOLATION_OWNER_FILE))).toBe(true);
		const entries = await fs.readdir(canonicalDir);
		expect(entries.sort()).toEqual([ISOLATION_CLAIM_FILE, ISOLATION_OWNER_FILE].sort());

		const deadOwner = await readIsolationOwner(canonicalDir);
		expect(deadOwner).not.toBeNull();
		expect(utils.isProcessInstanceAlive(deadOwner!.pid, deadOwner!.startIdentity)).toBe(false);

		// Same-id ensureIsolation must successfully reclaim the dead abandoned empty reservation!
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockImplementation(async (_, _source, mergedDir) => {
			await fs.mkdir(mergedDir, { recursive: true });
		});

		const reclaimedHandle = await ensureIsolation(repo, id);
		expect(reclaimedHandle.mergedDir).toBe(path.join(canonicalDir, "m"));
		expect(await exists(path.join(canonicalDir, "m"))).toBe(true);

		const activeOwner = await readIsolationOwner(canonicalDir);
		expect(activeOwner!.pid).toBe(process.pid);
		expect(activeOwner!.token).not.toBe(deadOwner!.token);
	});

	it("P2 regression: clearWorktrees reclaims dead abandoned empty reservation", async () => {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		child_process.execFileSync("git", ["init", "-q", repo]);

		const id = "p2-clear-abandoned-empty";
		const repoRootDir = await getRepoRoot(repo);
		const segment = getTaskIsolationSegment(repoRootDir, id);
		const canonicalDir = path.join(path.join(root, "workspaces"), segment);

		await fs.mkdir(canonicalDir, { recursive: true });
		const deadRecord: IsolationOwnerRecord = {
			pid: 999999,
			startIdentity: "dead-start-id",
			token: "dead-token-123",
			createdAt: new Date().toISOString(),
		};
		await fs.writeFile(path.join(canonicalDir, ISOLATION_OWNER_FILE), JSON.stringify(deadRecord));
		expect(await fs.readdir(canonicalDir)).toEqual([ISOLATION_OWNER_FILE]);

		stdout = "";
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const result = JSON.parse(stdout);
		expect(result).toMatchObject({ removed: 1, failed: 0 });
		expect(await exists(canonicalDir)).toBe(false);
	});

	it("P2 negative control: dead reservation containing unknown files or mount directory fails closed", async () => {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		child_process.execFileSync("git", ["init", "-q", repo]);

		const id = "p2-negative-control";
		const repoRootDir = await getRepoRoot(repo);
		const segment = getTaskIsolationSegment(repoRootDir, id);
		const canonicalDir = path.join(path.join(root, "workspaces"), segment);

		await fs.mkdir(canonicalDir, { recursive: true });
		const deadRecord: IsolationOwnerRecord = {
			pid: 999999,
			startIdentity: "dead-start-id",
			token: "dead-token-456",
			createdAt: new Date().toISOString(),
		};
		await fs.writeFile(path.join(canonicalDir, ISOLATION_OWNER_FILE), JSON.stringify(deadRecord));
		await fs.writeFile(path.join(canonicalDir, "mystery.txt"), "important-data");

		stdout = "";
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const result = JSON.parse(stdout);
		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.results[0].error).toContain("Missing retained backend metadata");
		expect(await exists(canonicalDir)).toBe(true);
		expect(await exists(path.join(canonicalDir, "mystery.txt"))).toBe(true);

		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});

		await expect(ensureIsolation(repo, id)).rejects.toThrow("refusing replacement");
		expect(await exists(path.join(canonicalDir, "mystery.txt"))).toBe(true);
	});

	it("refuses clear and replacement when owner record is malformed (invalid pid or empty token)", async () => {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		child_process.execFileSync("git", ["init", "-q", repo]);

		const id = "malformed-owner-regression";
		const repoRootDir = await getRepoRoot(repo);
		const segment = getTaskIsolationSegment(repoRootDir, id);
		const canonicalDir = path.join(path.join(root, "workspaces"), segment);

		await fs.mkdir(canonicalDir, { recursive: true });
		// Write corrupt/malformed owner record with negative PID and empty token
		await fs.writeFile(
			path.join(canonicalDir, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: -1, token: "   ", createdAt: new Date().toISOString() }),
			"utf8",
		);

		stdout = "";
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const result = JSON.parse(stdout);
		expect(result).toMatchObject({ removed: 0, failed: 1 });
		expect(result.results[0].error).toContain("Missing retained backend metadata");
		expect(await exists(canonicalDir)).toBe(true);

		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});

		await expect(ensureIsolation(repo, id)).rejects.toThrow("refusing replacement");
		expect(await exists(canonicalDir)).toBe(true);
	});
});
