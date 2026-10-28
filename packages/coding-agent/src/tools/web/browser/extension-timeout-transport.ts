import { AsyncLocalStorage } from "node:async_hooks";
import type { Browser, Connection, ConnectionTransport } from "puppeteer-core";

/** The relay's private CDP endpoint, not a Chromium /devtools endpoint. */
export function isExtensionRelayEndpoint(endpoint: string): boolean {
	const url = new URL(endpoint);
	return url.hostname === "127.0.0.1" && url.pathname.startsWith("/cdp/");
}

/**
 * Puppeteer consumes CommandOptions.timeout before serializing a command. Carry that value in
 * relay-only metadata, outside CDP params. The scope belongs to one send, never to a connection.
 */
export class ExtensionTimeoutTransport implements ConnectionTransport {
	onmessage?: (message: string) => void;
	onclose?: () => void;
	readonly #transport: ConnectionTransport;
	readonly #timeouts = new AsyncLocalStorage<number | undefined>();

	constructor(transport: ConnectionTransport) {
		this.#transport = transport;
		transport.onmessage = message => this.onmessage?.(message);
		transport.onclose = () => this.onclose?.();
	}

	bind(connection: Connection): void {
		const send = connection._rawSend.bind(connection);
		connection._rawSend = (callbacks, method, params, sessionId, options) =>
			this.#timeouts.run(options?.timeout, () => send(callbacks, method, params, sessionId, options));
	}

	send(message: string): void {
		const timeout = this.#timeouts.getStore();
		if (timeout === undefined) {
			this.#transport.send(message);
			return;
		}
		this.#transport.send(JSON.stringify({ ...JSON.parse(message), relayTimeoutMs: timeout }));
	}

	close(): void {
		this.#transport.close();
	}
}

/** Open only the relay's loopback socket; Chromium connections keep Puppeteer's transport. */
export async function openExtensionTimeoutTransport(endpoint: string): Promise<ExtensionTimeoutTransport> {
	const socket = new WebSocket(endpoint);
	const opened = Promise.withResolvers<void>();
	const transport: ConnectionTransport = {
		send: message => socket.send(message),
		close: () => socket.close(),
	};
	socket.onopen = () => opened.resolve();
	socket.onerror = () => opened.reject(new Error("The extension relay socket failed to open."));
	socket.onclose = () => {
		opened.reject(new Error("The extension relay socket closed before it opened."));
		transport.onclose?.();
	};
	socket.onmessage = event => transport.onmessage?.(String(event.data));
	const scoped = new ExtensionTimeoutTransport(transport);
	await opened.promise;
	return scoped;
}

/** All sessions of a browser share this connection, including sessions created after binding. */
export function bindExtensionTimeouts(browser: Browser, transport: ExtensionTimeoutTransport): void {
	// The pinned Puppeteer CDP browser exposes its connection without opening a tab or session.
	if (!("_connection" in browser)) throw new Error("The extension relay requires a Puppeteer CDP connection.");
	transport.bind(browser._connection as Connection);
}
