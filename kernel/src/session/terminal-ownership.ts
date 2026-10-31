import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { errorMessage, getConfigRootDir, logger, type OwnerOnlyReadOptions, readOwnerOnlyFiles } from "@veyyon/utils";

/** Windows recycles PIDs fast, so a live pid is not proof: the owner's pipe must answer. */
async function isEndpointServing(endpoint: string): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const socket = net.connect(endpoint);
		const finish = (serving: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(serving);
		};
		socket.setTimeout(1000, () => finish(true));
		socket.once("connect", () => finish(true));
		socket.once("error", error => {
			const code = (error as NodeJS.ErrnoException).code;
			finish(code !== "ENOENT" && code !== "ECONNREFUSED");
		});
	});
}

/** Live terminal discovery is an ownership claim, never permission to open another writer. */
export async function assertNotTerminalOwned(
	sessionFile: string,
	root = getConfigRootDir(),
	options: OwnerOnlyReadOptions = {},
): Promise<void> {
	const directory = path.join(root, "run", "terminals");
	let files: string[];
	try {
		files = await fs.readdir(directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const resolved = path.resolve(sessionFile);
	const target = process.platform === "win32" ? resolved.toLowerCase() : resolved;
	const recordPaths = files.filter(file => file.endsWith(".json")).map(file => path.join(directory, file));
	let records: string[];
	try {
		records = await readOwnerOnlyFiles(
			recordPaths,
			untrusted => {
				try {
					const claim: { sessionFile?: unknown } | null = JSON.parse(untrusted);
					if (typeof claim?.sessionFile !== "string") return true;
					const candidate = path.resolve(claim.sessionFile);
					return (process.platform === "win32" ? candidate.toLowerCase() : candidate) === target;
				} catch {
					return true;
				}
			},
			options,
		);
	} catch (error) {
		logger.warn("Cannot establish terminal writer ownership", { path: directory, reason: errorMessage(error) });
		throw new Error("Cannot establish terminal writer ownership", { cause: error });
	}
	for (const record of records) {
		let owner: { version?: unknown; sessionFile?: unknown; pid?: unknown; endpoint?: unknown };
		try {
			owner = JSON.parse(record);
		} catch (error) {
			logger.warn("Cannot establish terminal writer ownership", {
				path: directory,
				reason: "Invalid discovery JSON",
			});
			throw new Error("Cannot establish terminal writer ownership", { cause: error });
		}
		if (
			owner?.version !== 1 ||
			typeof owner.sessionFile !== "string" ||
			typeof owner.pid !== "number" ||
			!Number.isSafeInteger(owner.pid) ||
			owner.pid <= 0
		)
			continue;
		const candidate = path.resolve(owner.sessionFile);
		if ((process.platform === "win32" ? candidate.toLowerCase() : candidate) !== target) continue;
		try {
			process.kill(owner.pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
		}
		if (typeof owner.endpoint === "string" && !(await isEndpointServing(owner.endpoint))) continue;
		throw new Error("Session is owned by a live terminal; use its authenticated terminal control endpoint");
	}
}
