import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import { RETAINED_BACKEND_FILE, readRetainedMountBackend } from "@veyyon/coding-agent/task/isolation-ownership";
import {
	applyEligibleNestedPatches,
	mergeIsolatedChanges,
	retainIsolationWorkspace,
	runIsolatedSubprocess,
} from "@veyyon/coding-agent/task/isolation-runner";
import type { SingleResult } from "@veyyon/coding-agent/task/types";
import * as worktreeModule from "@veyyon/coding-agent/task/worktree";
import * as gitModule from "@veyyon/coding-agent/utils/git";
import * as natives from "@veyyon/natives";
import { $ } from "bun";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "NestedOnly",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

const tempRoots: string[] = [];

async function git(repoRoot: string, ...args: string[]): Promise<string> {
	const result = await $`git ${args}`.cwd(repoRoot).quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	}
	return result.text();
}

async function seedFooRepo(finalContent: string): Promise<{ repoRoot: string; patchPath: string }> {
	const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-isolation-merge-"));
	tempRoots.push(repoRoot);

	await git(repoRoot, "init");
	await git(repoRoot, "config", "user.email", "repro@example.com");
	await git(repoRoot, "config", "user.name", "Repro");
	await Bun.write(path.join(repoRoot, "foo.txt"), "old\n");
	await git(repoRoot, "add", "foo.txt");
	await git(repoRoot, "commit", "-m", "base");
	await Bun.write(path.join(repoRoot, "foo.txt"), "new\n");
	await git(repoRoot, "commit", "-am", "change to new");

	const patchPath = path.join(repoRoot, "task.patch");
	const patchText = await git(repoRoot, "diff-tree", "--binary", "--full-index", "--no-commit-id", "-p", "HEAD");
	await Bun.write(patchPath, patchText);

	if (finalContent !== "new\n") {
		await git(repoRoot, "reset", "--hard", "HEAD~1");
		if (finalContent !== "old\n") {
			await Bun.write(path.join(repoRoot, "foo.txt"), finalContent);
			await git(repoRoot, "commit", "-am", "diverge");
		}
	}
	return { repoRoot, patchPath };
}

describe("runIsolatedSubprocess", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	/**
	 * Drive a branch-mode spawn whose apply-back throws, with both rescue probes
	 * stubbed. Each argument takes the value to resolve with or the error to
	 * reject with, so every branch of the rescue decision is reachable.
	 */
	async function runFailingBranchApply(agentId: string, range: string[] | Error, probe: boolean | Error) {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-isolation-rescue-"));
		tempRoots.push(repoRoot);
		const isolationDir = path.join(repoRoot, "isolated");
		const artifactsDir = path.join(repoRoot, "artifacts");
		const baseline = {
			root: {
				repoRoot,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: agentId }));
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("git apply --3way failed"));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		const rangeSpy =
			range instanceof Error
				? vi.spyOn(gitModule.revList, "range").mockRejectedValue(range)
				: vi.spyOn(gitModule.revList, "range").mockResolvedValue(range);
		const probeSpy =
			probe instanceof Error
				? vi.spyOn(gitModule.ref, "exists").mockRejectedValue(probe)
				: vi.spyOn(gitModule.ref, "exists").mockResolvedValue(probe);
		const deleteSpy = vi.spyOn(gitModule.branch, "tryDelete").mockResolvedValue(true);

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: repoRoot,
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: agentId,
			},
			context: { repoRoot, baseline },
			preferredBackend: undefined,
			agentId,
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		return { outcome, repoRoot, rangeSpy, probeSpy, deleteSpy };
	}

	it("preserves branch-mode output as a patch when branch transfer fails", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-isolation-run-"));
		tempRoots.push(repoRoot);
		const isolationDir = path.join(repoRoot, "isolated");
		const artifactsDir = path.join(repoRoot, "artifacts");
		const baseline = {
			root: {
				repoRoot,
				headCommit: "base",
				staged: "",
				unstaged: "",
				untracked: [],
				untrackedPatch: "",
			},
			nested: [],
		};
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "PreserveBranchFailure" }));
		vi.spyOn(worktreeModule, "commitToBranch").mockRejectedValue(new Error("remote: object corrupt"));
		const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
		// No branch was ever created, so the rescue probe finds nothing to keep.
		vi.spyOn(gitModule.revList, "range").mockRejectedValue(new Error("unknown revision"));
		vi.spyOn(gitModule.ref, "exists").mockResolvedValue(false);
		const deleteSpy = vi.spyOn(gitModule.branch, "tryDelete").mockResolvedValue(true);

		const outcome = await runIsolatedSubprocess({
			baseOptions: {
				cwd: repoRoot,
				agent: {
					name: "task",
					description: "Task agent",
					systemPrompt: "test",
					source: "bundled",
				},
				task: "Do work",
				index: 0,
				id: "PreserveBranchFailure",
			},
			context: { repoRoot, baseline },
			preferredBackend: undefined,
			agentId: "PreserveBranchFailure",
			mergeMode: "branch",
			artifactsDir,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		const patchPath = path.join(artifactsDir, "PreserveBranchFailure.patch");
		expect(outcome.error).toContain("Merge failed: remote: object corrupt");
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		expect(outcome.nestedPatches).toEqual([]);
		expect(captureSpy).toHaveBeenCalledWith(isolationDir, baseline);
		expect(deleteSpy).toHaveBeenCalledWith(repoRoot, "veyyon/task/PreserveBranchFailure");
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps a task branch that already holds the agent's commits", async () => {
		const { outcome, deleteSpy } = await runFailingBranchApply(
			"RescueBranchCommits",
			["commit-a", "commit-b"],
			false,
		);

		expect(deleteSpy).not.toHaveBeenCalled();
		expect(outcome.error).toContain("Merge failed: git apply --3way failed");
		expect(outcome.error).toContain("preserved on branch veyyon/task/RescueBranchCommits");
	});

	it("keeps a task branch whose commits the probe could not read", async () => {
		const { outcome, repoRoot, probeSpy, deleteSpy } = await runFailingBranchApply(
			"UnreadableObjects",
			new Error("object database unavailable"),
			true,
		);

		expect(probeSpy).toHaveBeenCalledWith(repoRoot, "refs/heads/veyyon/task/UnreadableObjects");
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(outcome.error).toContain("preserved on branch veyyon/task/UnreadableObjects");
	});

	it("keeps a task branch when even the existence probe fails", async () => {
		const { outcome, deleteSpy } = await runFailingBranchApply(
			"BlindProbe",
			new Error("unknown revision"),
			new Error("rev-parse unavailable"),
		);

		expect(deleteSpy).not.toHaveBeenCalled();
		expect(outcome.error).toContain("preserved on branch veyyon/task/BlindProbe");
	});

	it("still deletes a task branch that never received a commit", async () => {
		const { outcome, repoRoot, deleteSpy } = await runFailingBranchApply("StaleBranch", [], false);

		expect(deleteSpy).toHaveBeenCalledWith(repoRoot, "veyyon/task/StaleBranch");
		expect(outcome.error).toContain("Merge failed: git apply --3way failed");
		expect(outcome.error).not.toContain("preserved on branch");
	});

	for (const { label, blocked, id } of [
		{ label: "writes nested-repo patches before teardown", blocked: false, id: "NestedPersist" },
		{ label: "retains workspace when write fails", blocked: true, id: "RetainOnFailure" },
	]) {
		it(label, async () => {
			const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-"));
			tempRoots.push(tmp);
			const artifactsDir = blocked ? path.join(tmp, "artifacts") : tmp;
			if (blocked) await Bun.write(artifactsDir, "not a directory");
			const nestedPatch = "diff --git a/b.txt b/b.txt\n+hi\n";
			vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
				mergedDir: "/repo/isolated",
				backend: natives.IsoBackendKind.Rcopy,
				fellBack: false,
				fallbackReason: null,
			});
			vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id }));
			vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
				rootPatch: "",
				nestedPatches: [{ relativePath: "inner", patch: nestedPatch }],
			});
			vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();
			const outcome = await runIsolatedSubprocess({
				baseOptions: { cwd: "/repo", agent: { name: "task" } as never, task: "w", index: 0, id },
				context: { repoRoot: "/repo", baseline: { root: { headCommit: "b" } } as never },
				preferredBackend: undefined,
				agentId: id,
				mergeMode: "patch",
				artifactsDir,
				buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
			});
			if (blocked) {
				expect(outcome.error).toContain("Isolation workspace retained at /repo/isolated");
				expect(outcome.nestedPatchPaths).toBeUndefined();
			} else {
				const nestedPath = path.join(artifactsDir, `${id}.nested-0-inner.patch`);
				expect(outcome.hasRootChanges).toBe(false);
				expect(outcome.nestedPatchPaths).toEqual([nestedPath]);
				expect(await Bun.file(nestedPath).text()).toBe(nestedPatch);
			}
		});
	}

	it("removes the nested patches already written when a later one cannot be written, and retains the workspace", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-"));
		tempRoots.push(tmp);
		const id = "PartialNested";
		// A directory squatting on the second destination makes that write fail
		// after the first nested patch has already landed.
		await fs.mkdir(path.join(tmp, `${id}.nested-1-second.patch`));
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id }));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "diff --git a/a.txt b/a.txt\n+root\n",
			nestedPatches: [
				{ relativePath: "first", patch: "diff --git a/b.txt b/b.txt\n+1\n" },
				{ relativePath: "second", patch: "diff --git a/c.txt b/c.txt\n+2\n" },
			],
		});
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const outcome = await runIsolatedSubprocess({
			baseOptions: { cwd: "/repo", agent: { name: "task" } as never, task: "w", index: 0, id },
			context: { repoRoot: "/repo", baseline: { root: { headCommit: "b" } } as never },
			preferredBackend: undefined,
			agentId: id,
			mergeMode: "patch",
			artifactsDir: tmp,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		expect(outcome.error).toContain("Isolation workspace retained at /repo/isolated");
		expect(outcome.nestedPatchPaths).toBeUndefined();
		expect(await Bun.file(path.join(tmp, `${id}.nested-0-first.patch`)).exists()).toBe(false);
	});

	it("preserves pre-existing destination data when a nested patch collides on EEXIST", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-"));
		tempRoots.push(tmp);
		const id = "CollisionPreserve";
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id }));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "diff --git a/a.txt b/a.txt\n+root\n",
			nestedPatches: [
				{ relativePath: "first", patch: "diff --git a/b.txt b/b.txt\n+1\n" },
				{ relativePath: "second", patch: "diff --git a/c.txt b/c.txt\n+2\n" },
			],
		});
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		// Pre-create the second destination with unrecovered content
		const preExistingFile = path.join(tmp, `${id}.nested-1-second.patch`);
		await fs.writeFile(preExistingFile, "precious-unrecovered-data", "utf8");

		const outcome = await runIsolatedSubprocess({
			baseOptions: { cwd: "/repo", agent: { name: "task" } as never, task: "w", index: 0, id },
			context: { repoRoot: "/repo", baseline: { root: { headCommit: "b" } } as never },
			preferredBackend: undefined,
			agentId: id,
			mergeMode: "patch",
			artifactsDir: tmp,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		expect(await Bun.file(preExistingFile).text()).toBe("precious-unrecovered-data");
		expect(outcome.error).toContain("Isolation workspace retained at /repo/isolated");
		expect(outcome.nestedPatchPaths).toBeUndefined();
		// The newly created first patch was cleaned up
		expect(await Bun.file(path.join(tmp, `${id}.nested-0-first.patch`)).exists()).toBe(false);
		// The pre-existing file was preserved and untouched
		expect(await Bun.file(preExistingFile).exists()).toBe(true);
	});

	it("removes the in-progress nested patch destination on mid-write failure", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-iso-"));
		tempRoots.push(tmp);
		const id = "MidWriteFail";
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id }));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch: "diff --git a/a.txt b/a.txt\n+root\n",
			nestedPatches: [
				{ relativePath: "first", patch: "diff --git a/b.txt b/b.txt\n+1\n" },
				{ relativePath: "second", patch: "diff --git a/c.txt b/c.txt\n+2\n" },
			],
		});
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const originalOpen = fs.open.bind(fs);
		let opens = 0;
		vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
			const handle = await originalOpen(filePath, flags, mode);
			opens += 1;
			if (opens === 2) {
				const originalWriteFile = handle.writeFile.bind(handle);
				vi.spyOn(handle, "writeFile").mockImplementation(async () => {
					// Simulate a mid-write failure (ENOSPC, quota): content partially written
					await originalWriteFile("partial-corrupted");
					throw new Error("ENOSPC");
				});
			}
			return handle;
		});

		const outcome = await runIsolatedSubprocess({
			baseOptions: { cwd: "/repo", agent: { name: "task" } as never, task: "w", index: 0, id },
			context: { repoRoot: "/repo", baseline: { root: { headCommit: "b" } } as never },
			preferredBackend: undefined,
			agentId: id,
			mergeMode: "patch",
			artifactsDir: tmp,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		expect(outcome.error).toContain("Isolation workspace retained at /repo/isolated");
		expect(outcome.nestedPatchPaths).toBeUndefined();
		expect(await Bun.file(path.join(tmp, `${id}.nested-0-first.patch`)).exists()).toBe(false);
		expect(await Bun.file(path.join(tmp, `${id}.nested-1-second.patch`)).exists()).toBe(false);
	});

	it("reports missing mount metadata in error when sidecar cannot be written", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-iso-sidecar-"));
		tempRoots.push(tmp);
		const baseDir = path.join(tmp, "wt_fail");
		const isolationDir = path.join(baseDir, "m");
		await fs.mkdir(isolationDir, { recursive: true });

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Overlayfs,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result({ id: "SidecarFail" }));
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockRejectedValue(new Error("disk full"));
		vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const originalWriteFile = fs.writeFile.bind(fs);
		vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
			if (typeof file === "string" && file.endsWith(RETAINED_BACKEND_FILE)) {
				throw new Error("ENOSPC");
			}
			return originalWriteFile(file, data, options);
		});

		const outcome = await runIsolatedSubprocess({
			baseOptions: { cwd: "/repo", agent: { name: "task" } as never, task: "w", index: 0, id: "SidecarFail" },
			context: { repoRoot: "/repo", baseline: { root: { headCommit: "b" } } as never },
			preferredBackend: undefined,
			agentId: "SidecarFail",
			mergeMode: "patch",
			artifactsDir: tmp,
			buildFailureResult: err => result({ exitCode: 1, error: String(err) }),
		});

		expect(outcome.error).toContain("Its mount metadata is missing, so unmount");
		expect(outcome.error).toContain("manually before clearing.");
	});
});

describe("retainIsolationWorkspace", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("moves the workspace to a unique sibling out of the deterministic slot", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-isolation-retain-"));
		tempRoots.push(parent);
		const baseDir = path.join(parent, "wt_abc123");
		const isolationDir = path.join(baseDir, "m");
		await fs.mkdir(isolationDir, { recursive: true });
		await Bun.write(path.join(isolationDir, "work.txt"), "unrecovered");

		const retained = await retainIsolationWorkspace(isolationDir, natives.IsoBackendKind.Overlayfs);

		expect(retained).toEqual({ dir: expect.any(String), sidecarOk: true });
		expect(retained.dir).not.toBe(isolationDir);
		expect(path.dirname(retained.dir)).toContain(".retained-");
		expect(await Bun.file(path.join(retained.dir, "work.txt")).text()).toBe("unrecovered");
		expect(await Bun.file(baseDir).exists()).toBe(false);
		const sidecar = await Bun.file(path.join(path.dirname(retained.dir), RETAINED_BACKEND_FILE)).json();
		expect(sidecar.backend).toBe(natives.IsoBackendKind.Overlayfs);
		tempRoots.push(path.dirname(retained.dir));
	});

	it("preserves the original projected root and records its backend for safe cleanup refusal", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-isolation-retain-projfs-"));
		tempRoots.push(parent);
		const baseDir = path.join(parent, "projection");
		const isolationDir = path.join(baseDir, "m");
		await fs.mkdir(isolationDir, { recursive: true });
		await fs.writeFile(path.join(isolationDir, "work.txt"), "unrecovered projected changes");

		const retained = await retainIsolationWorkspace(isolationDir, natives.IsoBackendKind.Projfs);

		expect(retained).toEqual({ dir: isolationDir, sidecarOk: true });
		expect(await fs.readFile(path.join(isolationDir, "work.txt"), "utf8")).toBe("unrecovered projected changes");
		expect(await readRetainedMountBackend(baseDir)).toBe(natives.IsoBackendKind.Projfs);
	});

	it("records no sidecar for copy backends that need no unmount", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-isolation-retain-rcopy-"));
		tempRoots.push(parent);
		const isolationDir = path.join(parent, "wt_abc123", "m");
		await fs.mkdir(isolationDir, { recursive: true });

		const retained = await retainIsolationWorkspace(isolationDir, natives.IsoBackendKind.Rcopy);

		expect(retained.sidecarOk).toBe(true);
		expect(await Bun.file(path.join(path.dirname(retained.dir), RETAINED_BACKEND_FILE)).exists()).toBe(false);
		tempRoots.push(path.dirname(retained.dir));
	});

	it("reports the original dir when the move fails", async () => {
		const missingParent = path.join(os.tmpdir(), `veyyon-isolation-retain-missing-${Date.now()}`);
		const isolationDir = path.join(missingParent, "wt_abc123", "m");

		await expect(retainIsolationWorkspace(isolationDir)).resolves.toEqual({
			dir: isolationDir,
			sidecarOk: true,
		});
		await expect(fs.stat(missingParent)).rejects.toThrow();
	});

	it("reports missing metadata when the sidecar cannot be written", async () => {
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-isolation-retain-sidecar-"));
		tempRoots.push(parent);
		const isolationDir = path.join(parent, "wt_abc123", "m");
		await fs.mkdir(isolationDir, { recursive: true });
		await Bun.write(path.join(isolationDir, "work.txt"), "unrecovered");
		const originalWriteFile = fs.writeFile.bind(fs);
		vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
			if (typeof file === "string" && file.endsWith(RETAINED_BACKEND_FILE)) {
				throw new Error("EACCES: permission denied");
			}
			return originalWriteFile(file, data, options);
		});

		const retained = await retainIsolationWorkspace(isolationDir, natives.IsoBackendKind.Overlayfs);

		expect(retained.sidecarOk).toBe(false);
		expect(retained.dir).not.toBe(isolationDir);
		tempRoots.push(path.dirname(retained.dir));
	});
});

describe("mergeIsolatedChanges", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("allows nested-only branch-mode patches to apply when no root branch was created", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(outcome.mergedBranchForNestedPatches).toBe(true);
		expect(outcome.summary).toContain("nested repository patches captured");
	});

	it("surfaces branch preparation errors instead of reporting no changes", async () => {
		const mergeSpy = vi.spyOn(worktreeModule, "mergeTaskBranches");
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				error: "Merge failed: git apply --3way failed for task dirty-context: conflict",
				patchPath: "/repo/artifacts/dirty-context.patch",
			}),
		});

		expect(mergeSpy).not.toHaveBeenCalled();
		expect(outcome.changesApplied).toBe(false);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
		expect(outcome.summary).toContain("Branch merge failed while capturing the task branch");
		expect(outcome.summary).toContain("git apply --3way failed");
		expect(outcome.summary).toContain("/repo/artifacts/dirty-context.patch");
		expect(outcome.summary).not.toContain("No changes to apply");
	});

	it("treats already-applied patch-mode diffs as successful no-ops", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("new\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.summary).not.toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
	});

	it("rejects patch-mode conflicts without dirtying the worktree", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("other\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("Patches were not applied");
		expect(await git(repoRoot, "status", "--porcelain", "--", "foo.txt")).toBe("");
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("other\n");
		expect(await git(repoRoot, "ls-files", "-u", "--", "foo.txt")).toBe("");
	});

	it("applies a fresh patch-mode diff when context matches", async () => {
		const { repoRoot, patchPath } = await seedFooRepo("old\n");

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(await Bun.file(path.join(repoRoot, "foo.txt")).text()).toBe("new\n");
	});

	it("prefers forward apply when both reverse-check and forward-check succeed", async () => {
		// If git-apply's fuzz ever lets `--reverse --check` succeed while forward
		// `--check` also succeeds (e.g. repeated context with the postimage present
		// elsewhere), the outcome must NOT be a silent no-op.
		const { repoRoot, patchPath } = await seedFooRepo("old\n");
		const canApplySpy = vi.spyOn(gitModule.patch, "canApplyText").mockResolvedValue(true);
		const applySpy = vi.spyOn(gitModule.patch, "applyText").mockResolvedValue(undefined);

		const outcome = await mergeIsolatedChanges({
			repoRoot,
			mergeMode: "patch",
			result: result({ patchPath }),
		});

		expect(canApplySpy).toHaveBeenCalledTimes(2);
		expect(applySpy).toHaveBeenCalledTimes(1);
		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
	});

	it("does not mark failed branch-mode runs as nested-patch eligible", async () => {
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				exitCode: 1,
				nestedPatches: [{ relativePath: "nested", patch: "diff --git a/file b/file\n" }],
			}),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(false);
		expect(outcome.mergedBranchForNestedPatches).toBe(false);
	});

	it("names preserved branch in merge-error summary when merge phase fails", async () => {
		vi.spyOn(worktreeModule, "mergeTaskBranches").mockRejectedValue(new Error("fast-forward refused"));
		const outcome = await mergeIsolatedChanges({
			repoRoot: "/repo",
			mergeMode: "branch",
			result: result({
				branchName: "omp/task/Throwing",
				patchPath: "/repo/artifacts/task.patch",
			}),
		});

		expect(outcome.changesApplied).toBe(false);
		expect(outcome.summary).toContain("Merge phase failed: fast-forward refused");
		expect(outcome.summary).toContain("Unmerged branch preserved as omp/task/Throwing for manual resolution.");
		expect(outcome.summary).toContain("/repo/artifacts/task.patch");
	});
});

describe("applyEligibleNestedPatches", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const nestedPatch = { relativePath: "nested", patch: "diff --git a/file b/file\n" };

	it("skips when patch-mode parent merge failed", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: false,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("skips when branch mode did not actually merge the root branch", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches");
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("applies nested patches and returns no warning on success", async () => {
		const applySpy = vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toBe("");
		expect(applySpy).toHaveBeenCalledTimes(1);
	});

	it("returns a system-notification suffix on apply failure", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockRejectedValue(new Error("boom"));
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "branch",
			changesApplied: true,
			mergedBranchForNestedPatches: true,
		});
		expect(suffix).toContain("Some nested repository patches failed to apply");
	});

	it("surfaces stash-restore warnings from applyNestedPatches as a system-notification", async () => {
		vi.spyOn(worktreeModule, "applyNestedPatches").mockResolvedValue([
			"Pre-existing dirty state in nested repo `nested` could not be auto-restored after the agent commit; stash entry preserved (conflict).",
		]);
		const suffix = await applyEligibleNestedPatches({
			result: result({ nestedPatches: [nestedPatch] }),
			repoRoot: "/repo",
			mergeMode: "patch",
			changesApplied: true,
			mergedBranchForNestedPatches: false,
		});
		expect(suffix).toContain("could not be auto-restored");
		expect(suffix).toContain("stash entry preserved");
		expect(suffix).toContain("<system-notification>");
	});
});
