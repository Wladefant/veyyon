import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { Socket as NetSocket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConnectionOptions } from "node:tls";
import {
	createNodePublicFetchTransport,
	pinnedTlsOver,
	type PinnedDial,
	type PinnedTlsSocket,
	type PublicFetchTransport,
	type TlsSocketLike,
} from "@veyyon/web/public-fetch-transport";

/**
 * Locks the pinned public fetch transport. The fake socket replaces `node:tls`
 * through the connect seam, so no network or server runs. Each test defends one
 * contract: the dial pins the vetted address while TLS names the original host,
 * the request carries no credentials and asks for identity encoding, each
 * supported framing decodes, each unsupported or ambiguous framing fails closed,
 * and aborting or cancelling destroys the socket.
 *
 * The fake emits its scripted bytes as separate socket reads, so a chunked body
 * split mid-size-line exercises the parser's buffering. It cannot reproduce TLS
 * truncation without a close_notify, so a close-delimited body that the peer cut
 * short is not covered here.
 */

const VETTED_ADDRESS = "203.0.113.7";
const SOURCE = new URL("https://example.com/docs/page?id=7");

/** Records every dial and hands back a scripted socket for it. */
class FakeTlsSocket implements PinnedTlsSocket {
	readonly written: string[] = [];
	destroyed = false;
	readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
	readonly #reply: ReadonlyArray<string | Buffer>;
	readonly #endAfterReply: boolean;
	#served = false;

	constructor(reply: ReadonlyArray<string | Buffer>, endAfterReply: boolean) {
		this.#reply = reply;
		this.#endAfterReply = endAfterReply;
	}

	on(event: "data" | "end" | "close" | "error", listener: (...args: never[]) => void): unknown {
		const listeners = this.#listeners.get(event) ?? [];
		listeners.push(listener as (...args: unknown[]) => void);
		this.#listeners.set(event, listeners);
		return this;
	}

	write(data: Uint8Array | string): unknown {
		this.written.push(typeof data === "string" ? data : Buffer.from(data).toString("latin1"));
		if (!this.#served) {
			this.#served = true;
			queueMicrotask(() => this.#serve());
		}
		return true;
	}

	pause(): unknown {
		return this;
	}

	resume(): unknown {
		return this;
	}

	destroy(): unknown {
		this.destroyed = true;
		queueMicrotask(() => this.#emit("close"));
		return this;
	}

	#serve(): void {
		for (const piece of this.#reply) {
			if (this.destroyed) return;
			this.#emit("data", typeof piece === "string" ? Buffer.from(piece) : piece);
		}
		if (this.#endAfterReply && !this.destroyed) {
			this.#emit("end");
			this.#emit("close");
		}
	}

	#emit(event: string, ...args: unknown[]): void {
		for (const listener of this.#listeners.get(event) ?? []) listener(...args);
	}
}

interface Dial {
	options: ConnectionOptions;
	socket: FakeTlsSocket;
}

function harnessWith(reply: ReadonlyArray<string | Buffer>, endAfterReply = true): { transport: PublicFetchTransport; dials: Dial[] } {
	const dials: Dial[] = [];
	const transport = createNodePublicFetchTransport((options) => {
		const socket = new FakeTlsSocket(reply, endAfterReply);
		dials.push({ options, socket });
		return socket;
	});
	return { transport, dials };
}

/** A complete HTTP/1.1 response: the head lines, a blank line, then the body. */
function httpReply(head: readonly string[], body = ""): string {
	return `${head.join("\r\n")}\r\n\r\n${body}`;
}

describe("public fetch transport dials the vetted address", () => {
	it("connects to the vetted address while TLS names the original host", async () => {
		const { transport, dials } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Length: 2"], "ok")]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		await response.text();
		expect(dials).toHaveLength(1);
		expect(dials[0]?.options).toEqual({
			host: VETTED_ADDRESS,
			servername: "example.com",
			port: 443,
			rejectUnauthorized: true,
		});
	});

	it("refuses an IP literal as the TLS name, because a certificate cannot be checked against it", async () => {
		const { transport, dials } = harnessWith([]);
		await expect(transport.get(new URL("https://203.0.113.9/"), VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
		expect(dials).toHaveLength(0);
	});
});

describe("public fetch transport sends a bounded identity GET", () => {
	it("sends one HTTP/1.1 GET with identity encoding and no credentials", async () => {
		const { transport, dials } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Length: 0"])]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		await response.text();
		const request = dials[0]?.socket.written.join("") ?? "";
		expect(request.startsWith("GET /docs/page?id=7 HTTP/1.1\r\n")).toBe(true);
		expect(request).toContain("\r\nHost: example.com\r\n");
		expect(request).toContain("\r\nAccept-Encoding: identity\r\n");
		expect(request.endsWith("\r\n\r\n")).toBe(true);
		expect(request.toLowerCase()).not.toContain("cookie:");
		expect(request.toLowerCase()).not.toContain("authorization:");
	});

	it("returns the status, reason, headers and a content-length body", async () => {
		const { transport } = harnessWith([
			httpReply(["HTTP/1.1 200 OK", "Content-Type: text/plain; charset=utf-8", "Content-Length: 5"], "hello"),
		]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		expect(response.status).toBe(200);
		expect(response.statusText).toBe("OK");
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(await response.text()).toBe("hello");
	});

	it("decodes a chunked body whose bytes arrive split across socket reads", async () => {
		const { transport } = harnessWith([
			"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWi",
			"ki\r\n5\r\npedia\r\n",
			"0\r\n\r\n",
		]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		expect(await response.text()).toBe("Wikipedia");
	});

	it("reads a close-delimited body until the peer closes", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Type: text/plain"], "until close")]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		expect(await response.text()).toBe("until close");
	});

	it("returns no body for 304 Not Modified", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 304 Not Modified", "ETag: \"v1\""])]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		expect(response.status).toBe(304);
		expect(response.body).toBeNull();
	});
});

describe("public fetch transport fails closed on framing it cannot honour", () => {
	it("refuses a compressed response", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Encoding: gzip", "Content-Length: 0"])]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses a Transfer-Encoding that is not exactly chunked", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Transfer-Encoding: gzip, chunked"], "0\r\n\r\n")]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses Content-Length and Transfer-Encoding together", async () => {
		const { transport } = harnessWith([
			httpReply(["HTTP/1.1 200 OK", "Transfer-Encoding: chunked", "Content-Length: 5"], "0\r\n\r\n"),
		]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses two Content-Length headers even when they agree", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Length: 2", "Content-Length: 2"], "ok")]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses a Content-Length that is not plain digits", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Length: +2"], "ok")]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses an informational 1xx status line", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 100 Continue"], "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses a bare LF inside the header block", async () => {
		const { transport } = harnessWith(["HTTP/1.1 200 OK\nContent-Length: 0\r\n\r\n"]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses obsolete header line folding", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "X-Long: one", " two", "Content-Length: 0"])]);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
	});

	it("refuses a header block longer than 32 KiB and destroys the socket", async () => {
		const { transport, dials } = harnessWith(["HTTP/1.1 200 OK\r\nX-Pad: " + "a".repeat(33 * 1024)], false);
		await expect(transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal)).rejects.toThrow();
		expect(dials[0]?.socket.destroyed).toBe(true);
	});

	it("fails the body when the peer closes before a Content-Length body is complete", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Length: 10"], "short")]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		await expect(response.text()).rejects.toThrow();
	});

	it("fails the body on a chunk size that is not hexadecimal", async () => {
		const { transport } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Transfer-Encoding: chunked"], "zz\r\nabc\r\n0\r\n\r\n")]);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		await expect(response.text()).rejects.toThrow();
	});
});

describe("public fetch transport honours cancellation", () => {
	it("aborting while the headers are pending rejects and destroys the socket", async () => {
		const { transport, dials } = harnessWith([], false);
		const controller = new AbortController();
		const pending = transport.get(SOURCE, VETTED_ADDRESS, controller.signal);
		controller.abort(new Error("caller gave up"));
		await expect(pending).rejects.toThrow("caller gave up");
		expect(dials[0]?.socket.destroyed).toBe(true);
	});

	it("cancelling the body stream destroys the socket", async () => {
		const { transport, dials } = harnessWith([httpReply(["HTTP/1.1 200 OK", "Content-Length: 10"], "0123456789")], false);
		const response = await transport.get(SOURCE, VETTED_ADDRESS, new AbortController().signal);
		const reader = response.body?.getReader();
		if (reader === undefined) throw new Error("expected a body stream");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("0123456789");
		await reader.cancel();
		expect(dials[0]?.socket.destroyed).toBe(true);
	});
});

/** Scripted stand-in for the TLS socket the production wrap returns. The adapter's events are driven by the test. */
class FakeWrappedTls extends EventEmitter implements TlsSocketLike {
	destroyed = false;
	readonly written: unknown[] = [];

	write(data: unknown): unknown {
		this.written.push(data);
		return true;
	}

	pause(): unknown {
		return this;
	}

	resume(): unknown {
		return this;
	}

	destroy(): unknown {
		this.destroyed = true;
		return this;
	}
}

interface AdapterScript {
	/** `connect` opens the raw TCP socket; `hang` never does. */
	dial: "connect" | "hang";
	/** `secure` completes the handshake, `fail` errors it, `hang` never finishes it. */
	tls: "secure" | "fail" | "hang";
}

/** Drives the production adapter through injected raw and TLS factories. No network opens. */
function adapterWith(script: AdapterScript) {
	const raw = new NetSocket();
	const secure = new FakeWrappedTls();
	const dials: Array<{ host: string; port: number }> = [];
	const wraps: ConnectionOptions[] = [];
	const connect = pinnedTlsOver({
		dial: (options) => {
			dials.push(options);
			if (script.dial === "connect") queueMicrotask(() => raw.emit("connect"));
			return raw;
		},
		wrap: (options) => {
			wraps.push(options);
			if (script.tls === "secure") queueMicrotask(() => secure.emit("secureConnect"));
			if (script.tls === "fail") queueMicrotask(() => secure.emit("error", new Error("certificate verify failed")));
			return secure;
		},
	});
	return { connect, raw, secure, dials, wraps };
}

const DIAL: PinnedDial = { host: VETTED_ADDRESS, servername: "example.com", port: 443, rejectUnauthorized: true };

describe("the production adapter dials the vetted address, then verifies the original name", () => {
	it("dials the IP with no name, then wraps that socket with the original name", async () => {
		const h = adapterWith({ dial: "connect", tls: "secure" });
		const socket = await h.connect(DIAL, new AbortController().signal);
		expect(socket).toBe(h.secure);
		expect(h.dials).toEqual([{ host: VETTED_ADDRESS, port: 443 }]);
		expect(h.wraps).toHaveLength(1);
		expect(h.wraps[0]).toMatchObject({ servername: "example.com", rejectUnauthorized: true });
		expect(h.wraps[0]?.socket).toBe(h.raw);
	});

	it("resolves only after the handshake, so no request byte precedes verification", async () => {
		const h = adapterWith({ dial: "connect", tls: "hang" });
		let resolved = false;
		const pending = h.connect(DIAL, new AbortController().signal).then((socket) => {
			resolved = true;
			return socket;
		});
		await sleep(0);
		expect(h.wraps).toHaveLength(1);
		expect(resolved).toBe(false);
		expect(h.secure.written).toEqual([]);
		h.secure.emit("secureConnect");
		await expect(pending).resolves.toBe(h.secure);
	});

	it("a failed handshake rejects and destroys both the TLS and the raw socket", async () => {
		const h = adapterWith({ dial: "connect", tls: "fail" });
		await expect(h.connect(DIAL, new AbortController().signal)).rejects.toThrow("certificate verify failed");
		expect(h.secure.destroyed).toBe(true);
		expect(h.raw.destroyed).toBe(true);
	});

	it("an abort during the dial destroys the raw socket and rejects with the abort reason", async () => {
		const h = adapterWith({ dial: "hang", tls: "hang" });
		const controller = new AbortController();
		const pending = h.connect(DIAL, controller.signal);
		controller.abort(new Error("deadline reached"));
		await expect(pending).rejects.toThrow("deadline reached");
		expect(h.raw.destroyed).toBe(true);
		expect(h.wraps).toHaveLength(0);
	});
});

describe("the production adapter fails closed on raw socket errors and aborts", () => {
	it("a raw error during the TLS handshake rejects with that error and destroys both sockets", async () => {
		const h = adapterWith({ dial: "connect", tls: "hang" });
		const pending = h.connect(DIAL, new AbortController().signal);
		await sleep(0);
		expect(h.wraps).toHaveLength(1);
		expect(() => h.raw.emit("error", new Error("ECONNRESET"))).not.toThrow();
		await expect(pending).rejects.toThrow("ECONNRESET");
		expect(h.secure.destroyed).toBe(true);
		expect(h.raw.destroyed).toBe(true);
		expect(h.secure.written).toEqual([]);
	});

	it("a raw dial error before the TCP connect rejects, destroys the raw socket, and never wraps", async () => {
		const h = adapterWith({ dial: "hang", tls: "hang" });
		const pending = h.connect(DIAL, new AbortController().signal);
		expect(() => h.raw.emit("error", new Error("ECONNREFUSED"))).not.toThrow();
		await expect(pending).rejects.toThrow("ECONNREFUSED");
		expect(h.raw.destroyed).toBe(true);
		expect(h.wraps).toHaveLength(0);
	});

	it("an abort during the TLS handshake rejects with the abort reason and destroys both sockets", async () => {
		const h = adapterWith({ dial: "connect", tls: "hang" });
		const controller = new AbortController();
		const pending = h.connect(DIAL, controller.signal);
		await sleep(0);
		controller.abort(new Error("deadline reached"));
		await expect(pending).rejects.toThrow("deadline reached");
		expect(h.secure.destroyed).toBe(true);
		expect(h.raw.destroyed).toBe(true);
		expect(h.secure.written).toEqual([]);
	});

	it("a signal already aborted before the call rejects without dialing", async () => {
		const h = adapterWith({ dial: "connect", tls: "secure" });
		const controller = new AbortController();
		controller.abort(new Error("already gone"));
		await expect(h.connect(DIAL, controller.signal)).rejects.toThrow("already gone");
		expect(h.dials).toEqual([]);
		expect(h.wraps).toEqual([]);
	});

	it("a raw error after a completed handshake destroys the TLS socket without throwing", async () => {
		const h = adapterWith({ dial: "connect", tls: "secure" });
		await h.connect(DIAL, new AbortController().signal);
		expect(() => h.raw.emit("error", new Error("EPIPE"))).not.toThrow();
		expect(h.secure.destroyed).toBe(true);
	});

	it("a completed handshake is not undone by a later abort of the dial signal", async () => {
		const h = adapterWith({ dial: "connect", tls: "secure" });
		const controller = new AbortController();
		await h.connect(DIAL, controller.signal);
		controller.abort(new Error("too late"));
		expect(h.secure.destroyed).toBe(false);
		expect(h.raw.destroyed).toBe(false);
	});
});
