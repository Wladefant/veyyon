// WHY: A schema-valid record with a live pid is not proof that this process owns the terminal.
// If discovery follows a symlink or accepts broad permissions, a planted endpoint can claim rotation succeeded.
// This test drives the real rotation client and proves insecure records never reach their endpoint.
import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { terminalControlEndpoint } from "../src/launch/terminal-control";
import { rotateTerminalControl } from "../src/launch/terminal-control-client";

const roots: string[] = [];
const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const server of servers.splice(0)) {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test.each(["broad permissions", "symbolic link"] as const)("does not send rotation to a live-pid %s discovery record", async kind => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-discovery-refusal-"));
	roots.push(root);
	const directory = path.join(root, "run", "terminals");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);

	let connections = 0;
	const server = net.createServer(socket => {
		connections += 1;
		sockets.push(socket);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(buffer.slice(0, newline)) as { id: string };
			socket.end(JSON.stringify({ id: request.id, ok: true, result: { rotated: true } }) + "\n");
		});
	});
	servers.push(server);
	const endpoint = terminalControlEndpoint(root, "planted-record");
	server.listen(endpoint);
	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});

	const record = {
		version: 1,
		sessionId: "rot-session",
		pid: process.pid,
		cwd: root,
		sessionFile: path.join(root, "session.jsonl"),
		endpoint,
		token: "throwaway-token",
	};
	const recordPath = path.join(directory, "planted.json");
	if (kind === "broad permissions") {
		await fs.writeFile(recordPath, JSON.stringify(record), { mode: 0o644 });
		await fs.chmod(recordPath, 0o644);
	} else {
		const targetPath = path.join(root, "outside.json");
		await fs.writeFile(targetPath, JSON.stringify(record), { mode: 0o600 });
		await fs.symlink(targetPath, recordPath);
	}

	let rotationResolved = false;
	await rotateTerminalControl("rot-session", { root }).then(() => {
		rotationResolved = true;
	}, () => {});
	expect(rotationResolved).toBe(false);
	expect(connections).toBe(0);
});
