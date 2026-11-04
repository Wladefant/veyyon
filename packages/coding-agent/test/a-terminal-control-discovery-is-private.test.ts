import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { serveTerminalControl, type TerminalOwner } from "../src/launch/terminal-control";

test.skipIf(process.platform === "win32")("existing discovery directory becomes private before socket publication", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ipc-private-"));
	const directory = path.join(root, "run", "terminals");
	await fs.mkdir(directory, { recursive: true, mode: 0o755 });
	await fs.chmod(directory, 0o755);
	let close: (() => void) | undefined;
	try {
		close = await serveTerminalControl({
			identity: () => ({ sessionId: "private", cwd: root, sessionFile: path.join(root, "session.jsonl") }),
			deliver: async () => "started",
			abort: async () => false,
			history: () => [],
			subscribe: () => () => {},
		}, root);
		expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
		const file = (await fs.readdir(directory)).find(name => name.endsWith(".json"))!;
		expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
		const owner: TerminalOwner = JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
		expect((await fs.stat(owner.endpoint)).mode & 0o777).toBe(0o600);
	} finally {
		close?.();
		await fs.rm(root, { recursive: true, force: true });
	}
});
