import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
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
	const file = path.join(dir.path(), "agent.jsonl");
	const otherFile = path.join(dir.path(), "other-agent.jsonl");
	const options = { initialCwd: dir.path(), exclusiveOwner: true };
	const openFromAnotherProcess = async (filePath: string) => {
		const { stdout } = await run(process.execPath, ["--eval", probe, filePath, dir.path()], { env, timeout: 5_000 });
		return stdout.trim();
	};
	let owner: SessionManager | undefined;
	try {
		owner = await SessionManager.open(file, undefined, undefined, options);
		await owner.ensureOnDisk();
		expect(await openFromAnotherProcess(file)).toContain("Failed to acquire lock");
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
