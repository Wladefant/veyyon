import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir } from "@veyyon/utils";

/** Live terminal discovery is an ownership claim, never permission to open another writer. */
export async function assertNotTerminalOwned(sessionFile: string, root = getConfigRootDir()): Promise<void> {
	const directory = path.join(root, "run", "terminals");
	let files: string[];
	try { files = await fs.readdir(directory); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const resolved = path.resolve(sessionFile);
	const target = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		let owner: { version?: unknown; sessionFile?: unknown; pid?: unknown };
		try { owner = JSON.parse(await fs.readFile(path.join(directory, file), "utf8")); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw new Error("Cannot establish terminal writer ownership", { cause: error });
		}
		if (owner?.version !== 1 || typeof owner.sessionFile !== "string" || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) continue;
		const candidate = path.resolve(owner.sessionFile);
		if ((process.platform === "win32" ? candidate.toLowerCase() : candidate) !== target) continue;
		try { process.kill(owner.pid, 0); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
		}
		throw new Error("Session is owned by a live terminal; use its authenticated terminal control endpoint");
	}
}
