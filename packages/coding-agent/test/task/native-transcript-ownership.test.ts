import { expect, it, spyOn, test, vi } from "bun:test";
import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir, withFileLock } from "@veyyon/utils";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const run = promisify(execFile);
const sessionManagerUrl = new URL("../../../../kernel/src/session/session-manager.ts", import.meta.url);
const probe = `
	import { SessionManager } from ${JSON.stringify(sessionManagerUrl.href)};
	const [file, cwd] = process.argv.slice(1);
	try {
		const session = await SessionManager.open(file, undefined, undefined, { initialCwd: cwd, exclusiveOwner: true });
		await session.close();
		console.log("opened");
	} catch (error) {
		console.log(error.message);
	}
`;

interface ResolutionWatch {
	reached: Promise<void>;
	restore(): void;
}

function watchTranscriptResolution(files: readonly string[]): ResolutionWatch {
	const remaining = [...files];
	let pending = remaining.length;
	const reached = Promise.withResolvers<void>();
	const realpath = fsPromises.realpath;
	const observe = (...args: Parameters<typeof realpath>) => {
		const resolved = realpath(...args);
		const index = remaining.indexOf(String(args[0]));
		if (index >= 0) {
			remaining.splice(index, 1);
			void resolved.then(() => {
				if (--pending === 0) reached.resolve();
			}, reached.reject);
		}
		return resolved;
	};
	// The wrapper forwards the arguments and returns the original promise for every overload.
	const spy = spyOn(fsPromises, "realpath").mockImplementation(observe as typeof realpath);
	return { reached: reached.promise, restore: () => spy.mockRestore() };
}

it("rejects a second owner of the same native transcript without blocking an unrelated transcript", async () => {
	const dir = TempDir.createSync("native-transcript-ownership-");
	const { env, cleanup } = hermeticSpawnEnv();
	const alias = path.join(dir.path(), "alias");
	const actual = path.join(dir.path(), "actual");
	const file = path.join(alias, "agent.jsonl");
	const otherFile = path.join(dir.path(), "other-agent.jsonl");
	const options = { initialCwd: dir.path(), exclusiveOwner: true };
	const openFromAnotherProcess = async (filePath: string) => {
		const { stdout } = await run(process.execPath, ["--eval", probe, filePath, dir.path()], { env, timeout: 5_000 });
		return stdout.trim();
	};
	let owner: SessionManager | undefined;
	try {
		await fs.mkdir(actual);
		await fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
		owner = await SessionManager.open(file, undefined, undefined, options);
		await owner.ensureOnDisk();
		expect(await openFromAnotherProcess(file)).toContain("Failed to acquire lock");
		expect(await openFromAnotherProcess(path.join(actual, "agent.jsonl"))).toContain("Failed to acquire lock");
		expect(await openFromAnotherProcess(otherFile)).toBe("opened");
		await owner.close();
		owner = undefined;
		expect(await openFromAnotherProcess(file)).toBe("opened");
	} finally {
		await owner?.close();
		cleanup();
		dir.removeSync();
	}
}, 20_000);

it("refuses to move a root session directory while a child native transcript has an active owner", async () => {
	const dir = TempDir.createSync("native-transcript-move-");
	const { env, cleanup } = hermeticSpawnEnv();
	const cwdA = path.join(dir.path(), "cwd-a");
	const cwdB = path.join(dir.path(), "cwd-b");
	const sessionDirA = path.join(dir.path(), "sessions-a");
	const sessionDirB = path.join(dir.path(), "sessions-b");
	const openFromAnotherProcess = async (filePath: string, cwd: string) => {
		const { stdout } = await run(process.execPath, ["--eval", probe, filePath, cwd], { env, timeout: 5_000 });
		return stdout.trim();
	};
	let root: SessionManager | undefined;
	let child: SessionManager | undefined;
	try {
		await fs.mkdir(cwdA, { recursive: true });
		await fs.mkdir(cwdB, { recursive: true });
		root = SessionManager.create(cwdA, sessionDirA);
		await root.ensureOnDisk();
		const rootSessionFile = root.getSessionFile();
		const rootArtifactsDir = root.getArtifactsDir();
		expect(rootSessionFile).toBeDefined();
		expect(rootArtifactsDir).not.toBeNull();
		await fs.mkdir(rootArtifactsDir!, { recursive: true });

		const childFile = path.join(rootArtifactsDir!, "agent.jsonl");
		child = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: cwdA,
			suppressBreadcrumb: true,
			exclusiveOwner: true,
		});
		await child.ensureOnDisk();

		const movedJournal = path.join(sessionDirB, path.basename(rootSessionFile!));
		const movedArtifactsDir = path.join(sessionDirB, path.basename(rootArtifactsDir!));
		const movedChildFile = path.join(movedArtifactsDir, "agent.jsonl");

		await expect(root.moveTo(cwdB, sessionDirB)).rejects.toThrow(/active native transcript/);
		expect(root.getSessionFile()).toBe(rootSessionFile);
		expect(root.getArtifactsDir()).toBe(rootArtifactsDir);
		expect(root.getCwd()).toBe(cwdA);
		await expect(fs.stat(rootSessionFile!)).resolves.toBeDefined();
		await expect(fs.stat(childFile)).resolves.toBeDefined();
		await expect(fs.stat(movedJournal)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(movedArtifactsDir)).rejects.toMatchObject({ code: "ENOENT" });

		const relocationGate = `${await fs.realpath(rootArtifactsDir!)}.native-relocation`;
		const activeChild = child;
		child = undefined;
		await withFileLock(relocationGate, () => activeChild.close());

		await root.moveTo(cwdB, sessionDirB);
		expect(root.getSessionFile()).toBe(movedJournal);
		expect(root.getArtifactsDir()).toBe(movedArtifactsDir);
		expect(root.getCwd()).toBe(cwdB);
		await expect(fs.stat(movedJournal)).resolves.toBeDefined();
		await expect(fs.stat(movedChildFile)).resolves.toBeDefined();
		await expect(fs.stat(rootSessionFile!)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(rootArtifactsDir!)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await openFromAnotherProcess(movedChildFile, cwdB)).toBe("opened");
	} finally {
		await child?.close();
		await root?.close();
		cleanup();
		dir.removeSync();
	}
}, 20_000);

test.each([6, 14])(
	"opens %i siblings across a slow relocation gate and rejects only the duplicate",
	async count => {
		const dir = TempDir.createSync("native-transcript-coalesce-");
		const cwd = path.join(dir.path(), "cwd");
		const artifactsDir = path.join(dir.path(), "artifacts");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(artifactsDir, { recursive: true });
		const canonicalDir = await fs.realpath(artifactsDir);
		const gateLockPath = `${canonicalDir}.native-relocation.lock`;
		const transcriptFiles = Array.from({ length: count }, (_, index) =>
			path.join(canonicalDir, `child-${index}.jsonl`),
		);
		const burstFiles = [...transcriptFiles, transcriptFiles[0]!];
		await Promise.all(transcriptFiles.map(file => fs.writeFile(file, "")));
		const resolution = watchTranscriptResolution(burstFiles);

		const originalRename = fs.rename;
		let gatePublishCount = 0;
		const gateArrived = Promise.withResolvers<void>();
		const gateRelease = Promise.withResolvers<void>();
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
			if (String(destination) === gateLockPath) {
				gatePublishCount += 1;
				if (gatePublishCount === 1) {
					gateArrived.resolve();
					await gateRelease.promise;
				}
			}
			return originalRename(source, destination);
		});

		let openBurstPromise: Promise<PromiseSettledResult<SessionManager>[]> | undefined;
		try {
			vi.useFakeTimers();
			openBurstPromise = Promise.allSettled(
				burstFiles.map(file =>
					SessionManager.open(file, undefined, undefined, {
						initialCwd: cwd,
						suppressBreadcrumb: true,
						exclusiveOwner: true,
					}),
				),
			);

			await Promise.race([
				Promise.all([gateArrived.promise, resolution.reached]),
				openBurstPromise.then(() => {
					throw new Error("Native opens finished without reaching the relocation gate");
				}),
			]);
			// Drain the continuations of the realpath calls before firing queued watchdogs.
			await fs.stat(canonicalDir);
			vi.advanceTimersByTime(5_250);
			vi.useRealTimers();
			gateRelease.resolve();

			const settled = await openBurstPromise;
			const managers = settled.flatMap(result => (result.status === "fulfilled" ? [result.value] : []));

			expect(
				settled.slice(1, count).flatMap(result => (result.status === "rejected" ? [String(result.reason)] : [])),
			).toEqual([]);

			const duplicateResults = [settled[0]!, settled[count]!];
			const duplicateFulfilled = duplicateResults.filter(
				(result): result is PromiseFulfilledResult<SessionManager> => result.status === "fulfilled",
			);
			const duplicateRejected = duplicateResults.filter(
				(result): result is PromiseRejectedResult => result.status === "rejected",
			);
			expect(duplicateFulfilled).toHaveLength(1);
			expect(duplicateRejected).toHaveLength(1);
			expect(String(duplicateRejected[0]!.reason)).toContain("Failed to acquire lock");

			expect(managers).toHaveLength(count);
			expect(gatePublishCount).toBe(1);

			await Promise.all(managers.map(manager => manager.ensureOnDisk()));
			expect(managers.map(manager => manager.getSessionFile()).sort()).toEqual(transcriptFiles.toSorted());
			const owners = await fs.readdir(`${canonicalDir}.native-owners`);
			expect(owners.sort()).toEqual(transcriptFiles.map(file => `${path.basename(file)}.lock`).sort());
			for (const file of transcriptFiles) {
				expect(await fs.readFile(file, "utf8")).toContain('"type":"session"');
			}
		} finally {
			vi.useRealTimers();
			resolution.restore();
			gateRelease.resolve();
			renameSpy.mockRestore();
			const settled = (await openBurstPromise) ?? [];
			await Promise.allSettled(
				settled.flatMap(result => (result.status === "fulfilled" ? [result.value.close()] : [])),
			);
			dir.removeSync();
		}
	},
	20_000,
);

it("keeps native owner publication behind both relocation gates through the move", async () => {
	const dir = TempDir.createSync("native-transcript-move-gate-");
	const cwdA = path.join(dir.path(), "cwd-a");
	const cwdB = path.join(dir.path(), "cwd-b");
	const sessionDirA = path.join(dir.path(), "sessions-a");
	const sessionDirB = path.join(dir.path(), "sessions-b");
	const movePaused = Promise.withResolvers<void>();
	const moveRelease = Promise.withResolvers<void>();
	const storage = new FileSessionStorage();
	const moveStorage = storage.moveSessionWithArtifacts.bind(storage);
	storage.moveSessionWithArtifacts = async (from, to) => {
		await moveStorage(from, to);
		movePaused.resolve();
		await moveRelease.promise;
	};

	let root: SessionManager | undefined;
	let move: Promise<void> | undefined;
	const opens: Promise<SessionManager>[] = [];
	const managers: SessionManager[] = [];
	let resolution: ResolutionWatch | undefined;
	try {
		await fs.mkdir(cwdA);
		await fs.mkdir(cwdB);
		root = SessionManager.create(cwdA, sessionDirA, storage);
		await root.ensureOnDisk();
		const source = root.getArtifactsDir()!;
		const target = path.join(sessionDirB, path.basename(source));
		await fs.mkdir(source, { recursive: true });
		await fs.writeFile(path.join(source, "artifact.txt"), "kept");
		move = root.moveTo(cwdB, sessionDirB);
		await Promise.race([
			movePaused.promise,
			move.then(() => {
				throw new Error("Move finished without entering the storage barrier");
			}),
		]);

		const files = [path.join(source, "child.jsonl"), path.join(target, "child.jsonl")];
		await fs.mkdir(source, { recursive: true });
		await Promise.all(files.map(file => fs.writeFile(file, "")));
		resolution = watchTranscriptResolution(files);
		for (const file of files) {
			const open = SessionManager.open(file, undefined, undefined, {
				initialCwd: cwdA,
				suppressBreadcrumb: true,
				exclusiveOwner: true,
			}).then(manager => {
				managers.push(manager);
				return manager;
			});
			opens.push(open);
		}
		const opened = Promise.all(opens);
		await Promise.race([resolution.reached, opened]);
		expect(managers).toHaveLength(0);
		const canonicalRoot = await fs.realpath(dir.path());
		for (const directory of [source, target]) {
			const canonicalDirectory = path.join(canonicalRoot, path.relative(dir.path(), directory));
			await expect(fs.readdir(`${canonicalDirectory}.native-owners`)).rejects.toMatchObject({ code: "ENOENT" });
		}

		moveRelease.resolve();
		await move;
		expect(await opened).toHaveLength(2);
		expect(await fs.readFile(path.join(target, "artifact.txt"), "utf8")).toBe("kept");
		const journal = await fs.readFile(root.getSessionFile()!, "utf8");
		const header = journal
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line))
			.find(entry => entry.type === "session");
		expect(header).toMatchObject({ cwd: cwdB });
	} finally {
		resolution?.restore();
		moveRelease.resolve();
		await Promise.allSettled([move, ...opens]);
		await Promise.allSettled([...managers.map(manager => manager.close()), root?.close()]);
		dir.removeSync();
	}
}, 20_000);
