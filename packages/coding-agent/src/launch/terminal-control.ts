import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	applyOwnerOnlyWindowsAcl,
	atomicWriteFileWith,
	getConfigRootDir,
	isCompiledBinary,
	isRecord,
	logTelegramDeliveryTrace,
	normalizeDeliveryOutcome,
	parseTelegramTrace,
	postmortem,
	type TelegramDeliveryTraceData,
} from "@veyyon/utils";
import type { SecretRequestMetadata, SecretSubmission } from "../secrets/intake-wire";
import { getLoadedBuildIdentity } from "./build-info";
import { createTerminalControlTransport, type TerminalSocket } from "./terminal-control-transport";
import { TerminalReceipts } from "./terminal-receipts";
import {
	MAX_REGISTRY_SNAPSHOT_TEXT,
	REGISTRY_SNAPSHOT_CAPABILITY,
	type RegistrySnapshotObservation,
} from "./terminal-registry-snapshot";

/** Versioned, private discovery record. Only the owning terminal publishes this. */
export interface TerminalOwner {
	version: 1;
	sessionId: string;
	pid: number;
	cwd: string;
	sessionFile: string;
	endpoint: string;
	token: string;
	loadedVersion: string;
	loadedBuildSha: string | null;
	capabilities: readonly string[];
	/** Required by registrySnapshot. Changes when this owner switches sessions or rotates its credential. */
	ownerGeneration?: string;
}

export interface TerminalDeliveryOptions {
	telegramTrace?: TelegramDeliveryTraceData;
}

export interface TerminalControlTarget {
	identity(): { sessionId: string; cwd: string; sessionFile: string };
	deliver(text: string, mode: "auto" | "steer" | "followUp", options?: TerminalDeliveryOptions): Promise<string>;
	recordSteering?(
		sessionId: string,
		messageId: string,
		text: string,
		mode: "auto" | "steer" | "followUp",
		options?: TerminalDeliveryOptions,
	): Promise<boolean>;
	abort(): Promise<boolean>;
	isIdle?(): boolean;
	reserveExit?(): void;
	shutdown?(): Promise<void>;
	history(): { entryId: string; text: string }[];
	subscribe(listener: (event: unknown) => void): () => void;
	registrySnapshot?(sessionId: string): RegistrySnapshotObservation | undefined;
	registerSecretIntake?(registration: TerminalSecretRegistration): Promise<TerminalSecretActorContext>;
	secretIntakeContext?(): TerminalSecretActorContext | undefined;
	secretRequest?(request: TerminalSecretRequest): Promise<SecretRequestMetadata>;
}

export type TerminalSecretActorContext = {
	actorId: string;
	ownerSessionId: string;
	projectId: string;
};

export type TerminalSecretRegistration = {
	version: 1;
	actorId: string;
	ownerSessionId: string;
	transport: "telegram" | "local";
};

export type TerminalSecretRequest =
	| { action: "get" | "decline" | "cancel"; requestId: string; context: TerminalSecretActorContext }
	| { action: "submit"; requestId: string; submission: SecretSubmission; context: TerminalSecretActorContext };

export interface TerminalControlOptions {
	writeOwner?: (recordPath: string, record: TerminalOwner) => Promise<void>;
}

export interface TerminalControlHandle {
	(): void;
	refreshIdentity(): Promise<void> | undefined;
}

/** Optional protocol features this build serves. A peer that lacks one never sees the field. */
export const TERMINAL_CAPABILITIES = [
	"deliver-ack",
	"delivery-readback",
	"session-notices",
	"rotate",
	"idle-exit",
	REGISTRY_SNAPSHOT_CAPABILITY,
] as const;
/** The newest assistant entries a subscriber is told about; older ones were seen by any earlier subscriber. */
const HISTORY_FRAME_ENTRIES = 1000;
const MAX_REMEMBERED_DELIVERIES = 256;
/** Deliveries accepted and not yet settled. Beyond this the terminal answers `busy`: each holds its text. */
const MAX_PENDING_DELIVERIES = 64;
const DURABLE_DELIVERY_ID = /^telegram-[a-f0-9]{64}$/;
const DURABLE_DELIVERY_TAG = /^\[telegram-delivery id=(telegram-[a-f0-9]{64})\]$/;
const NOT_READY_RETRIES = 20;
const NOT_READY_RETRY_MS = 100;
/** A history replay waits while the socket holds more than this unsent, so one slow reader never reaches the 1 MiB send limit. */
const REPLAY_HIGH_WATER_BYTES = 256 * 1024;
const REPLAY_DRAIN_POLL_MS = 5;
/** A reader that drains nothing for this long is dropped rather than held open. */
const REPLAY_STALL_TIMEOUT_MS = 30_000;
const HISTORY_FRAME_MAX_BYTES = 512 * 1024;
const HISTORY_FRAME_MAX_ENTRIES = 100;

/**
 * The terminal has no input slot free right now, for example because the previous message reserved it
 * and its turn has not started streaming. A delivery on the chain retries this briefly.
 */
export class TerminalNotReadyError extends Error {}
class TerminalSessionChangedError extends Error {}

type DeliveryState =
	| { state: "pending" }
	| { state: "delivered"; outcome: string; consumed?: true }
	| { state: "failed"; error: string };

interface DeliveryRecord {
	sessionId: string;
	messageId: string;
	status: DeliveryState;
	watchers: Set<TerminalSocket>;
	promise: Promise<string>;
	accepted?: Promise<void>;
}

export function durableTerminalDeliveryId(text: string): string | undefined {
	return DURABLE_DELIVERY_TAG.exec(text.slice(text.lastIndexOf("\n") + 1))?.[1];
}

/** The daemon writes this tag on the final line of each durable input. Use the same journal receipt rule. */
function durableReceipt(line: Buffer): string | undefined {
	if (!line.includes("[telegram-delivery id=")) return;
	let entry: unknown;
	try {
		entry = JSON.parse(line.toString("utf8"));
	} catch {
		return;
	}
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return;
	const { role, synthetic, attribution, content } = entry.message;
	if (role !== "user" || synthetic || attribution === "agent") return;
	const body = Array.isArray(content)
		? content.find(block => isRecord(block) && block.type === "text")?.text
		: content;
	if (typeof body === "string") return durableTerminalDeliveryId(body);
}

class DurableDeliveryReadback {
	readonly consumed = new Set<string>();
	// Terminal dispatch can finish before the journal append. Do not evict that ID with the recent RPC cache.
	readonly dispatched = new Map<string, string>();
	#cursor = 0;
	#incarnation = "";
	#scan?: { filename: string; promise: Promise<void> };

	async refresh(filename: string): Promise<void> {
		while (this.#scan) {
			const scan = this.#scan;
			await scan.promise;
			if (scan.filename === filename) return;
		}
		const promise = this.#read(filename).finally(() => {
			this.#scan = undefined;
		});
		this.#scan = { filename, promise };
		await promise;
	}

	async #read(filename: string): Promise<void> {
		let handle: fs.FileHandle | undefined;
		try {
			if (filename) handle = await fs.open(filename, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!handle) {
			this.#incarnation = "";
			this.#cursor = 0;
			this.consumed.clear();
			return;
		}
		try {
			const stat = await handle.stat();
			const incarnation = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
			if (incarnation !== this.#incarnation || stat.size < this.#cursor) {
				this.#incarnation = incarnation;
				this.#cursor = 0;
				this.consumed.clear();
			}
			if (this.#cursor === stat.size) return;
			const fragments: Buffer[] = [];
			// Read a fixed snapshot; a partial final record is retried from the last newline.
			for (let offset = this.#cursor; offset < stat.size; ) {
				const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - offset));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
				const chunk = buffer.subarray(0, bytesRead);
				let start = 0;
				for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
					let line = chunk.subarray(start, end);
					if (fragments.length) {
						fragments.push(line);
						line = Buffer.concat(fragments);
						fragments.length = 0;
					}
					const id = durableReceipt(line);
					if (id) {
						this.consumed.add(id);
						this.dispatched.delete(id);
					}
					this.#cursor += line.length + 1;
					start = end + 1;
				}
				if (start < chunk.length) fragments.push(chunk.subarray(start));
			}
		} finally {
			await handle.close();
		}
	}
}

// V1 clients still recognize "delivered". The extra flag means the journal, not the IPC chain, confirmed it.
const CONSUMED_DELIVERY = { state: "delivered", outcome: "duplicate", consumed: true } as const;

interface StreamingSnapshotEvent {
	kind: "streaming";
	sessionId: string;
	active: boolean;
}

interface HistoryEntry {
	entryId: string;
	text: string;
}

interface AppendedEvent {
	kind: "appended";
	sessionId: string;
	entries: HistoryEntry[];
}

function isAppendedEvent(event: unknown): event is AppendedEvent {
	return (
		typeof event === "object" &&
		event !== null &&
		"kind" in event &&
		event.kind === "appended" &&
		"entries" in event &&
		Array.isArray(event.entries)
	);
}

function isStreamingSnapshotEvent(event: unknown): event is StreamingSnapshotEvent {
	return (
		typeof event === "object" &&
		event !== null &&
		"kind" in event &&
		event.kind === "streaming" &&
		"sessionId" in event &&
		typeof event.sessionId === "string" &&
		"active" in event &&
		typeof event.active === "boolean"
	);
}

/** Return the platform-specific endpoint used by terminal-control servers. */
export function terminalControlEndpoint(directory: string, nonce: string, platform = process.platform): string {
	return platform === "win32" ? `\\\\.\\pipe\\veyyon-terminal-${nonce}` : path.join(directory, `${nonce}.sock`);
}

/** The socket lives in the owning CLI process. It reads durable receipts but never writes the journal. */
export async function serveTerminalControl(
	target: TerminalControlTarget,
	root = getConfigRootDir(),
	options: TerminalControlOptions = {},
): Promise<TerminalControlHandle> {
	const startupArgv = isCompiledBinary()
		? [process.execPath, ...process.argv.slice(2)]
		: [process.execPath, ...process.argv.slice(1)];
	const secretIntakeContext = (): TerminalSecretActorContext | undefined =>
		target.secretRequest ? target.secretIntakeContext?.() : undefined;
	const secretIntakeCapability = () => {
		const context = secretIntakeContext();
		return context ? { version: 1 as const, sealed: true as const, context } : undefined;
	};
	const capabilities = (): readonly string[] => {
		const available = TERMINAL_CAPABILITIES.filter(
			capability =>
				(capability !== "idle-exit" || Boolean(target.isIdle && target.reserveExit && target.shutdown)) &&
				(capability !== REGISTRY_SNAPSHOT_CAPABILITY || Boolean(target.registrySnapshot)),
		);
		return secretIntakeContext() ? [...available, "secret-intake"] : available;
	};
	const directory = path.join(root, "run", "terminals");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	if (process.platform === "win32") await applyOwnerOnlyWindowsAcl(directory);
	else await fs.chmod(directory, 0o700);
	const nonce = crypto.randomUUID();
	const endpoint = terminalControlEndpoint(directory, nonce);
	let token = crypto.randomBytes(32).toString("hex");
	const recordPath = path.join(directory, `${process.pid}-${nonce}.json`);
	const sockets = new Set<TerminalSocket>();
	const subscribers = new Set<TerminalSocket>();
	let closed = false;
	let publishedSessionId = target.identity().sessionId;
	let ownerGeneration = nonce;
	let unsubscribe: (() => void) | undefined;
	let refresh: NodeJS.Timeout | undefined;
	let refreshing = false;
	let publication: Promise<void> = Promise.resolve();
	// No timer stays armed while no client is connected: a resting terminal wakes for no one. The
	// owner poll runs only while a socket is open, the journal poll only while one is subscribed.
	const reconcile = (): Promise<void> | undefined => {
		if (closed || refreshing || publishedSessionId === target.identity().sessionId) return;
		refreshing = true;
		for (const socket of sockets) socket.destroy();
		let attemptedSessionId: string | undefined;
		return publish({ onAttempt: sessionId => (attemptedSessionId = sessionId) }).then(
			() => {
				refreshing = false;
				return reconcile();
			},
			() => {
				// Keep listening. Publish a newer session, but do not retry the failed one here.
				refreshing = false;
				if (!closed && attemptedSessionId !== undefined && attemptedSessionId !== target.identity().sessionId) {
					return reconcile();
				}
			},
		);
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
	let currentStreamingEvent: StreamingSnapshotEvent | undefined;
	const startEvents = (): void => {
		if (unsubscribe || closed) return;
		unsubscribe = target.subscribe(event => {
			if (publishedSessionId !== target.identity().sessionId) {
				for (const socket of sockets) socket.destroy();
				return;
			}
			if (isStreamingSnapshotEvent(event)) {
				currentStreamingEvent = event;
			}
			for (const socket of subscribers) forward(socket, event);
		});
	};
	const stopEvents = (): void => {
		unsubscribe?.();
		unsubscribe = undefined;
		currentStreamingEvent = undefined;
	};
	const send = (socket: TerminalSocket, frame: unknown): void => {
		if (socket.destroyed) return;
		if (socket.writableLength > 1024 * 1024) {
			socket.destroy();
			return;
		}
		socket.write(`${JSON.stringify(frame)}\n`);
	};
	// Watcher, live and replay sends share one bounded receipt ledger per socket.
	const receipts = new WeakMap<TerminalSocket, TerminalReceipts>();
	const receiptFor = (socket: TerminalSocket): TerminalReceipts => {
		let receipt = receipts.get(socket);
		if (!receipt) {
			receipt = new TerminalReceipts();
			receipts.set(socket, receipt);
		}
		return receipt;
	};
	const forward = (socket: TerminalSocket, event: unknown): void => {
		if (!isAppendedEvent(event)) {
			send(socket, { event });
			return;
		}
		const receipt = receiptFor(socket);
		receipt.retainHistory(target.history().map(entry => entry.entryId));
		const entries = event.entries.filter(entry => !receipt.history.has(entry.entryId));
		if (!entries.length) return;
		for (const entry of entries) receipt.holdHistory(entry.entryId);
		send(socket, { event: { ...event, entries } });
	};
	// Waits on the bytes the socket still holds, because the Windows pipe socket never reports a full buffer.
	const waitForWritable = async (socket: TerminalSocket): Promise<void> => {
		const deadline = Date.now() + REPLAY_STALL_TIMEOUT_MS;
		while (!socket.destroyed && socket.writableLength > REPLAY_HIGH_WATER_BYTES) {
			if (Date.now() > deadline) {
				socket.destroy();
				return;
			}
			await sleep(REPLAY_DRAIN_POLL_MS);
		}
	};
	const chunkHistory = (entries: HistoryEntry[]): HistoryEntry[][] => {
		const chunks: HistoryEntry[][] = [];
		let chunk: HistoryEntry[] = [];
		let chunkBytes = 0;
		for (const entry of entries) {
			const bytes = Buffer.byteLength(JSON.stringify(entry));
			if (bytes > HISTORY_FRAME_MAX_BYTES) {
				throw new Error(`History entry ${entry.entryId} exceeds ${HISTORY_FRAME_MAX_BYTES} byte frame limit`);
			}
			if (
				chunk.length &&
				(chunk.length >= HISTORY_FRAME_MAX_ENTRIES || chunkBytes + bytes > HISTORY_FRAME_MAX_BYTES)
			) {
				chunks.push(chunk);
				chunk = [];
				chunkBytes = 0;
			}
			chunk.push(entry);
			chunkBytes += bytes;
		}
		if (chunk.length) chunks.push(chunk);
		return chunks;
	};
	// Admissions are scoped to the session that accepted them. An ack is not a journal write:
	// a disconnected caller can retry the same ID, but only journal readback proves consumption.
	const deliveryKey = (sessionId: string, messageId: string): string => `${sessionId}\0${messageId}`;
	const deliveries = new Map<string, DeliveryRecord>();
	let readback: DurableDeliveryReadback | undefined;
	const refreshReadback = async (sessionId: string): Promise<DurableDeliveryReadback> => {
		const identity = target.identity();
		if (closed || sessionId !== publishedSessionId || sessionId !== identity.sessionId) {
			throw new TerminalSessionChangedError("Terminal session detached or changed; rediscover its owner");
		}
		readback ??= new DurableDeliveryReadback();
		const index = readback;
		try {
			await index.refresh(identity.sessionFile);
		} catch (cause) {
			throw new TerminalNotReadyError("Terminal delivery journal is not readable; retry later", { cause });
		}
		const current = target.identity();
		if (
			closed ||
			sessionId !== publishedSessionId ||
			sessionId !== current.sessionId ||
			identity.sessionFile !== current.sessionFile ||
			index !== readback
		) {
			throw new TerminalSessionChangedError("Terminal session detached or changed; rediscover its owner");
		}
		return index;
	};
	const deliveryStatus = (
		messageId: string,
		index: DurableDeliveryReadback | undefined,
		known: DeliveryRecord | undefined,
	): DeliveryState | undefined => {
		if (index?.consumed.has(messageId)) return CONSUMED_DELIVERY;
		if (known) return known.status;
		const outcome = index?.dispatched.get(messageId);
		if (outcome !== undefined) return { state: "delivered", outcome };
	};
	const evictOldDeliveries = (): void => {
		for (const [oldestId, oldest] of deliveries) {
			if (deliveries.size <= MAX_REMEMBERED_DELIVERIES) break;
			if (oldest.status.state !== "pending") deliveries.delete(oldestId);
		}
	};
	// One chain for acked and plain deliveries: messages reach the terminal in the order they were accepted.
	let deliveryChain: Promise<void> = Promise.resolve();
	let pendingDeliveries = 0;
	let exitReserved = false;
	const sendDelivery = (
		socket: TerminalSocket,
		record: { sessionId: string; messageId: string; status: DeliveryState },
	): void => {
		if (
			socket.destroyed ||
			!receiptFor(socket).holdDelivery(deliveryKey(record.sessionId, record.messageId), record.status)
		)
			return;
		send(socket, {
			event: { kind: "delivery", sessionId: record.sessionId, messageId: record.messageId, ...record.status },
		});
	};
	const announceDelivery = (record: DeliveryRecord): void => {
		for (const socket of record.watchers) {
			sendDelivery(socket, record);
		}
		if (record.sessionId === publishedSessionId) {
			for (const socket of subscribers) {
				if (!record.watchers.has(socket)) {
					sendDelivery(socket, record);
				}
			}
		}
	};
	const runDelivery = (
		sessionId: string,
		text: string,
		mode: "auto" | "steer" | "followUp",
		deliveryOptions?: TerminalDeliveryOptions,
		durableId?: string,
		acceptance?: PromiseWithResolvers<void>,
	): Promise<string> => {
		if (exitReserved) throw new Error("Terminal is exiting; delivery refused");
		if (pendingDeliveries >= MAX_PENDING_DELIVERIES)
			throw new Error("Terminal busy: too many deliveries pending; retry later");
		const trace = deliveryOptions?.telegramTrace;
		if (trace && !acceptance) logTelegramDeliveryTrace(trace, { stage: "session_acceptance", sessionId });
		pendingDeliveries++;
		const run = deliveryChain.then(async () => {
			// Reserve the slot before any disk read. Cold readback must not create an unbounded second queue.
			if (durableId && (await refreshReadback(sessionId)).consumed.has(durableId)) {
				acceptance?.resolve();
				return CONSUMED_DELIVERY.outcome;
			}
			if (closed || sessionId !== target.identity().sessionId) {
				throw new TerminalSessionChangedError("Terminal session detached or changed; message not delivered");
			}
			const duplicate =
				acceptance && durableId
					? await target.recordSteering?.(sessionId, durableId, text, mode, deliveryOptions)
					: false;
			acceptance?.resolve();
			if (duplicate) return "duplicate";
			if (trace && acceptance) logTelegramDeliveryTrace(trace, { stage: "session_acceptance", sessionId });
			for (let attempt = 0; ; attempt++) {
				// The session may have changed since the message was accepted. Never deliver it to another one.
				if (closed || sessionId !== target.identity().sessionId) {
					throw new TerminalSessionChangedError("Terminal session detached or changed; message not delivered");
				}
				try {
					return await target.deliver(text, mode, deliveryOptions);
				} catch (error) {
					if (!(error instanceof TerminalNotReadyError) || attempt >= NOT_READY_RETRIES) throw error;
					await Bun.sleep(NOT_READY_RETRY_MS);
				}
			}
		});
		void run.then(
			outcome => {
				pendingDeliveries--;
				if (trace)
					logTelegramDeliveryTrace(trace, {
						stage: "delivery_outcome",
						sessionId,
						outcome: normalizeDeliveryOutcome(outcome),
					});
			},
			error => {
				acceptance?.reject(error);
				pendingDeliveries--;
				if (trace)
					logTelegramDeliveryTrace(trace, {
						stage: "delivery_outcome",
						sessionId,
						outcome: error instanceof TerminalNotReadyError ? "rejected" : "failed",
					});
			},
		);
		deliveryChain = run.then(
			() => {},
			() => {},
		);
		return run;
	};
	const trackDelivery = (
		sessionId: string,
		messageId: string,
		text: string,
		mode: "auto" | "steer" | "followUp",
		deliveryOptions: TerminalDeliveryOptions | undefined,
		index: DurableDeliveryReadback | undefined,
	): DeliveryRecord => {
		const key = deliveryKey(sessionId, messageId);
		const tagged = index && durableTerminalDeliveryId(text) === messageId;
		const acceptance = tagged && target.recordSteering ? Promise.withResolvers<void>() : undefined;
		// A non-ACK request waits on delivery, not the acceptance promise.
		void acceptance?.promise.catch(() => {});
		const promise = runDelivery(sessionId, text, mode, deliveryOptions, index ? messageId : undefined, acceptance);
		const record: DeliveryRecord = {
			sessionId,
			messageId,
			status: { state: "pending" },
			watchers: new Set(),
			promise,
			accepted: acceptance?.promise,
		};
		deliveries.set(key, record);
		evictOldDeliveries();
		const finish = (status: DeliveryState): void => {
			record.status = status;
			announceDelivery(record);
			record.watchers.clear();
			if (sessionId !== publishedSessionId) deliveries.delete(key);
		};
		void promise.then(
			outcome => {
				if (index && tagged && !index.consumed.has(messageId)) index.dispatched.set(messageId, outcome);
				finish({ state: "delivered", outcome });
			},
			error => {
				finish({ state: "failed", error: String(error) });
				if (error instanceof TerminalNotReadyError || error instanceof TerminalSessionChangedError) {
					deliveries.delete(key);
				}
			},
		);
		return record;
	};
	const server = await createTerminalControlTransport(endpoint, socket => {
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
			receipts.delete(socket);
			for (const record of deliveries.values()) {
				record.watchers.delete(socket);
			}
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
				let request;
				try {
					request = JSON.parse(line);
				} catch (error) {
					send(socket, { ok: false, error: String(error) });
					continue;
				}
				const id = request?.id;
				const handle = async (): Promise<void> => {
					if (socket.destroyed) return;
					let shutdownAfterResponse = false;
					try {
						if (typeof id !== "string" || request.version !== 1 || request.token !== token) {
							socket.destroy();
							return;
						}
						if (request.op === "registrySnapshot" && id.length > MAX_REGISTRY_SNAPSHOT_TEXT) {
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
							case "registrySnapshot": {
								if (!target.registrySnapshot) throw new Error("Registry snapshot unsupported");
								if (request.ownerGeneration !== ownerGeneration)
									throw new Error("Terminal owner generation changed; rediscover its owner");
								const observation = target.registrySnapshot(publishedSessionId);
								if (!observation) throw new Error("Registry snapshot unavailable");
								result = { version: 1, sessionId: publishedSessionId, ownerGeneration, ...observation };
								break;
							}
							case "subscribe": {
								if (request.secretIntake !== undefined) {
									const registration = request.secretIntake;
									const registrationKeys = ["version", "actorId", "ownerSessionId", "transport"];
									if (
										typeof registration !== "object" ||
										registration === null ||
										Array.isArray(registration) ||
										Object.keys(registration).length !== registrationKeys.length ||
										Object.keys(registration).some(key => !registrationKeys.includes(key)) ||
										registration.version !== 1 ||
										typeof registration.actorId !== "string" ||
										registration.actorId.length === 0 ||
										typeof registration.ownerSessionId !== "string" ||
										registration.ownerSessionId.length === 0 ||
										(registration.transport !== "telegram" && registration.transport !== "local") ||
										!target.registerSecretIntake
									) {
										throw new Error("Secret intake registration refused");
									}
									try {
										const context = await target.registerSecretIntake(
											registration as TerminalSecretRegistration,
										);
										if (
											context.actorId !== registration.actorId ||
											context.ownerSessionId !== registration.ownerSessionId ||
											typeof context.projectId !== "string" ||
											context.projectId.length === 0
										) {
											throw new Error("Secret intake registration refused");
										}
										await publish();
									} catch {
										throw new Error("Secret intake registration refused");
									}
								}
								const fullHistory = target.history();
								const cursorIndex =
									typeof request.cursor === "string" && request.cursor
										? fullHistory.findIndex(entry => entry.entryId === request.cursor)
										: -1;
								if (typeof request.cursor === "string" && request.cursor && cursorIndex < 0) {
									throw new Error("Unknown history cursor; reconnect without a cursor to reset history");
								}
								const receipt = receiptFor(socket);
								receipt.retainHistory(fullHistory.map(entry => entry.entryId));
								for (const entry of fullHistory.slice(-HISTORY_FRAME_ENTRIES))
									receipt.holdHistory(entry.entryId);
								let pending =
									cursorIndex >= 0
										? fullHistory.slice(cursorIndex + 1)
										: fullHistory.slice(-HISTORY_FRAME_ENTRIES);
								let replayCursor = fullHistory.at(-1)?.entryId;
								// The socket joins the live feed only after replay, in the same tick as the last journal read, so
								// a slow reader cannot be left with a failed subscribe that still streams, nor miss an entry that
								// arrived while it drained.
								for (let pass = 0; ; pass++) {
									const chunks = chunkHistory(pending);
									if (pass === 0 && !chunks.length) chunks.push([]);
									if (!chunks.length) break;
									for (const chunk of chunks) {
										await waitForWritable(socket);
										if (socket.destroyed) return;
										send(socket, {
											event: { kind: "history", sessionId: publishedSessionId, entries: chunk },
										});
									}
									const latest = target.history();
									const replayIndex =
										replayCursor === undefined
											? -1
											: latest.findIndex(entry => entry.entryId === replayCursor);
									// The receipt window bounds deduplication memory, not unread arrivals during a drain.
									pending =
										replayCursor === undefined
											? latest
											: replayIndex >= 0
												? latest.slice(replayIndex + 1)
												: latest
														.slice(-HISTORY_FRAME_ENTRIES)
														.filter(entry => !receipt.history.has(entry.entryId));
									replayCursor = latest.at(-1)?.entryId;
									receipt.retainHistory(latest.map(entry => entry.entryId));
									for (const entry of pending) receipt.holdHistory(entry.entryId);
								}
								if (socket.destroyed) return;
								if (
									closed ||
									request.sessionId !== publishedSessionId ||
									request.sessionId !== target.identity().sessionId
								) {
									throw new Error("Terminal session detached or changed; rediscover its owner");
								}
								subscribers.add(socket);
								const isNewListener = !unsubscribe;
								startEvents();
								if (
									!isNewListener &&
									currentStreamingEvent?.active &&
									currentStreamingEvent.sessionId === publishedSessionId
								) {
									send(socket, { event: currentStreamingEvent });
								}
								for (const record of deliveries.values()) {
									if (record.sessionId !== request.sessionId) continue;
									if (record.status.state === "pending") {
										record.watchers.add(socket);
									} else {
										await waitForWritable(socket);
										if (socket.destroyed) return;
										sendDelivery(socket, record);
									}
								}
								result = true;
								break;
							}
							case "deliver": {
								if (exitReserved) throw new Error("Terminal is exiting; delivery refused");
								if (
									typeof request.text !== "string" ||
									!request.text.trim() ||
									!["auto", "steer", "followUp"].includes(request.mode)
								)
									throw new Error("Invalid delivery");
								let telegramTrace: TelegramDeliveryTraceData | undefined;
								if (request.telegramTrace !== undefined) {
									telegramTrace = parseTelegramTrace(request.telegramTrace);
									if (!telegramTrace) {
										throw new Error("Invalid delivery");
									}
								}
								const deliveryOptions: TerminalDeliveryOptions | undefined = telegramTrace
									? { telegramTrace }
									: undefined;
								const messageId = typeof request.messageId === "string" ? request.messageId : "";
								if ((request.ack === true && !messageId) || messageId.length > 128) {
									throw new Error("Invalid delivery");
								}
								if (!messageId) {
									result = await runDelivery(request.sessionId, request.text, request.mode, deliveryOptions);
									break;
								}
								let index: DurableDeliveryReadback | undefined;
								if (DURABLE_DELIVERY_ID.test(messageId)) {
									readback ??= new DurableDeliveryReadback();
									index = readback;
								}
								let record = deliveries.get(deliveryKey(request.sessionId, messageId));
								let status = deliveryStatus(messageId, index, record);
								if (!status) {
									record = trackDelivery(
										request.sessionId,
										messageId,
										request.text,
										request.mode,
										deliveryOptions,
										index,
									);
									status = record.status;
								}
								if (request.ack === true) {
									if (record?.accepted) {
										await record.accepted;
										status = record.status;
									}
									if (record && status.state === "pending") {
										if (!socket.destroyed) record.watchers.add(socket);
									} else if (record && status === record.status) {
										sendDelivery(socket, record);
									}
									result = { accepted: true, messageId, ...status };
								} else if (status.state === "delivered") {
									result = status.outcome;
								} else if (status.state === "failed") {
									throw new Error(status.error);
								} else {
									result = await record!.promise;
								}
								break;
							}
							case "deliveryCapacity":
								result = {
									limit: MAX_PENDING_DELIVERIES,
									available: exitReserved ? 0 : MAX_PENDING_DELIVERIES - pendingDeliveries,
								};
								break;
							case "deliveryStatus": {
								const messageId = typeof request.messageId === "string" ? request.messageId : "";
								const index = DURABLE_DELIVERY_ID.test(messageId)
									? await refreshReadback(request.sessionId)
									: undefined;
								if (request.token !== token)
									throw new Error("Terminal credential changed; rediscover its owner");
								const known = deliveries.get(deliveryKey(request.sessionId, messageId));
								result = deliveryStatus(messageId, index, known) ?? { state: "unknown" };
								break;
							}
							case "abort":
								result = await target.abort();
								break;
							case "rotate":
								await publish({
									nextToken: crypto.randomBytes(32).toString("hex"),
									expectedToken: request.token,
								});
								for (const peer of sockets) {
									if (peer !== socket) peer.destroy();
								}
								subscribers.clear();
								receipts.delete(socket);
								stopEvents();
								for (const delivery of deliveries.values()) delivery.watchers.clear();
								result = { rotated: true };
								break;
							case "secret_request": {
								if (!target.secretRequest) throw new Error("Secret intake request refused");
								const allowed =
									request.action === "submit"
										? [
												"id",
												"version",
												"token",
												"sessionId",
												"op",
												"action",
												"requestId",
												"submission",
												"context",
											]
										: ["id", "version", "token", "sessionId", "op", "action", "requestId", "context"];
								if (
									Object.keys(request).some(key => !allowed.includes(key)) ||
									!["get", "submit", "decline", "cancel"].includes(request.action) ||
									typeof request.requestId !== "string" ||
									typeof request.context !== "object" ||
									request.context === null ||
									Object.keys(request.context).length !== 3 ||
									Object.keys(request.context).some(
										key => !["actorId", "ownerSessionId", "projectId"].includes(key),
									) ||
									typeof request.context.actorId !== "string" ||
									typeof request.context.ownerSessionId !== "string" ||
									typeof request.context.projectId !== "string" ||
									(request.action === "submit" &&
										(typeof request.submission !== "object" ||
											request.submission === null ||
											request.submission.requestId !== request.requestId))
								) {
									throw new Error("Secret intake request refused");
								}
								try {
									result = { request: await target.secretRequest(request) };
								} catch {
									throw new Error("Secret intake request refused");
								}
								break;
							}
							case "idleExit": {
								if (exitReserved) {
									result = { accepted: false, reason: "busy" };
									break;
								}
								if (
									pendingDeliveries > 0 ||
									target.isIdle?.() !== true ||
									!target.reserveExit ||
									!target.shutdown
								) {
									result = { accepted: false, reason: "busy" };
									break;
								}
								exitReserved = true;
								target.reserveExit();
								shutdownAfterResponse = true;
								result = { accepted: true, ...getLoadedBuildIdentity(), argv: startupArgv };
								break;
							}
							case "ping":
								result = {
									...target.identity(),
									pid: process.pid,
									capabilities: capabilities(),
									...(target.registrySnapshot ? { ownerGeneration } : {}),
									...getLoadedBuildIdentity(),
									argv: startupArgv,
								};
								break;
							default:
								throw new Error("Unknown terminal operation");
						}
						const intake = request.op === "subscribe" ? secretIntakeCapability() : undefined;
						const frame = {
							id,
							ok: true,
							result,
							...(intake ? { secretIntake: intake } : {}),
						};
						if (shutdownAfterResponse) {
							socket.write(`${JSON.stringify(frame)}\n`, () => {
								void target.shutdown?.();
							});
						} else {
							send(socket, frame);
						}
					} catch (error) {
						send(socket, { id, ok: false, error: String(error) });
					}
				};
				// Read-only snapshots, readback and ack admission do not wait for a plain delivery.
				if (
					request?.op === "registrySnapshot" ||
					request?.op === "deliveryCapacity" ||
					request?.op === "deliveryStatus" ||
					(request?.op === "deliver" && request.ack === true)
				) {
					void handle();
				} else {
					queue = queue.then(handle);
				}
			}
		});
	});
	const writeOwner =
		options.writeOwner ??
		(async (destination: string, record: TerminalOwner): Promise<void> => {
			await atomicWriteFileWith(
				destination,
				async temporary => {
					await applyOwnerOnlyWindowsAcl(temporary);
					await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
				},
				{
					mode: 0o600,
					// This credential dies with the process. No fallible flush may follow its atomic replacement.
					fsync: false,
					requireAtomicReplace: true,
				},
			);
		});
	const publish = ({
		nextToken,
		expectedToken,
		onAttempt,
	}: { nextToken?: string; expectedToken?: string; onAttempt?: (sessionId: string) => void } = {}): Promise<void> => {
		const run = publication.then(async () => {
			if (closed) throw new Error("Terminal control is closed");
			if (expectedToken !== undefined && expectedToken !== token) {
				throw new Error("Terminal credential changed; rediscover its owner");
			}
			const identity = target.identity();
			onAttempt?.(identity.sessionId);
			const credential = nextToken ?? token;
			const generation =
				nextToken !== undefined || identity.sessionId !== publishedSessionId
					? crypto.randomUUID()
					: ownerGeneration;
			const build = getLoadedBuildIdentity();
			const record: TerminalOwner = {
				version: 1,
				...identity,
				pid: process.pid,
				endpoint,
				token: credential,
				loadedVersion: build.version,
				loadedBuildSha: build.buildSha,
				capabilities: capabilities(),
				...(target.registrySnapshot ? { ownerGeneration: generation } : {}),
			};
			await writeOwner(recordPath, record);
			if (closed) {
				await fs.rm(recordPath, { force: true });
				throw new Error("Terminal control is closed");
			}
			token = credential;
			ownerGeneration = generation;
			const previousSessionId = publishedSessionId;
			publishedSessionId = identity.sessionId;
			if (previousSessionId !== identity.sessionId) {
				readback = undefined;
				currentStreamingEvent = undefined;
				for (const [key, delivery] of deliveries) {
					if (delivery.sessionId === previousSessionId && delivery.status.state !== "pending")
						deliveries.delete(key);
				}
			}
		});
		publication = run.catch(() => {});
		return run;
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
	server.onClose?.(close);
	return Object.assign(close, { refreshIdentity: reconcile });
}
