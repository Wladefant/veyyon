import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	applyOwnerOnlyWindowsAcl,
	atomicWriteFileWith,
	errorMessage,
	getConfigRootDir,
	logTelegramDeliveryTrace,
	normalizeDeliveryOutcome,
	parseTelegramTrace,
	postmortem,
	type TelegramDeliveryTraceData,
} from "@veyyon/utils";
import { getLoadedBuildIdentity } from "./build-info";
import { createTerminalControlTransport, type TerminalSocket } from "./terminal-control-transport";
import { TerminalReceipts } from "./terminal-receipts";
import type { SecretRequestMetadata, SecretSubmission } from "../secrets/intake-wire";

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
}

export interface TerminalDeliveryOptions {
	telegramTrace?: TelegramDeliveryTraceData;
}

export interface TerminalControlTarget {
	identity(): { sessionId: string; cwd: string; sessionFile: string };
	deliver(text: string, mode: "auto" | "steer" | "followUp", options?: TerminalDeliveryOptions): Promise<string>;
	abort(): Promise<boolean>;
	history(): { entryId: string; text: string }[];
	subscribe(listener: (event: unknown) => void): () => void;
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

/** Optional protocol features this build serves. A peer that lacks one never sees the field. */
export const TERMINAL_CAPABILITIES = ["deliver-ack", "session-notices", "rotate"] as const;
/** The newest assistant entries a subscriber is told about; older ones were seen by any earlier subscriber. */
const HISTORY_FRAME_ENTRIES = 1000;
const MAX_REMEMBERED_DELIVERIES = 256;
/** Deliveries accepted and not yet settled. Beyond this the terminal answers `busy`: each holds its text. */
const MAX_PENDING_DELIVERIES = 64;
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
	| { state: "delivered"; outcome: string }
	| { state: "failed"; error: string };

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

/** The socket lives in the CLI process; neither this module nor a client opens a session file. */
export async function serveTerminalControl(
	target: TerminalControlTarget,
	root = getConfigRootDir(),
	options: TerminalControlOptions = {},
): Promise<() => void> {
	const secretIntakeContext = (): TerminalSecretActorContext | undefined =>
		target.secretRequest ? target.secretIntakeContext?.() : undefined;
	const secretIntakeCapability = () => {
		const context = secretIntakeContext();
		return context ? { version: 1 as const, sealed: true as const, context } : undefined;
	};
	const capabilities = (): readonly string[] =>
		secretIntakeContext() ? [...TERMINAL_CAPABILITIES, "secret-intake"] : TERMINAL_CAPABILITIES;
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
	let unsubscribe: (() => void) | undefined;
	let refresh: NodeJS.Timeout | undefined;
	let refreshing = false;
	let publication: Promise<void> = Promise.resolve();
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
	// Acked deliveries, by the daemon's message id, scoped to the session that accepted them. The table
	// lets a retry after a lost connection find the earlier request instead of enqueueing the message
	// twice. Insertion order = age. Only settled records are evicted, so a pending id is never forgotten
	// and re-enqueued.
	//
	// Crash window: from the ack until `target.deliver` runs, the message exists only in this process.
	// A crash or close in that window loses it, although the daemon already holds the ack. The window
	// is the time the terminal needs to reach the message on the chain.
	const deliveryKey = (sessionId: string, messageId: string): string => `${sessionId}\0${messageId}`;
	const deliveries = new Map<
		string,
		{
			sessionId: string;
			messageId: string;
			status: DeliveryState;
			watchers: Set<TerminalSocket>;
			promise?: Promise<string>;
		}
	>();
	const evictOldDeliveries = (): void => {
		for (const [oldestId, oldest] of deliveries) {
			if (deliveries.size <= MAX_REMEMBERED_DELIVERIES) break;
			if (oldest.status.state !== "pending") deliveries.delete(oldestId);
		}
	};
	// One chain for acked and plain deliveries: messages reach the terminal in the order they were accepted.
	let deliveryChain: Promise<void> = Promise.resolve();
	let pendingDeliveries = 0;
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
	const announceDelivery = (record: {
		sessionId: string;
		messageId: string;
		status: DeliveryState;
		watchers: Set<TerminalSocket>;
	}): void => {
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
	): Promise<string> => {
		if (pendingDeliveries >= MAX_PENDING_DELIVERIES) {
			return Promise.reject(new Error("Terminal busy: too many deliveries pending; retry later"));
		}
		pendingDeliveries++;
		const run = deliveryChain.then(async () => {
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
		const settle = (): void => {
			pendingDeliveries--;
		};
		run.then(settle, settle);
		deliveryChain = run.then(
			() => {},
			() => {},
		);
		return run;
	};
	const acceptDelivery = (
		socket: TerminalSocket,
		sessionId: string,
		messageId: string,
		text: string,
		mode: "auto" | "steer" | "followUp",
		deliveryOptions?: TerminalDeliveryOptions,
	): { accepted: true; messageId: string; state: DeliveryState["state"]; outcome?: string; error?: string } => {
		const key = deliveryKey(sessionId, messageId);
		const known = deliveries.get(key);
		if (known) {
			if (known.status.state === "pending") {
				known.watchers.add(socket);
				return { accepted: true, messageId, state: "pending" };
			}
			sendDelivery(socket, known);
			return {
				accepted: true,
				messageId,
				state: known.status.state,
				...(known.status.state === "delivered" ? { outcome: known.status.outcome } : { error: known.status.error }),
			};
		}
		if (pendingDeliveries >= MAX_PENDING_DELIVERIES)
			throw new Error("Terminal busy: too many deliveries pending; retry later");
		if (deliveryOptions?.telegramTrace) {
			logTelegramDeliveryTrace(deliveryOptions.telegramTrace, {
				stage: "session_acceptance",
				sessionId,
			});
		}
		const deliveryPromise = runDelivery(sessionId, text, mode, deliveryOptions);
		const record = {
			sessionId,
			messageId,
			status: { state: "pending" } as DeliveryState,
			watchers: new Set([socket]),
			promise: deliveryPromise,
		};
		deliveries.set(key, record);
		evictOldDeliveries();
		let retryable = false;
		void deliveryPromise
			.then(
				outcome => {
					record.status = { state: "delivered", outcome };
					if (deliveryOptions?.telegramTrace) {
						logTelegramDeliveryTrace(deliveryOptions.telegramTrace, {
							stage: "delivery_outcome",
							sessionId,
							outcome: normalizeDeliveryOutcome(outcome),
						});
					}
				},
				error => {
					record.status = { state: "failed", error: String(error) };
					if (deliveryOptions?.telegramTrace) {
						logTelegramDeliveryTrace(deliveryOptions.telegramTrace, {
							stage: "delivery_outcome",
							sessionId,
							outcome: error instanceof TerminalNotReadyError ? "rejected" : "failed",
						});
					}
					if (error instanceof TerminalNotReadyError || error instanceof TerminalSessionChangedError) {
						retryable = true;
					}
				},
			)
			.then(() => {
				announceDelivery(record);
				record.watchers.clear();
				if (retryable || record.sessionId !== publishedSessionId) deliveries.delete(key);
			});
		return { accepted: true, messageId, state: "pending" };
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
				const handle = async (): Promise<void> => {
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
										const context = await target.registerSecretIntake(registration as TerminalSecretRegistration);
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
								if (request.ack === true) {
									// The terminal may be blocked for seconds. Accept now, deliver on the chain.
									if (
										typeof request.messageId !== "string" ||
										!request.messageId ||
										request.messageId.length > 128
									)
										throw new Error("Invalid delivery");
									result = acceptDelivery(
										socket,
										request.sessionId,
										request.messageId,
										request.text,
										request.mode,
										deliveryOptions,
									);
									break;
								}
								if (typeof request.messageId === "string" && request.messageId) {
									if (request.messageId.length > 128) throw new Error("Invalid delivery");
									const key = deliveryKey(request.sessionId, request.messageId);
									const known = deliveries.get(key);
									if (known) {
										if (known.status.state === "delivered") {
											result = known.status.outcome;
											break;
										}
										if (known.status.state === "failed") throw new Error(known.status.error);
										if (known.promise) {
											result = await known.promise;
											break;
										}
									}
									if (pendingDeliveries >= MAX_PENDING_DELIVERIES)
										throw new Error("Terminal busy: too many deliveries pending; retry later");
									if (telegramTrace) {
										logTelegramDeliveryTrace(telegramTrace, {
											stage: "session_acceptance",
											sessionId: request.sessionId,
										});
									}
									const deliveryPromise = runDelivery(request.sessionId, request.text, request.mode, deliveryOptions);
									const record = {
										sessionId: request.sessionId,
										messageId: request.messageId,
										status: { state: "pending" } as DeliveryState,
										watchers: new Set<TerminalSocket>(),
										promise: deliveryPromise,
									};
									deliveries.set(key, record);
									evictOldDeliveries();
									let retryable = false;
									void deliveryPromise
										.then(
											outcome => {
												record.status = { state: "delivered", outcome };
												if (telegramTrace) {
													logTelegramDeliveryTrace(telegramTrace, {
														stage: "delivery_outcome",
														sessionId: request.sessionId,
														outcome: normalizeDeliveryOutcome(outcome),
													});
												}
											},
											error => {
												record.status = { state: "failed", error: String(error) };
												if (telegramTrace) {
													logTelegramDeliveryTrace(telegramTrace, {
														stage: "delivery_outcome",
														sessionId: request.sessionId,
														outcome: error instanceof TerminalNotReadyError ? "rejected" : "failed",
													});
												}
												if (
													error instanceof TerminalNotReadyError ||
													error instanceof TerminalSessionChangedError
												) {
													retryable = true;
												}
											},
										)
										.then(() => {
											announceDelivery(record);
											record.watchers.clear();
											if (retryable || record.sessionId !== publishedSessionId) deliveries.delete(key);
										});
									result = await deliveryPromise;
									break;
								}
								if (telegramTrace) {
									logTelegramDeliveryTrace(telegramTrace, {
										stage: "session_acceptance",
										sessionId: request.sessionId,
									});
								}
								try {
									result = await runDelivery(request.sessionId, request.text, request.mode, deliveryOptions);
									if (telegramTrace) {
										logTelegramDeliveryTrace(telegramTrace, {
											stage: "delivery_outcome",
											sessionId: request.sessionId,
											outcome: normalizeDeliveryOutcome(result),
										});
									}
								} catch (error) {
									if (telegramTrace) {
										logTelegramDeliveryTrace(telegramTrace, {
											stage: "delivery_outcome",
											sessionId: request.sessionId,
											outcome: error instanceof TerminalNotReadyError ? "rejected" : "failed",
										});
									}
									throw error;
								}
								break;
							}
							case "deliveryStatus": {
								const known =
									typeof request.messageId === "string"
										? deliveries.get(deliveryKey(request.sessionId, request.messageId))
										: undefined;
								result = known ? known.status : { state: "unknown" };
								break;
							}
							case "abort":
								result = await target.abort();
								break;
							case "rotate":
								await publish(crypto.randomBytes(32).toString("hex"), request.token);
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
										? ["id", "version", "token", "sessionId", "op", "action", "requestId", "submission", "context"]
										: ["id", "version", "token", "sessionId", "op", "action", "requestId", "context"];
								if (
									Object.keys(request).some(key => !allowed.includes(key)) ||
									!["get", "submit", "decline", "cancel"].includes(request.action) ||
									typeof request.requestId !== "string" ||
									typeof request.context !== "object" ||
									request.context === null ||
									Object.keys(request.context).length !== 3 ||
									Object.keys(request.context).some(key => !["actorId", "ownerSessionId", "projectId"].includes(key)) ||
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
							case "ping":
								result = { ...target.identity(), pid: process.pid, capabilities: capabilities() };
								break;
							default:
								throw new Error("Unknown terminal operation");
						}
						const intake = request.op === "subscribe" ? secretIntakeCapability() : undefined;
						send(socket, {
							id,
							ok: true,
							result,
							...(intake ? { secretIntake: intake } : {}),
						});
					} catch (error) {
						send(socket, { id, ok: false, error: String(error) });
					}
				};
				// An acked delivery only registers the message, so it never waits behind a slower request on this socket.
				if (/"ack"\s*:\s*true/.test(line) && /"op"\s*:\s*"deliver"/.test(line)) void handle();
				else queue = queue.then(handle);
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
	const publish = (nextToken?: string, expectedToken?: string): Promise<void> => {
		const run = publication.then(async () => {
			if (closed) throw new Error("Terminal control is closed");
			if (expectedToken !== undefined && expectedToken !== token) {
				throw new Error("Terminal credential changed; rediscover its owner");
			}
			const identity = target.identity();
			const credential = nextToken ?? token;
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
			};
			await writeOwner(recordPath, record);
			if (closed) {
				await fs.rm(recordPath, { force: true });
				throw new Error("Terminal control is closed");
			}
			token = credential;
			const previousSessionId = publishedSessionId;
			publishedSessionId = identity.sessionId;
			if (previousSessionId !== identity.sessionId) {
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
	return close;
}
