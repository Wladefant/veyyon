import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { getConfigRootDir, getWindowsAclTimeoutMs, readOwnerOnlyFile } from "@veyyon/utils";

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

/** Recover only claims whose publisher identity independently proves there is no writer. */
async function isAbsentPublisher(file: string, directory: string): Promise<boolean> {
	const publisher = /^([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/.exec(
		file,
	);
	if (!publisher) return false;
	const pid = Number(publisher[1]);
	if (!Number.isSafeInteger(pid)) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
	}
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\veyyon-terminal-${publisher[2]}`
			: path.join(directory, `${publisher[2]}.sock`);
	try {
		return !(await isEndpointServing(endpoint));
	} catch {
		return false;
	}
}

/** Live terminal discovery is an ownership claim, never permission to open another writer. */
export async function assertNotTerminalOwned(sessionFile: string, root = getConfigRootDir()): Promise<void> {
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
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		let owner: { version?: unknown; sessionFile?: unknown; pid?: unknown; endpoint?: unknown };
		const record = path.join(directory, file);
		const started = performance.now();
		let step = "open";
		// Unreadable claims remain fail-closed unless the publisher PID or endpoint proves absence.
		try {
			const contents = await readOwnerOnlyFile(record, {
				onStep: current => {
					step = current;
				},
			});
			step = "parse";
			owner = JSON.parse(contents);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			if (await isAbsentPublisher(file, directory)) continue;
			const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : "unknown");
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Cannot establish terminal writer ownership: ${record}; step=${step}; code=${code}; elapsed=${Math.round(performance.now() - started)}ms; ACL deadline=${getWindowsAclTimeoutMs()}ms per command; ${detail}`,
				{ cause: error },
			);
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
