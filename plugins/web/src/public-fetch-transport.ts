import * as dns from "node:dns/promises";
import { connect as netConnect, isIP, type Socket as NetSocket } from "node:net";
import * as tls from "node:tls";

/**
 * Transport for the public HTTPS fetch. The caller vets every address before it
 * reaches `get`; this module only pins the vetted address and speaks HTTP/1.1.
 *
 * Why not `fetch`: a Workers `fetch` cannot connect to a chosen IP, so a name
 * checked by DNS could resolve again to a private address before the connection
 * opens. The connection dials the vetted address over TCP, then runs TLS over
 * that socket with the original name as `servername`: one dial, no second lookup.
 * The TCP dial and the TLS wrap are separate calls on purpose; see
 * `connectWithNodeTls`.
 */

/** Response head larger than this fails the request before the body starts. */
const MAX_HEAD_BYTES = 32 * 1024;
/** Largest slice handed to the body stream in one read. */
const MAX_BODY_SLICE = 64 * 1024;
/** Above this many buffered bytes the socket pauses until the consumer drains them. */
const HIGH_WATER_BYTES = 256 * 1024;
const LOW_WATER_BYTES = 64 * 1024;
/** Longest chunk-size or trailer line accepted. */
const MAX_LINE_BYTES = 1024;
const HTTPS_PORT = 443;
const REQUEST_ACCEPT = "text/html, application/xhtml+xml, text/plain;q=0.9, text/markdown;q=0.8, application/json;q=0.7";

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DIGITS = /^[0-9]+$/;
const STATUS_LINE = /^HTTP\/1\.[01] ([0-9]{3})(?: (.*))?$/;
const REASON_PHRASE = /^[\t \x21-\x7e\x80-\xff]*$/;
const CHUNK_SIZE_LINE = /^([0-9A-Fa-f]{1,15})(?:[ \t]*;.*)?$/;

export interface PublicFetchTransport {
	/** Resolves the A and AAAA records of `hostname`. Each address still needs vetting by the caller. */
	resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
	/** Sends one GET to the vetted `address`, naming `url.hostname` for SNI and certificate checks. */
	get(url: URL, address: string, signal: AbortSignal): Promise<Response>;
}

/**
 * The part of a TLS socket the transport uses. The test seam implements exactly
 * this, so a fake socket needs no network.
 */
export interface PinnedTlsSocket {
	on(event: "data" | "end" | "close" | "error", listener: (...args: never[]) => void): unknown;
	write(data: Uint8Array | string): unknown;
	pause(): unknown;
	resume(): unknown;
	destroy(error?: Error): unknown;
}

/** The event surface the connect adapter waits on. `net.Socket` and `tls.TLSSocket` both satisfy it. */
export interface Emitter {
	once(event: string, listener: (...args: never[]) => void): unknown;
	removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

/** A TLS socket the adapter waits on before it hands the socket to the transport. */
export type TlsSocketLike = PinnedTlsSocket & Emitter;

/** What `fetchPinned` asks of the connection: dial the vetted address, verify the original name. */
export interface PinnedDial {
	host: string;
	servername: string;
	port: number;
	rejectUnauthorized: true;
}

/** Resolves to a verified TLS socket, or rejects on dial, handshake, close or abort. */
export type PinnedTlsConnect = (dial: PinnedDial, signal: AbortSignal) => PinnedTlsSocket | Promise<PinnedTlsSocket>;

/** The Node calls the adapter makes. Production passes `node:net` and `node:tls`; tests inject fakes. */
export interface NodeTlsFactories {
	dial: (options: { host: string; port: number }) => NetSocket;
	wrap: (options: tls.ConnectionOptions & { socket: NetSocket }) => TlsSocketLike;
}

/**
 * Builds the concrete Node TLS transport. `connect` defaults to the production
 * adapter over `node:net` and `node:tls`; tests pass a fake socket factory.
 */
export function createNodePublicFetchTransport(connect: PinnedTlsConnect = connectWithNodeTls): PublicFetchTransport {
	return {
		resolve: resolveAddresses,
		get: (url, address, signal) => fetchPinned(connect, url, address, signal),
	};
}

/**
 * The production connect. It dials the vetted address over TCP, then wraps that
 * socket in TLS with the original name. The two calls stay separate because
 * Workers' direct `tls.connect({ host })` drops `servername`: cloudflare/workerd
 * `src/node/internal/internal_net.ts` passes only `allowHalfOpen` and
 * `secureTransport` to the runtime connect, so the certificate is checked against
 * the IP. Over a socket, `tls.connect({ socket, servername })` takes the STARTTLS
 * path, which passes `servername` as `expectedServerHostname`
 * (`internal_tls_wrap.ts`, `_start`). Node documents the `socket` option for this.
 * `rejectUnauthorized` stays `true`.
 */
const connectWithNodeTls: PinnedTlsConnect = pinnedTlsOver({
	dial: (options) => netConnect(options),
	wrap: (options) => tls.connect(options),
});

/**
 * Builds a `PinnedTlsConnect` from a raw dial and a TLS wrap. It resolves only
 * after the handshake, so no request byte leaves before the peer is verified.
 * An error, a close or an abort at any step destroys the raw and TLS sockets.
 */
export function pinnedTlsOver(factories: NodeTlsFactories): PinnedTlsConnect {
	return async (dial, signal) => {
		signal.throwIfAborted();
		const attempt = new AbortController();
		const onCallerAbort = (): void => attempt.abort(signal.reason);
		signal.addEventListener("abort", onCallerAbort, { once: true });
		const raw = factories.dial({ host: dial.host, port: dial.port });
		let secure: TlsSocketLike | undefined;
		let established = false;
		// Attached synchronously after the dial, before any wait, and kept for the life of the raw
		// socket. Node throws on an `error` with no listener, so no window may lack one.
		raw.on("error", (error) => {
			if (established) secure?.destroy(error);
			else attempt.abort(error);
		});
		try {
			// The TCP connect comes first, so the TLS upgrade runs on an open socket.
			await untilReady(raw, "connect", attempt.signal);
			secure = factories.wrap({ socket: raw, servername: dial.servername, rejectUnauthorized: dial.rejectUnauthorized });
			await untilReady(secure, "secureConnect", attempt.signal);
			established = true;
			return secure;
		} catch (error) {
			secure?.destroy();
			raw.destroy();
			throw error;
		} finally {
			signal.removeEventListener("abort", onCallerAbort);
		}
	};
}

/** Resolves on `ready`. Rejects with the `error`, on `close`, or with the abort reason, whichever comes first. */
function untilReady(socket: Emitter, ready: string, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const settle = (): void => {
		socket.removeListener(ready, onReady);
		socket.removeListener("error", onError);
		socket.removeListener("close", onClose);
		signal.removeEventListener("abort", onAbort);
	};
	const onReady = (): void => {
		settle();
		resolve();
	};
	const onError = (error: Error): void => {
		settle();
		reject(error);
	};
	const onClose = (): void => {
		settle();
		reject(new Error(`socket closed before ${ready}`));
	};
	const onAbort = (): void => {
		settle();
		reject(signal.reason);
	};
	socket.once(ready, onReady);
	socket.once("error", onError);
	socket.once("close", onClose);
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	return promise;
}

async function resolveAddresses(hostname: string, signal: AbortSignal): Promise<readonly string[]> {
	signal.throwIfAborted();
	const [ipv4, ipv6] = await untilAborted(
		Promise.all([dns.resolve4(hostname).catch(noRecordOf), dns.resolve6(hostname).catch(noRecordOf)]),
		signal,
	);
	const addresses = [...ipv4, ...ipv6];
	if (addresses.length === 0) throw new Error(`DNS for ${hostname} has no A or AAAA records`);
	return addresses;
}

/** A name with no record of one family is normal. Any other DNS error (SERVFAIL, timeout, NXDOMAIN) is a failure. */
function noRecordOf(error: unknown): string[] {
	if (error instanceof Error && "code" in error && error.code === "ENODATA") return [];
	throw error;
}

/** Node's `dns/promises` takes no signal, so the abort is raced against the query. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([work, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

async function fetchPinned(connect: PinnedTlsConnect, url: URL, address: string, signal: AbortSignal): Promise<Response> {
	signal.throwIfAborted();
	requireDirectHttps(url);
	const socket = await connect({ host: address, servername: url.hostname, port: HTTPS_PORT, rejectUnauthorized: true }, signal);
	const wire = new SocketReader(socket, signal);
	try {
		socket.write(
			[
				`GET ${url.pathname}${url.search} HTTP/1.1`,
				`Host: ${url.host}`,
				`Accept: ${REQUEST_ACCEPT}`,
				"Accept-Encoding: identity",
				"Connection: close",
				"",
				"",
			].join("\r\n"),
		);
		const head = parseHead(await wire.readHead());
		const mode = bodyModeFor(head);
		if (mode === undefined) {
			wire.close();
			return new Response(null, { status: head.status, statusText: head.reason, headers: headersOf(head) });
		}
		const decoder = new BodyDecoder(wire, mode);
		const body = new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					try {
						const piece = await decoder.next();
						if (piece === undefined) {
							wire.close();
							controller.close();
						} else {
							controller.enqueue(piece);
						}
					} catch (error) {
						wire.close();
						controller.error(error);
					}
				},
				cancel: () => wire.close(),
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, {
			status: head.status,
			statusText: head.reason,
			headers: headersOf(head),
		});
	} catch (error) {
		wire.close();
		throw error;
	}
}

/** Refuses anything the pinned connection cannot honour: a non-default port, URL credentials or an IP literal for TLS naming. */
function requireDirectHttps(url: URL): void {
	if (url.protocol !== "https:") throw new Error("public fetch requires an https URL");
	if (url.port !== "") throw new Error("public fetch connects only to port 443");
	if (url.username !== "" || url.password !== "") throw new Error("public fetch refuses URL credentials");
	if (url.hostname.startsWith("[") || isIP(url.hostname) !== 0) {
		throw new Error("public fetch needs a DNS name for TLS certificate verification");
	}
}

interface Field {
	/** Lower-cased header name. */
	name: string;
	value: string;
}

interface ParsedHead {
	status: number;
	reason: string;
	fields: Field[];
}

/** Parses a status line and header fields. Fails closed on anything it does not recognise. */
function parseHead(head: string): ParsedHead {
	if (/[\r\n]/.test(head.replace(/\r\n/g, ""))) throw new Error("bare CR or LF in response headers");
	const [statusLine = "", ...lines] = head.split("\r\n");
	const match = STATUS_LINE.exec(statusLine);
	if (match === null) throw new Error("malformed HTTP status line");
	const status = Number(match[1]);
	if (status < 200) throw new Error("informational responses are not supported");
	if (status > 599) throw new Error(`unsupported HTTP status ${status}`);
	const reason = match[2] ?? "";
	if (!REASON_PHRASE.test(reason)) throw new Error("malformed HTTP reason phrase");
	return { status, reason, fields: lines.map(parseField) };
}

function parseField(line: string): Field {
	if (line.startsWith(" ") || line.startsWith("\t")) throw new Error("obsolete header line folding is refused");
	const colon = line.indexOf(":");
	if (colon <= 0) throw new Error("malformed header line");
	const name = line.slice(0, colon);
	if (!TOKEN.test(name)) throw new Error("malformed header name");
	return { name: name.toLowerCase(), value: line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "") };
}

function headersOf(head: ParsedHead): Headers {
	const headers = new Headers();
	for (const field of head.fields) headers.append(field.name, field.value);
	return headers;
}

type BodyMode = { kind: "length"; remaining: number } | { kind: "chunked" } | { kind: "close" };

/**
 * Decides how the body ends, or returns undefined when there is no body. Ambiguous
 * or unsupported framing throws, so a response is never read with the wrong length.
 */
function bodyModeFor(head: ParsedHead): BodyMode | undefined {
	for (const field of head.fields) {
		if (field.name === "content-encoding" && field.value.toLowerCase() !== "identity") {
			throw new Error("compressed responses are refused; the request asks for identity encoding");
		}
	}
	const transfer = head.fields.filter((field) => field.name === "transfer-encoding");
	const length = head.fields.filter((field) => field.name === "content-length");
	if (transfer.length > 0 && length.length > 0) {
		throw new Error("response carries both Transfer-Encoding and Content-Length");
	}
	if (transfer.length > 1 || (transfer.length === 1 && transfer[0]?.value.toLowerCase() !== "chunked")) {
		throw new Error("unsupported Transfer-Encoding");
	}
	if (length.length > 1) throw new Error("response carries more than one Content-Length");

	let mode: BodyMode = { kind: "close" };
	if (transfer.length === 1) {
		mode = { kind: "chunked" };
	} else if (length.length === 1) {
		const value = length[0]?.value ?? "";
		const remaining = Number(value);
		if (!DIGITS.test(value) || !Number.isSafeInteger(remaining)) throw new Error("malformed Content-Length");
		mode = { kind: "length", remaining };
	}
	if (head.status === 204 || head.status === 304) return undefined;
	if (mode.kind === "length" && mode.remaining === 0) return undefined;
	return mode;
}

/** Reads a chunked or length-delimited or close-delimited body one bounded slice at a time. */
class BodyDecoder {
	readonly #wire: SocketReader;
	#mode: BodyMode;
	#chunkLeft = 0;
	#finished = false;

	constructor(wire: SocketReader, mode: BodyMode) {
		this.#wire = wire;
		this.#mode = mode;
	}

	/** Returns the next payload slice, or undefined once the body is complete. */
	async next(): Promise<Buffer | undefined> {
		if (this.#finished) return undefined;
		const piece = await this.#read();
		if (piece === undefined) this.#finished = true;
		return piece;
	}

	#read(): Promise<Buffer | undefined> {
		if (this.#mode.kind === "length") return this.#readLength(this.#mode);
		if (this.#mode.kind === "chunked") return this.#readChunked();
		return this.#wire.readSome(MAX_BODY_SLICE);
	}

	async #readLength(mode: { kind: "length"; remaining: number }): Promise<Buffer | undefined> {
		if (mode.remaining === 0) return undefined;
		const piece = await this.#wire.readSome(Math.min(mode.remaining, MAX_BODY_SLICE));
		if (piece === undefined) throw new Error("connection closed before the Content-Length body was complete");
		mode.remaining -= piece.length;
		return piece;
	}

	async #readChunked(): Promise<Buffer | undefined> {
		while (this.#chunkLeft === 0) {
			const size = parseChunkSize(await this.#wire.readLine(MAX_LINE_BYTES));
			if (size === 0) {
				await this.#skipTrailers();
				return undefined;
			}
			this.#chunkLeft = size;
		}
		const piece = await this.#wire.readSome(Math.min(this.#chunkLeft, MAX_BODY_SLICE));
		if (piece === undefined) throw new Error("connection closed inside a chunk");
		this.#chunkLeft -= piece.length;
		if (this.#chunkLeft === 0 && (await this.#wire.readLine(MAX_LINE_BYTES)).length !== 0) {
			throw new Error("chunk data is not followed by CRLF");
		}
		return piece;
	}

	/** Consumes the trailer section up to its blank line. Trailer fields are validated for shape and discarded. */
	async #skipTrailers(): Promise<void> {
		let bytes = 0;
		for (;;) {
			const line = await this.#wire.readLine(MAX_HEAD_BYTES - bytes);
			if (line.length === 0) return;
			if (!line.includes(":")) throw new Error("malformed chunked trailer line");
			bytes += line.length + 2;
		}
	}
}

function parseChunkSize(line: Buffer): number {
	const digits = CHUNK_SIZE_LINE.exec(line.toString("latin1"))?.[1];
	if (digits === undefined) throw new Error("malformed chunk size line");
	const size = Number.parseInt(digits, 16);
	if (!Number.isSafeInteger(size)) throw new Error("chunk size is out of range");
	return size;
}

/**
 * Turns socket events into pull-based reads with bounded buffering. A failure, an
 * abort or a close destroys the socket, and every pending read then throws.
 */
class SocketReader {
	readonly #socket: PinnedTlsSocket;
	readonly #signal: AbortSignal;
	readonly #onAbort = (): void => this.#fail(this.#signal.reason ?? new Error("public fetch aborted"));
	readonly #chunks: Buffer[] = [];
	#queued = 0;
	#pending: Buffer = Buffer.alloc(0);
	#ended = false;
	#closed = false;
	#failure: { error: unknown } | undefined;
	#waiter: PromiseWithResolvers<void> | undefined;

	constructor(socket: PinnedTlsSocket, signal: AbortSignal) {
		this.#socket = socket;
		this.#signal = signal;
		socket.on("data", (chunk: Buffer) => {
			if (this.#failure !== undefined || this.#closed) return;
			this.#chunks.push(chunk);
			this.#queued += chunk.length;
			if (this.#queued > HIGH_WATER_BYTES) socket.pause();
			this.#wake();
		});
		socket.on("end", () => this.#finish());
		socket.on("close", () => this.#finish());
		socket.on("error", (error: Error) => this.#fail(error));
		signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	/** Reads the status line and header fields, bounded by {@link MAX_HEAD_BYTES}. */
	async readHead(): Promise<string> {
		for (;;) {
			const end = this.#pending.indexOf("\r\n\r\n");
			if (end !== -1) {
				if (end > MAX_HEAD_BYTES) throw new Error("response headers exceed 32 KiB");
				const head = this.#pending.subarray(0, end).toString("latin1");
				this.#pending = this.#pending.subarray(end + 4);
				return head;
			}
			if (this.#pending.length > MAX_HEAD_BYTES) throw new Error("response headers exceed 32 KiB");
			if (!(await this.#fill())) throw new Error("connection closed before the response headers ended");
		}
	}

	/** Reads one CRLF-terminated line of at most `max` bytes, without the CRLF. */
	async readLine(max: number): Promise<Buffer> {
		for (;;) {
			const end = this.#pending.indexOf("\r\n");
			if (end !== -1) {
				if (end > max) throw new Error("line exceeds its length limit");
				const line = this.#pending.subarray(0, end);
				this.#pending = this.#pending.subarray(end + 2);
				return line;
			}
			if (this.#pending.length > max + 1) throw new Error("line exceeds its length limit");
			if (!(await this.#fill())) throw new Error("connection closed in the middle of a line");
		}
	}

	/** Returns between 1 and `max` buffered bytes, waiting for the socket if none are buffered. */
	async readSome(max: number): Promise<Buffer | undefined> {
		while (this.#pending.length === 0) {
			if (!(await this.#fill())) return undefined;
		}
		const take = Math.min(max, this.#pending.length);
		const piece = this.#pending.subarray(0, take);
		this.#pending = this.#pending.subarray(take);
		return piece;
	}

	/** Destroys the socket. Safe to call more than once. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#signal.removeEventListener("abort", this.#onAbort);
		this.#chunks.length = 0;
		this.#queued = 0;
		this.#pending = Buffer.alloc(0);
		this.#failure ??= { error: new Error("response body was closed") };
		this.#wake();
		this.#socket.destroy();
	}

	async #fill(): Promise<boolean> {
		const chunk = await this.#nextChunk();
		if (chunk === undefined) return false;
		this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
		return true;
	}

	async #nextChunk(): Promise<Buffer | undefined> {
		for (;;) {
			if (this.#failure !== undefined) throw this.#failure.error;
			const chunk = this.#chunks.shift();
			if (chunk !== undefined) {
				this.#queued -= chunk.length;
				if (this.#queued <= LOW_WATER_BYTES) this.#socket.resume();
				return chunk;
			}
			if (this.#ended) return undefined;
			this.#waiter ??= Promise.withResolvers<void>();
			await this.#waiter.promise;
		}
	}

	#finish(): void {
		if (this.#failure !== undefined || this.#ended) return;
		this.#ended = true;
		this.#wake();
	}

	#fail(error: unknown): void {
		if (this.#failure !== undefined || this.#ended) return;
		this.#failure = { error };
		this.#socket.destroy();
		this.#wake();
	}

	#wake(): void {
		const waiter = this.#waiter;
		this.#waiter = undefined;
		waiter?.resolve();
	}
}
