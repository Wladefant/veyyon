/**
 * The Codex WebSocket transport: one pooled connection per session, its heartbeat, the frame queue a
 * request drains, the timeouts that hand a stalled request to the SSE fallback, and the debug echo of
 * every frame. The client in `../openai-codex-responses` selects the transport and drives the turn.
 */
import { $env } from "@veyyon/utils/env";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { CodexWebSocketTransportError } from "../../error/classes";
import type { RawSseEvent } from "../../types";
import {
	createRequestDebugSession,
	isRequestDebugEnabled,
	type RequestDebugResponseLog,
} from "../../utils/request-debug";
import { notifyRawSseEvent } from "../../utils/sse-debug";
import type { CodexWebSocketSessionState } from "../openai-codex-responses";
import { resetCodexWebSocketAppendState } from "./session-state";
import { CODEX_DEBUG, isCodexStreamProgressEvent, updateCodexSessionMetadataFromHeaders, wireInteger } from "./wire";

const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
const CODEX_WEBSOCKET_PING_INTERVAL_MS = Number($env.VEYYON_CODEX_WEBSOCKET_PING_INTERVAL_MS || 10_000);
const CODEX_WEBSOCKET_PONG_TIMEOUT_MS = Number($env.VEYYON_CODEX_WEBSOCKET_PONG_TIMEOUT_MS || 60_000);
const CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY = Number($env.VEYYON_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY || 4096);

/**
 * Maximum quiet period (no inbound frames AND no observed pong) we'll trust a
 * reused WebSocket for before forcing a fresh handshake. Codex backends and
 * intermediaries occasionally evict idle sockets server-side without sending a
 * FIN, leaving the local `readyState` as OPEN while the next `send()` becomes a
 * write into a half-open buffer. Reusing such a socket parks the next request
 * at `#nextMessage` until the first-event/idle timeout fires (issue #1450). The
 * heartbeat below also catches dead sockets, but only after `pongTimeoutMs`
 * (default 60s) and only while a request is active — this gate closes the door
 * earlier and even when the gap between requests is purely client-side (tool
 * execution, user typing, etc.). Set `VEYYON_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS=0`
 * to disable.
 */
const CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = Number($env.VEYYON_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS || 30_000);

function extractCodexFrameResponseId(frame: Record<string, unknown>): string | undefined {
	const response = (frame as { response?: { id?: unknown } }).response;
	const id = response?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

type CodexWebSocketTimeoutDetails = {
	lastEventAt: number;
	lastEventType?: string;
	lastProgressAt: number;
	lastProgressEventType?: string;
};

function createCodexWebSocketTimeoutMessage(reason: string, details: CodexWebSocketTimeoutDetails): string {
	const now = Date.now();
	const lastEvent = details.lastEventType
		? `${details.lastEventType} ${Math.max(0, now - details.lastEventAt)}ms ago`
		: "none";
	const lastProgress = details.lastProgressEventType
		? `${details.lastProgressEventType} ${Math.max(0, now - details.lastProgressAt)}ms ago`
		: "none";
	return `${reason} (last event: ${lastEvent}; last progress: ${lastProgress})`;
}

function toCodexHeaderRecord(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object") return null;
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") {
			headers[key] = entry;
		} else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) {
			headers[key] = entry.join(",");
		} else if (typeof entry === "number" || typeof entry === "boolean") {
			headers[key] = String(entry);
		}
	}
	return Object.keys(headers).length > 0 ? headers : null;
}

function toCodexHeaders(value: unknown): Headers | undefined {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (Array.isArray(value)) {
		try {
			return new Headers(value as Array<[string, string]>);
		} catch {
			// Header pairs a Headers object refuses (an invalid name, a value with a newline) are not headers
			// we may send, so undefined means "no headers from this value" and the request goes out with its
			// defaults. Sending a partially-built set would be worse than sending none.
			return undefined;
		}
	}
	const record = toCodexHeaderRecord(value);
	if (!record) return undefined;
	return new Headers(record);
}

function extractCodexWebSocketHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): Headers | undefined {
	const eventRecord = openEvent as Record<string, unknown> | undefined;
	const eventResponse = eventRecord?.response as Record<string, unknown> | undefined;
	const socketRecord = socket as unknown as Record<string, unknown>;
	const socketResponse = socketRecord.response as Record<string, unknown> | undefined;
	const socketHandshake = socketRecord.handshake as Record<string, unknown> | undefined;
	return (
		toCodexHeaders(eventRecord?.responseHeaders) ??
		toCodexHeaders(eventRecord?.headers) ??
		toCodexHeaders(eventResponse?.headers) ??
		toCodexHeaders(socketRecord.responseHeaders) ??
		toCodexHeaders(socketRecord.handshakeHeaders) ??
		toCodexHeaders(socketResponse?.headers) ??
		toCodexHeaders(socketHandshake?.headers)
	);
}

// Synthesizes a `RawSseEvent` for a Codex WebSocket frame so the same debug
// pipeline used for HTTP SSE (`onSseEvent` → `RawSseDebugBuffer.recordEvent`)
// also captures WebSocket traffic. The `raw` array mirrors SSE wire format
// (one line per field) so the existing TUI viewer renders it identically:
//   : ws ← <type>
//   event: <type>
//   data: <json>
// Outbound (client → server) uses `: ws → <type>`. The viewer pretty-prints
// `data:` JSON lines, so we keep the wire JSON single-line here and let the
// renderer expand it.
function notifyCodexWebSocketInbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	parsed: Record<string, unknown>,
	text: string,
): void {
	const type = typeof parsed.type === "string" ? parsed.type : null;
	const raw: string[] = [`: ws ← ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: type, data: text, raw });
}

function notifyCodexWebSocketOutbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	request: Record<string, unknown>,
	payload: string,
): void {
	const type = typeof request.type === "string" ? request.type : null;
	const raw: string[] = [`: ws → ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${payload}`);
	notifyRawSseEvent(observer, { event: type, data: payload, raw });
}

function notifyCodexWebSocketMalformed(
	observer: ((event: RawSseEvent) => void) | undefined,
	data: unknown,
	error: unknown,
): void {
	const text = typeof data === "string" ? data : "";
	const reason = errorMessage(error);
	const raw: string[] = [`: ws ← (parse-error: ${reason})`];
	if (text) raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: "parse_error", data: text, raw });
}

export function toWebSocketUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		parsed.protocol = "wss:";
	} else if (parsed.protocol === "http:") {
		parsed.protocol = "ws:";
	}
	return parsed.toString();
}

function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

interface CodexWebSocketRequestTimeouts {
	idleTimeoutMs?: number;
	firstEventTimeoutMs?: number;
}

interface CodexWebSocketConnectionOptions {
	onHandshakeHeaders?: (headers: Headers) => void;
}

/**
 * Whether a websocket request yields no further frame after an event of this type. Compared in place: each frame's
 * type is a fresh string, which a `Set` lookup would hash on every frame.
 */
function isCodexWebSocketTerminalEventType(eventType: string): boolean {
	return (
		eventType === "response.completed" ||
		eventType === "response.done" ||
		eventType === "response.incomplete" ||
		eventType === "response.failed" ||
		eventType === "error"
	);
}

/** Copies `error.code` and `error.message` onto an `error` frame's top level where the frame has neither. */
function hoistCodexErrorFrameFields(frame: Record<string, unknown>): void {
	if (frame.type !== "error" || typeof frame.error !== "object" || !frame.error) return;
	const inner = frame.error as Record<string, unknown>;
	if (typeof frame.code !== "string" && typeof inner.code === "string") {
		frame.code = inner.code;
	}
	if (typeof frame.message !== "string" && typeof inner.message === "string") {
		frame.message = inner.message;
	}
}

/**
 * Frame accounting for one request on a reused websocket: the first-event and idle clocks, and the check that keeps
 * a frame of another response out of this one.
 *
 * The socket is reused across turns. Upstream codex-rs leans on the protocol guarantee that nothing follows a
 * response's terminal event, but the queue can still surface a trailing or duplicate frame from a cleanly-completed
 * prior response after `#dropStaleFrames()` drained the queue at send time. Attaching such a frame to this turn
 * misattributes an earlier turn's output (a stale `response.completed` ends the turn early; a stale item makes the
 * model see an unrelated call). Only lifecycle events (created/completed/failed/incomplete) carry a `response.id`,
 * and those are the harmful ones, so the check keys on it and admits idless frames (deltas, the rate-limit/metadata
 * preamble, created-less streams), matching upstream rather than requiring `response.created` first.
 */
class CodexWebSocketResponseFrames {
	/** Most recent `response.id` admitted on the socket; starts at the one the previous request admitted. */
	lastSeenResponseId: string | undefined;
	readonly #priorResponseId: string | undefined;
	#activeResponseId: string | undefined;
	#lastSequence: number | undefined;
	#sawFirstEvent = false;
	#lastEventAt: number;
	#lastEventType: string | undefined;
	#lastProgressAt: number;
	#lastProgressEventType: string | undefined;

	constructor(priorResponseId: string | undefined) {
		this.#priorResponseId = priorResponseId;
		this.lastSeenResponseId = priorResponseId;
		this.#lastProgressAt = Date.now();
		this.#lastEventAt = this.#lastProgressAt;
	}

	timeoutReason(): string {
		return createCodexWebSocketTimeoutMessage(
			this.#sawFirstEvent ? "idle timeout waiting for websocket" : "timeout waiting for first websocket event",
			{
				lastEventAt: this.#lastEventAt,
				lastEventType: this.#lastEventType,
				lastProgressAt: this.#lastProgressAt,
				lastProgressEventType: this.#lastProgressEventType,
			},
		);
	}

	/**
	 * Milliseconds the next frame may take, or `undefined` for no deadline. Before the first frame the deadline is the
	 * first-event timeout; after it, the idle timeout less the time since the last progress event. Throws when that
	 * remainder is already spent.
	 */
	nextTimeoutMs({ idleTimeoutMs, firstEventTimeoutMs }: CodexWebSocketRequestTimeouts): number | undefined {
		if (!this.#sawFirstEvent) {
			return firstEventTimeoutMs !== undefined && firstEventTimeoutMs > 0 ? firstEventTimeoutMs : undefined;
		}
		if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return undefined;
		const remainingMs = idleTimeoutMs - (Date.now() - this.#lastProgressAt);
		if (remainingMs > 0) return remainingMs;
		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket idle timeout", {
				lastEventType: this.#lastEventType,
				lastProgressEventType: this.#lastProgressEventType,
				msSinceLastEvent: Date.now() - this.#lastEventAt,
				msSinceLastProgress: Date.now() - this.#lastProgressAt,
			});
		throw new CodexWebSocketTransportError(this.timeoutReason());
	}

	/**
	 * Admits a frame into this request and advances the clocks. Returns `"drop"` for a trailing or duplicate frame of
	 * the previous response, leaving the clocks untouched so this response can still start. Returns an error for a
	 * frame of another response interleaving on the socket, or for a `sequence_number` regression: the idless deltas
	 * that follow are indistinguishable, so the request fails closed (retryable) instead of misattributing them.
	 */
	admit(frame: Record<string, unknown>, eventType: string): "accept" | "drop" | CodexWebSocketTransportError {
		const responseId = extractCodexFrameResponseId(frame);
		if (responseId !== undefined) {
			if (this.#activeResponseId === undefined) {
				if (responseId === this.#priorResponseId) return "drop";
				this.#activeResponseId = responseId;
			} else if (responseId !== this.#activeResponseId) {
				return new CodexWebSocketTransportError(
					`websocket frame for response ${responseId} interleaved into active response ${this.#activeResponseId}`,
				);
			}
			this.lastSeenResponseId = responseId;
		}
		const sequence = wireInteger(frame.sequence_number);
		if (sequence !== undefined) {
			if (
				this.#activeResponseId !== undefined &&
				this.#lastSequence !== undefined &&
				sequence < this.#lastSequence
			) {
				return new CodexWebSocketTransportError(
					`websocket sequence_number ${sequence} regressed below ${this.#lastSequence} within response ${this.#activeResponseId}`,
				);
			}
			this.#lastSequence = sequence;
		}
		this.#sawFirstEvent = true;
		this.#lastEventAt = Date.now();
		this.#lastEventType = eventType || undefined;
		if (isCodexStreamProgressEvent(frame)) {
			this.#lastProgressAt = this.#lastEventAt;
			this.#lastProgressEventType = this.#lastEventType;
		}
		return "accept";
	}
}

export class CodexWebSocketConnection {
	#url: string;
	#headers: Record<string, string>;
	#onHandshakeHeaders?: (headers: Headers) => void;
	#socket: Bun.WebSocket | null = null;
	#queue: Array<Record<string, unknown> | Error | null> = [];
	#waiters: Array<() => void> = [];
	#connectPromise?: Promise<void>;
	#activeRequest = false;
	#streamObserver?: (event: RawSseEvent) => void;
	#heartbeatInterval: NodeJS.Timeout | undefined;
	#removePongListener?: () => void;
	#handshakeHeaders?: Headers;
	#debugResponseLog?: RequestDebugResponseLog;
	/**
	 * Wall-clock of the most recent inbound activity on this socket — any
	 * decoded message, any pong, or the moment the handshake completed. Used
	 * by {@link isHealthyForReuse} so we don't write a continuation frame into
	 * a TCP-open-but-server-evicted socket whose `readyState` still says OPEN.
	 */
	#lastInboundAt = 0;
	/** Wall-clock of the last heartbeat ping we issued; 0 if none yet. */
	#lastPingAt = 0;
	/**
	 * Most recent `response.id` accepted on this socket, retained across
	 * requests. Lets the next request drop a trailing/duplicate frame from the
	 * previous (cleanly-completed) response that outlived the queue drain.
	 */
	#lastSeenResponseId?: string;

	constructor(url: string, headers: Record<string, string>, options: CodexWebSocketConnectionOptions) {
		this.#url = url;
		this.#headers = headers;
		this.#onHandshakeHeaders = options.onHandshakeHeaders;
	}

	isOpen(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	/** True while a handshake (possibly started by another caller) is still in flight. */
	isConnecting(): boolean {
		return this.#connectPromise !== undefined;
	}

	/**
	 * Stricter variant of {@link isOpen} for the connection-pool reuse gate.
	 * Refuses sockets that have been silent past {@link CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS}.
	 *
	 * Bun's `WebSocket` does not always surface server-side eviction (no
	 * `onclose`, no `onerror`), so a socket can sit in readyState OPEN long
	 * after the upstream has dropped it. Reusing such a socket sends the next
	 * `response.create` into a half-open write buffer and parks the reader
	 * until the first-event / idle timeout fires (issue #1450). Forcing a
	 * reconnect on any suspect socket trades a sub-second handshake for a
	 * 60–300 s stall.
	 */
	isHealthyForReuse(): boolean {
		if (!this.isOpen()) return false;
		const maxIdleMs = CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS;
		if (maxIdleMs <= 0) return true;
		// Initial connect sets #lastInboundAt; any later message or pong refreshes
		// it. A zero value means the field was never initialized, which itself is
		// a desync — treat as unhealthy.
		if (this.#lastInboundAt === 0) return false;
		return Date.now() - this.#lastInboundAt <= maxIdleMs;
	}

	matchesAuth(headers: Record<string, string>): boolean {
		return this.#headers.authorization === headers.authorization;
	}

	close(reason = "done"): void {
		if (
			this.#socket &&
			(this.#socket.readyState === WebSocket.OPEN || this.#socket.readyState === WebSocket.CONNECTING)
		) {
			this.#socket.close(1000, reason);
		}
		this.#socket = null;
		this.#stopHeartbeat();
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.isOpen()) return;
		if (this.#connectPromise) {
			logger.time("codexWs:awaitSharedHandshake");
			await this.#connectPromise;
			return;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#connectPromise = promise;
		const socket = new (WebSocket as unknown as new (url: string, opts: Bun.WebSocketOptions) => Bun.WebSocket)(
			this.#url,
			{ headers: this.#headers },
		);
		socket.binaryType = "nodebuffer";
		this.#socket = socket;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const clearPending = () => {
			if (timeout !== undefined) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			if (signal) signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			socket.close(1000, "aborted");
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`request was aborted`));
			}
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		if (!settled) {
			timeout = setTimeout(() => {
				socket.close(1000, "connect-timeout");
				if (!settled) {
					settled = true;
					clearPending();
					reject(new CodexWebSocketTransportError(`connection timeout`));
				}
			}, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);
		}

		socket.onopen = event => {
			if (!settled) {
				settled = true;
				clearPending();
				this.#lastInboundAt = Date.now();
				this.#captureHandshakeHeaders(socket, event);
				this.#startHeartbeat(socket);
				resolve();
			}
		};
		socket.onerror = event => {
			const eventRecord = event as unknown as Record<string, unknown>;
			const detail =
				(typeof eventRecord.message === "string" && eventRecord.message) ||
				(eventRecord.error instanceof Error && eventRecord.error.message) ||
				String(event.type);
			const error = new CodexWebSocketTransportError(`websocket error: ${detail}`);
			if (!settled) {
				settled = true;
				clearPending();
				reject(error);
				return;
			}
			this.#push(error);
		};
		socket.onclose = event => {
			this.#socket = null;
			this.#stopHeartbeat();
			if (!settled) {
				settled = true;
				clearPending();
				reject(new CodexWebSocketTransportError(`websocket closed before open (${event.code})`));
				return;
			}
			this.#push(new CodexWebSocketTransportError(`websocket closed (${event.code})`));
			this.#push(null);
		};
		socket.onmessage = event => {
			// Stamp inbound activity before parsing so even malformed frames refresh
			// the liveness clock — what matters for reuse health is that the upstream
			// is still talking to us, not that every frame is well-formed.
			this.#lastInboundAt = Date.now();
			this.#writeDebugWebSocketFrame(event.data);
			try {
				const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf-8");
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				hoistCodexErrorFrameFields(parsed);
				notifyCodexWebSocketInbound(this.#streamObserver, parsed, text);
				this.#push(parsed);
			} catch (error) {
				notifyCodexWebSocketMalformed(this.#streamObserver, event.data, error);
				this.#push(new CodexWebSocketTransportError(`${String(error)}`));
			}
		};

		logger.time("codexWs:awaitTcpHandshake");
		try {
			await promise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async *streamRequest(
		request: Record<string, unknown>,
		/** `request` serialized: the frame sent. */
		requestPayload: string,
		timeouts: CodexWebSocketRequestTimeouts,
		signal?: AbortSignal,
		onSseEvent?: (event: RawSseEvent) => void,
	): AsyncGenerator<Record<string, unknown>> {
		this.#claimForRequest(signal, onSseEvent);
		const onAbort = () => {
			this.close("aborted");
			this.#push(new CodexWebSocketTransportError(`request was aborted`));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			await this.#sendRequest(request, requestPayload, onSseEvent);
			const frames = new CodexWebSocketResponseFrames(this.#lastSeenResponseId);
			const timeoutReason = () => frames.timeoutReason();
			while (true) {
				const next = await this.#nextMessage(frames.nextTimeoutMs(timeouts), timeoutReason);
				if (next instanceof Error) {
					throw next;
				}
				if (next === null) {
					throw new CodexWebSocketTransportError(`websocket closed before response completion`);
				}
				const eventType = typeof next.type === "string" ? next.type : "";
				const admission = frames.admit(next, eventType);
				this.#lastSeenResponseId = frames.lastSeenResponseId;
				if (admission === "drop") continue;
				if (admission !== "accept") {
					this.close("stale-frame");
					throw admission;
				}
				yield next;
				if (isCodexWebSocketTerminalEventType(eventType)) {
					break;
				}
			}
		} finally {
			this.#activeRequest = false;
			this.#streamObserver = undefined;
			signal?.removeEventListener("abort", onAbort);
			const debugResponseLog = this.#debugResponseLog;
			this.#debugResponseLog = undefined;
			await debugResponseLog?.close();
		}
	}

	/** Marks the connection busy with a request, after checking it can take one. */
	#claimForRequest(signal: AbortSignal | undefined, onSseEvent: ((event: RawSseEvent) => void) | undefined): void {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
			throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
		}
		if (this.#activeRequest) {
			throw new CodexWebSocketTransportError(`websocket request already in progress`);
		}
		if (signal?.aborted) {
			throw new CodexWebSocketTransportError(`request was aborted`);
		}
		this.#activeRequest = true;
		this.#streamObserver = onSseEvent;
		// Drain any non-error frames left over from a prior request before sending.
		// `CodexStreamProcessor.process` breaks its `for-await` on the terminal event,
		// which interrupts our generator at `yield next` (the post-yield `break`
		// never runs). Any frame that landed between the consumer's break and the
		// generator's `finally` lingers in `#queue` and would otherwise become the
		// first frame of THIS request — a stale `response.completed` would end the
		// turn immediately with empty output, and a stale non-progress frame would
		// flip `sawFirstEvent` and silently downgrade the first-event timeout to
		// the longer idle timeout. Transport errors are preserved so we surface
		// the death signal instead of writing into a dead socket.
		this.#dropStaleFrames();
	}

	/** Opens the request's debug log when request debugging is enabled, then sends the frame. */
	async #sendRequest(
		request: Record<string, unknown>,
		requestPayload: string,
		onSseEvent: ((event: RawSseEvent) => void) | undefined,
	): Promise<void> {
		const debugSession = isRequestDebugEnabled()
			? await createRequestDebugSession({
					protocol: "websocket",
					method: "POST",
					url: this.#url,
					headers: this.#headers,
					body: request,
				})
			: undefined;
		this.#debugResponseLog = debugSession
			? await debugSession.openResponseLog("WebSocket 101 Switching Protocols", this.#handshakeHeaders)
			: undefined;

		notifyCodexWebSocketOutbound(onSseEvent, request, requestPayload);
		// Re-check liveness: the debug-session await above can outlive the socket.
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new CodexWebSocketTransportError(`websocket connection is unavailable`);
		}
		try {
			socket.send(requestPayload);
		} catch (error) {
			throw new CodexWebSocketTransportError(`websocket send failed: ${errorMessage(error)}`);
		}
	}

	#captureHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): void {
		const headers = extractCodexWebSocketHandshakeHeaders(socket, openEvent);
		if (!headers) return;
		this.#handshakeHeaders = headers;
		this.#onHandshakeHeaders?.(headers);
	}

	#writeDebugWebSocketFrame(data: unknown): void {
		const log = this.#debugResponseLog;
		if (!log) return;
		if (typeof data === "string") {
			log.write(data);
			return;
		}
		if (data instanceof Uint8Array) {
			log.write(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			log.write(new Uint8Array(data));
			return;
		}
		log.write(String(data));
	}

	#startHeartbeat(socket: Bun.WebSocket): void {
		this.#stopHeartbeat();
		const intervalMs = CODEX_WEBSOCKET_PING_INTERVAL_MS;
		if (intervalMs <= 0) return;

		this.#lastPingAt = 0;
		const socketEventTarget = socket as EventTarget;
		const onPong = () => {
			// Pongs are inbound activity — refresh the reuse-health clock so a quiet
			// but ping-responsive socket stays trustworthy across requests.
			this.#lastInboundAt = Date.now();
		};
		if (
			typeof socketEventTarget.addEventListener === "function" &&
			typeof socketEventTarget.removeEventListener === "function"
		) {
			socketEventTarget.addEventListener("pong", onPong);
			this.#removePongListener = () => socketEventTarget.removeEventListener("pong", onPong);
		}

		this.#heartbeatInterval = setInterval(() => {
			if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) {
				this.#stopHeartbeat();
				return;
			}
			// Fail-closed on missing pongs even when no pong has ever been observed.
			// The previous `#observedPong &&` guard disabled the timeout entirely on
			// runtimes where Bun does not surface a `pong` event for our outgoing
			// pings (issue #1450) — letting truly dead sockets sail through the
			// pool until the per-request first-event / idle timeout (60–300 s)
			// finally fired. Instead, trigger on inbound silence: if we sent a
			// ping at least `pongTimeoutMs` ago and have received no traffic of
			// any kind (data frame or pong) since, the socket is unhealthy.
			const pongTimeoutMs = CODEX_WEBSOCKET_PONG_TIMEOUT_MS;
			if (
				pongTimeoutMs > 0 &&
				this.#lastPingAt > 0 &&
				this.#lastPingAt > this.#lastInboundAt &&
				Date.now() - this.#lastPingAt > pongTimeoutMs
			) {
				this.#failQueue(new CodexWebSocketTransportError(`websocket pong timeout`), "pong-timeout");
				return;
			}
			if (typeof socket.ping !== "function") {
				this.#stopHeartbeat();
				return;
			}
			try {
				socket.ping();
				this.#lastPingAt = Date.now();
			} catch (error) {
				this.#failQueue(
					new CodexWebSocketTransportError(`websocket ping failed: ${errorMessage(error)}`),
					"ping-failed",
				);
			}
		}, intervalMs);
		this.#heartbeatInterval.unref();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatInterval) {
			clearInterval(this.#heartbeatInterval);
			this.#heartbeatInterval = undefined;
		}
		if (this.#removePongListener) {
			this.#removePongListener();
			this.#removePongListener = undefined;
		}
		this.#lastPingAt = 0;
	}

	#failQueue(error: Error, closeReason: string): void {
		CODEX_DEBUG && logger.debug("[codex] codex websocket transport failure", { error: error.message, closeReason });
		this.#queue.length = 0;
		this.#queue.push(error);
		this.close(closeReason);
		this.#wakeWaiters();
	}

	/**
	 * Discard data frames from a previous request that remained in `#queue`
	 * after the consumer broke out on the terminal event. Preserves any queued
	 * transport error (from `onerror` / `onclose` / `#failQueue`) so the next
	 * `#nextMessage` surfaces the death signal instead of waiting it out.
	 *
	 * Returns the number of frames dropped (test/debug visibility only).
	 */
	#dropStaleFrames(): number {
		if (this.#queue.length === 0) return 0;
		const surviving = this.#queue.filter(item => item instanceof Error);
		const dropped = this.#queue.length - surviving.length;
		if (dropped === 0) return 0;
		this.#queue.length = 0;
		for (const item of surviving) this.#queue.push(item);
		CODEX_DEBUG && logger.debug("[codex] codex websocket dropped stale frames before request", { dropped });
		return dropped;
	}

	#wakeWaiters(): void {
		for (;;) {
			const waiter = this.#waiters.shift();
			if (!waiter) break;
			waiter();
		}
	}

	#push(item: Record<string, unknown> | Error | null): void {
		if (item instanceof Error) {
			// Append after frames already received instead of wiping them: a queued
			// terminal event (e.g. `response.completed` followed by an eager server
			// close) must still reach the consumer rather than morph into a spurious
			// transport failure. `#dropStaleFrames` keeps errors across requests, so
			// the death signal still surfaces if the data frames go unconsumed.
			this.#queue.push(item);
			this.#wakeWaiters();
			return;
		}
		if (item !== null && this.#queue.length >= CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY) {
			this.#failQueue(
				new CodexWebSocketTransportError(
					`websocket message queue exceeded ${CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY} items`,
				),
				"queue-overflow",
			);
			return;
		}
		this.#queue.push(item);
		const waiter = this.#waiters.shift();
		if (waiter) waiter();
	}

	async #nextMessage(
		timeoutMs: number | undefined,
		// Built when the deadline fires, not when the wait starts: the message
		// reports how long ago the last progress was, and a value computed before
		// a 300 s wait reported "31087ms ago" for a stall of five minutes.
		timeoutReason: () => string,
	): Promise<Record<string, unknown> | Error | null> {
		while (this.#queue.length === 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#waiters.push(resolve);
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeout = setTimeout(() => {
					timedOut = true;
					const waiterIndex = this.#waiters.indexOf(resolve);
					if (waiterIndex >= 0) {
						this.#waiters.splice(waiterIndex, 1);
					}
					resolve();
				}, timeoutMs);
			}
			await promise;
			if (timeout) clearTimeout(timeout);
			if (timedOut && this.#queue.length === 0) {
				return new CodexWebSocketTransportError(timeoutReason());
			}
		}
		return this.#queue.shift() ?? null;
	}
}

export async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	url: string,
	headers: Headers,
	signal?: AbortSignal,
): Promise<CodexWebSocketConnection> {
	const headerRecord = headersToRecord(headers);
	// Join an in-flight handshake instead of tearing it down: closing a
	// CONNECTING socket rejects the concurrent caller (prewarm racing the first
	// request) with a fatal "websocket closed before open", which would disable
	// websockets for the entire session.
	// Bounded re-join: a fresh handshake may have been started by yet another
	// caller while we awaited the previous one.
	for (let joinAttempt = 0; joinAttempt < 3; joinAttempt += 1) {
		const pending = state.connection;
		if (!pending || pending.isOpen() || !pending.isConnecting()) break;
		try {
			await pending.connect(signal);
		} catch {
			// The handshake owner surfaces its own failure; re-evaluate below
			// (state.connection may have been replaced or cleared).
		}
	}
	if (state.connection?.isOpen()) {
		if (!state.connection.matchesAuth(headerRecord)) {
			state.connection.close("token-refresh");
			resetCodexWebSocketAppendState(state);
		} else if (state.connection.isHealthyForReuse()) {
			logger.time("codexWs:reuseOpenSocket");
			return state.connection;
		} else {
			// Open in readyState but no inbound traffic recently — likely server-
			// evicted (issue #1450). Force a fresh handshake instead of writing
			// `response.create` into a half-open buffer and waiting out the
			// first-event timeout. Drop append state because the new socket
			// won't carry the prior `previous_response_id` context.
			CODEX_DEBUG && logger.debug("[codex] codex websocket reuse rejected by health check", {});
			state.connection.close("stale-reuse");
			resetCodexWebSocketAppendState(state);
		}
	}
	state.connection?.close("reconnect");
	resetCodexWebSocketAppendState(state);
	logger.time("codexWs:newSocket");
	state.connection = new CodexWebSocketConnection(url, headerRecord, {
		onHandshakeHeaders: handshakeHeaders => {
			updateCodexSessionMetadataFromHeaders(state, handshakeHeaders);
		},
	});
	await state.connection.connect(signal);
	return state.connection;
}
