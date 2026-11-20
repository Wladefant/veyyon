import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
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

		await child.close();
		child = undefined;

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
