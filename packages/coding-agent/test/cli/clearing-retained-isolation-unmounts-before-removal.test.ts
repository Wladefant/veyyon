/**
 * WHY: clearing a retained mount used to remove its files before stopping it.
 * Exercise the real scanner and clear handler over every native backend and
 * both mount layouts. Overlayfs stop failures preserve data; Projfs is refused
 * because its process-local stop can return success without stopping anything.
 * The native boundary is substituted; actual OS unmounting is not proved here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@veyyon/natives";
import * as child_process from "node:child_process";
import * as utils from "@veyyon/utils";
import { clearWorktrees } from "../../src/cli/worktree-cli";
import { retainIsolationWorkspace } from "../../src/task/isolation-runner";
import { RETAINED_BACKEND_FILE, writeRetainedBackend } from "../../src/task/isolation-ownership";
import { ensureIsolation } from "../../src/task/worktree";
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

		// Real ordinary clear: clearWorktrees({ all: false, dryRun: false, json: true })
		await clearWorktrees({ all: false, dryRun: false, json: true });
		const ordinaryResult = JSON.parse(stdout);
		expect(ordinaryResult).toMatchObject({ removed: 0, failed: 1 });
		expect(ordinaryResult.results[0].error).toContain("Missing retained backend metadata");
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
});
