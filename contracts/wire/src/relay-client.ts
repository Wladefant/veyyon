/**
 * The client half of the collab relay protocol: one WebSocket to a relay room, sealed frames sent and
 * delivered in order, and reconnects that survive a transient drop.
 *
 * Three programs join a room this way, the CLI host, the CLI guest and the browser guest. Each needs the
 * same answers: which close codes end the session ({@link RELAY_FATAL_CLOSE_REASONS}), how many frames to
 * hold while reconnecting ({@link RELAY_MAX_PENDING_SENDS}), when a slow socket is full, and that frames
 * leave and arrive in the order they were sent. The CLI and the browser each kept a copy of this class,
 * and the copies drifted: only the CLI's held back sends while the socket's own buffer was full. So the
 * client is written once here, and each side binds only its frame types and its environment
 * (`collab/relay-client.ts` in `@veyyon/coding-agent`, `lib/socket.ts` in `@veyyon/collab-web`).
 *
 * Only sibling modules are imported. The two things a contract cannot reach, the reconnect backoff
 * schedule and a log sink, are passed in.
 */
import { openFrame, packEnvelope, sealFrame, unpackEnvelope } from "./index";
import { RELAY_FATAL_CLOSE_REASONS, RELAY_MAX_PENDING_SENDS, type RelayControlMessage } from "./relay";

/** Bytes queued in the WebSocket at which a new send waits in the pending buffer instead. */
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
/** Bytes queued in the WebSocket below which the pending buffer drains again. */
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
/** Delay before a backpressured socket is checked again. */
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

/**
 * Where the client reports a frame it dropped or a message it could not use. `warn` is a fault in a peer
 * or in a listener; `debug` is routine, such as a send after close.
 */
export type RelayClientLog = (level: "debug" | "warn", message: string, detail?: Record<string, unknown>) => void;

export interface RelayClientOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	/** Room key; a pending import is awaited inside the seal and open chains. */
	key: CryptoKey | PromiseLike<CryptoKey>;
	/** Delay in milliseconds before reconnect attempt `attempt`, counted from 0. */
	retryDelayMs: (attempt: number) => number;
	log?: RelayClientLog;
}

/** A relay room connection that sends `Send` frames and receives `Receive` frames. */
export class RelayClient<Send extends { t: string }, Receive> {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: Receive, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/** Fires once per terminal close (intentional, fatal code, or bad key). willReconnect=true for transient drops that will retry. */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: RelayClientOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#backpressureDrainTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Envelopes sealed while disconnected or backpressured, flushed in order. */
	#pendingSends: Uint8Array<ArrayBuffer>[] = [];

	constructor(opts: RelayClientOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	send(frame: Send, targetPeer = 0): void {
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) {
					this.#opts.log?.("debug", "collab: dropping frame, socket closed", { t: frame.t });
					return;
				}
				const openWs = this.#ws;
				if (openWs && openWs.readyState === WebSocket.OPEN) this.#drainPendingSends(openWs);
				const sealed = await sealFrame(await this.#opts.key, frame);
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					if (this.#pendingSends.length > 0) {
						this.#enqueuePendingSend(envelope, frame.t);
						if (ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD) {
							this.#drainPendingSends(ws);
						} else {
							this.#scheduleBackpressureDrain(ws);
						}
						return;
					}
					if (ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) {
						this.#enqueuePendingSend(envelope, frame.t);
						this.#scheduleBackpressureDrain(ws);
						return;
					}
					ws.send(envelope);
					return;
				}
				this.#enqueuePendingSend(envelope, frame.t);
			})
			.catch((error: unknown) => {
				this.#opts.log?.("debug", "collab: send failed", { error });
			});
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		this.#clearBackpressureDrain();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#enqueuePendingSend(envelope: Uint8Array<ArrayBuffer>, frameType: string): void {
		if (this.#pendingSends.length >= RELAY_MAX_PENDING_SENDS) {
			this.#opts.log?.("debug", "collab: dropping frame, reconnect buffer full", { t: frameType });
			return;
		}
		this.#pendingSends.push(envelope);
	}

	#drainPendingSends(ws: WebSocket): void {
		while (
			this.#pendingSends.length > 0 &&
			ws.readyState === WebSocket.OPEN &&
			ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD
		) {
			const envelope = this.#pendingSends.shift();
			if (!envelope) return;
			ws.send(envelope);
		}
	}

	#scheduleBackpressureDrain(ws: WebSocket): void {
		if (this.#backpressureDrainTimer !== undefined) return;
		this.#backpressureDrainTimer = setTimeout(() => {
			this.#backpressureDrainTimer = undefined;
			this.#sendChain = this.#sendChain
				.then(async () => {
					if (this.#closed || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
					this.#drainPendingSends(ws);
					if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
				})
				.catch((error: unknown) => {
					this.#opts.log?.("debug", "collab: backpressure drain failed", { error });
				});
		}, WS_BACKPRESSURE_DRAIN_RETRY_MS);
	}

	#clearBackpressureDrain(): void {
		if (this.#backpressureDrainTimer !== undefined) {
			clearTimeout(this.#backpressureDrainTimer);
			this.#backpressureDrainTimer = undefined;
		}
	}

	#openSocket(): void {
		this.#clearBackpressureDrain();
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			if (this.#pendingSends.length > 0) {
				this.#drainPendingSends(ws);
				if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
			}
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#clearBackpressureDrain();
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				this.#opts.log?.("warn", "collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) {
			this.#opts.log?.("warn", "collab: ignoring binary message of unexpected shape");
			return;
		}
		const envelope = unpackEnvelope(bytes);
		if (!envelope) {
			this.#opts.log?.("warn", "collab: ignoring truncated envelope");
			return;
		}
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: Receive;
				try {
					frame = await openFrame<Receive>(await this.#opts.key, envelope.payload);
				} catch {
					this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch((error: unknown) => {
				// Keep the receive chain alive, but a throwing frame listener is an app bug to report, not a
				// frame to drop silently.
				this.#opts.log?.("warn", "collab: frame listener threw; frame dropped", { error });
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		this.#clearBackpressureDrain();
		const fatalReason = RELAY_FATAL_CLOSE_REASONS[code];
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#pendingSends.length = 0;
			this.onClose?.(fatalReason, false);
			return;
		}
		this.onClose?.(reason || `connection lost (code ${code})`, true);
		this.#scheduleRetry();
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		this.#clearBackpressureDrain();
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(): void {
		const delay = this.#opts.retryDelayMs(this.#attempt);
		this.#attempt++;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
