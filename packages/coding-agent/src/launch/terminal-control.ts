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

/** Optional protocol features this build serves. A peer that lacks one never sees the field. */
export const TERMINAL_CAPABILITIES = ["deliver-ack"] as const;
/** The newest assistant entries a subscriber is told about; older ones were seen by any earlier subscriber. */
const HISTORY_FRAME_ENTRIES = 1000;
const MAX_REMEMBERED_DELIVERIES = 256;

type DeliveryState =
	| { state: "pending" }
	| { state: "delivered"; outcome: string }
	| { state: "failed"; error: string };

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
	let unsubscribe: (() => void) | undefined;
	let refresh: NodeJS.Timeout | undefined;
	let refreshing = false;
	// No timer stays armed while no client is connected: a resting terminal wakes for no one. The
	// owner poll runs only while a socket is open, the journal poll only while one is subscribed.
	const reconcile = (): void => {
		if (closed || refreshing || publishedSessionId === target.identity().sessionId) return;
		refreshing = true;
		for (const socket of sockets) socket.destroy();
		void publish()
			.finally(() => {
				refreshing = false;
			})
			.catch(() => close());
	};
	const armRefresh = (): void => {
		if (refresh || closed) return;
		refresh = setInterval(reconcile, 250);
		refresh.unref();
	};
	const disarmRefresh = (): void => {
		clearInterval(refresh);
		refresh = undefined;
	};
	const startEvents = (): void => {
		if (unsubscribe || closed) return;
		unsubscribe = target.subscribe(event => {
			if (publishedSessionId !== target.identity().sessionId) {
				for (const socket of sockets) socket.destroy();
				return;
			}
			for (const socket of subscribers) send(socket, { event });
		});
	};
	const stopEvents = (): void => {
		unsubscribe?.();
		unsubscribe = undefined;
	};
	const send = (socket: net.Socket, frame: unknown): void => {
		if (socket.destroyed) return;
		if (socket.writableLength > 1024 * 1024) {
			socket.destroy();
			return;
		}
		socket.write(`${JSON.stringify(frame)}\n`);
	};
	// Acked deliveries, by the daemon's message id. The table lets a retry after a lost connection
	// find the earlier request instead of enqueueing the message twice. Insertion order = age.
	const deliveries = new Map<string, { status: DeliveryState; watchers: Set<net.Socket> }>();
	// One chain: acked messages reach the terminal in the order they were accepted.
	let deliveryChain = Promise.resolve();
	const announceDelivery = (messageId: string, watchers: Iterable<net.Socket>, status: DeliveryState): void => {
		for (const socket of watchers) {
			send(socket, { event: { kind: "delivery", sessionId: publishedSessionId, messageId, ...status } });
		}
	};
	const acceptDelivery = (
		socket: net.Socket,
		messageId: string,
		text: string,
		mode: "auto" | "steer" | "followUp",
	): { accepted: true; messageId: string; state: DeliveryState["state"] } => {
		const known = deliveries.get(messageId);
		if (known) {
			if (known.status.state === "pending") known.watchers.add(socket);
			return { accepted: true, messageId, state: known.status.state };
		}
		const record = { status: { state: "pending" } as DeliveryState, watchers: new Set([socket]) };
		deliveries.set(messageId, record);
		for (const oldest of deliveries.keys()) {
			if (deliveries.size <= MAX_REMEMBERED_DELIVERIES) break;
			deliveries.delete(oldest);
		}
		deliveryChain = deliveryChain.then(async () => {
			try {
				record.status = { state: "delivered", outcome: await target.deliver(text, mode) };
			} catch (error) {
				record.status = { state: "failed", error: String(error) };
			}
			announceDelivery(messageId, record.watchers, record.status);
			record.watchers.clear();
		});
		return { accepted: true, messageId, state: "pending" };
	};
	const server = net.createServer(socket => {
		sockets.add(socket);
		armRefresh();
		socket.setEncoding("utf8");
		let buffer = "";
		let queue = Promise.resolve();
		const authDeadline = setTimeout(() => socket.destroy(), 5_000);
		socket.on("error", () => {});
		socket.on("close", () => {
			clearTimeout(authDeadline);
			sockets.delete(socket);
			subscribers.delete(socket);
			if (!sockets.size) disarmRefresh();
			if (!subscribers.size) stopEvents();
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
								startEvents();
								send(socket, {
									event: {
										kind: "history",
										sessionId: publishedSessionId,
										entries: target.history().slice(-HISTORY_FRAME_ENTRIES),
									},
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
								if (request.ack === true) {
									// The terminal may be blocked for seconds. Accept now, deliver on the chain.
									if (
										typeof request.messageId !== "string" ||
										!request.messageId ||
										request.messageId.length > 128
									)
										throw new Error("Invalid delivery");
									result = acceptDelivery(socket, request.messageId, request.text, request.mode);
									break;
								}
								result = await target.deliver(request.text, request.mode);
								break;
							case "deliveryStatus": {
								const known = typeof request.messageId === "string" ? deliveries.get(request.messageId) : undefined;
								result = known ? known.status : { state: "unknown" };
								break;
							}
							case "abort":
								result = await target.abort();
								break;
							case "ping":
								result = { ...target.identity(), pid: process.pid, capabilities: TERMINAL_CAPABILITIES };
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
	const close = (): void => {
		if (closed) return;
		closed = true;
		disarmRefresh();
		stopEvents();
		cancelCleanup();
		for (const socket of sockets) socket.destroy();
		server.close();
		void fs.rm(recordPath, { force: true }).catch(() => {});
	};
	const cancelCleanup = postmortem.register(`terminal-control:${nonce}`, close);
	return close;
}
