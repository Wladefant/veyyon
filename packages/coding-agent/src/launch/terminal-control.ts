import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { atomicWriteFile, getConfigRootDir, postmortem } from "@veyyon/utils";

/** Versioned, private discovery record. Only the owning terminal publishes this. */
export interface TerminalOwner {
	version: 1;
	sessionId: string;
	pid: number;
	cwd: string;
	sessionFile: string;
	endpoint: string;
	token: string;
}

export interface TerminalControlTarget {
	identity(): { sessionId: string; cwd: string; sessionFile: string };
	deliver(text: string, mode: "auto" | "steer" | "followUp"): Promise<string>;
	abort(): Promise<boolean>;
	history(): { entryId: string; text: string }[];
	subscribe(listener: (event: unknown) => void): () => void;
}

/** The socket lives in the CLI process; neither this module nor a client opens a session file. */
export async function serveTerminalControl(
	target: TerminalControlTarget,
	root = getConfigRootDir(),
): Promise<() => void> {
	const directory = path.join(root, "run", "terminals");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const nonce = crypto.randomUUID();
	const endpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\veyyon-terminal-${nonce}` : path.join(directory, `${nonce}.sock`);
	const token = crypto.randomBytes(32).toString("hex");
	const recordPath = path.join(directory, `${process.pid}-${nonce}.json`);
	const sockets = new Set<net.Socket>();
	const subscribers = new Set<net.Socket>();
	let closed = false;
	let publishedSessionId = target.identity().sessionId;
	const send = (socket: net.Socket, frame: unknown): void => {
		if (socket.destroyed) return;
		if (socket.writableLength > 1024 * 1024) {
			socket.destroy();
			return;
		}
		socket.write(`${JSON.stringify(frame)}\n`);
	};
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.setEncoding("utf8");
		let buffer = "";
		let queue = Promise.resolve();
		const authDeadline = setTimeout(() => socket.destroy(), 5_000);
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(authDeadline);
			sockets.delete(socket);
			subscribers.delete(socket);
		});
		socket.on("data", chunk => {
			buffer += chunk;
			if (Buffer.byteLength(buffer) > 1024 * 1024) {
				socket.destroy();
				return;
			}
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				queue = queue.then(async () => {
					let id: unknown;
					try {
						const request = JSON.parse(line);
						id = request?.id;
						if (typeof id !== "string" || request.version !== 1 || request.token !== token) {
							socket.destroy();
							return;
						}
						clearTimeout(authDeadline);
						if (
							closed ||
							request.sessionId !== publishedSessionId ||
							request.sessionId !== target.identity().sessionId
						) {
							throw new Error("Terminal session detached or changed; rediscover its owner");
						}
						let result: unknown;
						switch (request.op) {
							case "subscribe":
								subscribers.add(socket);
								send(socket, {
									event: { kind: "history", sessionId: publishedSessionId, entries: target.history() },
								});
								result = true;
								break;
							case "deliver":
								if (
									typeof request.text !== "string" ||
									!request.text.trim() ||
									!["auto", "steer", "followUp"].includes(request.mode)
								)
									throw new Error("Invalid delivery");
								result = await target.deliver(request.text, request.mode);
								break;
							case "abort":
								result = await target.abort();
								break;
							case "ping":
								result = { ...target.identity(), pid: process.pid };
								break;
							default:
								throw new Error("Unknown terminal operation");
						}
						send(socket, { id, ok: true, result });
					} catch (error) {
						send(socket, { id, ok: false, error: String(error) });
					}
				});
			}
		});
	});
	const ready = Promise.withResolvers<void>();
	server.once("error", ready.reject);
	server.listen(endpoint, ready.resolve);
	await ready.promise;
	if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
	const publish = async (): Promise<void> => {
		const identity = target.identity();
		const record: TerminalOwner = { version: 1, ...identity, pid: process.pid, endpoint, token };
		await atomicWriteFile(recordPath, JSON.stringify(record));
		if (closed) {
			await fs.rm(recordPath, { force: true });
			return;
		}
		publishedSessionId = identity.sessionId;
	};
	try {
		await publish();
	} catch (error) {
		server.close();
		throw error;
	}
	const unsubscribe = target.subscribe(event => {
		if (publishedSessionId !== target.identity().sessionId) {
			for (const socket of sockets) socket.destroy();
			return;
		}
		for (const socket of subscribers) send(socket, { event });
	});
	let refreshing = false;
	const refresh = setInterval(() => {
		if (closed || refreshing || publishedSessionId === target.identity().sessionId) return;
		refreshing = true;
		for (const socket of sockets) socket.destroy();
		void publish()
			.finally(() => {
				refreshing = false;
			})
			.catch(() => close());
	}, 250);
	refresh.unref();
	const close = (): void => {
		if (closed) return;
		closed = true;
		clearInterval(refresh);
		unsubscribe();
		cancelCleanup();
		for (const socket of sockets) socket.destroy();
		server.close();
		void fs.rm(recordPath, { force: true }).catch(() => {});
	};
	const cancelCleanup = postmortem.register(`terminal-control:${nonce}`, close);
	return close;
}
