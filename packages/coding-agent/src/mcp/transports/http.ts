/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * Based on MCP spec 2025-03-26.
 */
import { isAbortError, logger, readSseJson, Snowflake } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import {
	describeJsonRpcError,
	type IncomingMessageRoutes,
	reportUnattributableError,
	routeIncomingMessage,
} from "../incoming-message";
import { JSON_RPC_POST_HEADERS } from "../json-rpc";
import { createMCPTimeout, getNeverAbortSignal, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import type {
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
	ServerRequestResponse,
} from "../types";
import { answerServerRequest } from "../types";
import { mcpHttpFailure } from "./http-failure";
import { reportUndeliveredServerResponse } from "./server-response-delivery";
import {
	mcpEmptyResponseBodyMessage,
	mcpNoResponseForRequestMessage,
	mcpNotConnectedMessage,
	mcpTimeoutMessage,
} from "./transport-failure";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;

const mcpToolArgsAttemptFactory = Symbol("mcpToolArgsAttemptFactory");

type MCPToolArgsAttemptFactory = () => Promise<Record<string, unknown>>;

type MCPToolArgsWithAttemptFactory = Record<string, unknown> & {
	[mcpToolArgsAttemptFactory]?: MCPToolArgsAttemptFactory;
};

/**
 * Keep the raw tool arguments reachable without making them part of the JSON
 * payload. HTTP auth retries and legacy-SSE POST retries use the factory only
 * after their refresh await, so each physical retry is rebuilt with the
 * then-current provider transform.
 */
export function retainMCPToolArgsAttemptFactory(
	args: Record<string, unknown>,
	attemptFactory: MCPToolArgsAttemptFactory,
): Record<string, unknown> {
	Object.defineProperty(args, mcpToolArgsAttemptFactory, {
		value: attemptFactory,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	return args;
}

/** Rebuild only provider-bound tools/call arguments; all other RPC params stay exact. */
export async function rebuildMCPToolCallParamsForAttempt(
	params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
	const args = params?.arguments;
	if (!isRecord(args)) return params;
	const attemptFactory = (args as MCPToolArgsWithAttemptFactory)[mcpToolArgsAttemptFactory];
	if (!attemptFactory) return params;
	return { ...params, arguments: await attemptFactory() };
}

/** Where {@link postJsonRpc} sends a message, and how it adopts a refreshed credential. */
export interface JsonRpcPostTarget {
	/** The configured server URL, which a failure names. */
	serverUrl(): string;
	/** The headers of one attempt, read again for the auth retry after {@link adoptHeaders}. */
	headers(): Record<string, string>;
	/** The credential refresh to run on a 401 or 403, when the server has one. */
	authRefresh(): (() => Promise<Record<string, string> | null>) | undefined;
	/** Keeps refreshed headers for the retry and every later request. */
	adoptHeaders(headers: Record<string, string>): void;
	/** Reads each response before its status is judged. */
	onResponse?(response: Response): void;
}

async function sendJsonRpc(
	target: JsonRpcPostTarget,
	url: string,
	body: JsonRpcMessage,
	signal: AbortSignal | undefined,
): Promise<Response> {
	const response = await fetch(url, { method: "POST", headers: target.headers(), body: JSON.stringify(body), signal });
	target.onResponse?.(response);
	return response;
}

/**
 * POST one JSON-RPC message to `url` for either HTTP transport. A 401 or 403 runs the target's
 * credential refresh once and sends the message again with the refreshed headers, rebuilding
 * provider-bound tool arguments for the new attempt. A response that is still not OK is thrown as
 * {@link mcpHttpFailure}, so a caller only ever receives a 2xx response.
 */
export async function postJsonRpc(
	target: JsonRpcPostTarget,
	url: string,
	body: JsonRpcMessage,
	signal: AbortSignal | undefined,
): Promise<Response> {
	let response = await sendJsonRpc(target, url, body, signal);
	const refresh = response.status === 401 || response.status === 403 ? target.authRefresh() : undefined;
	if (refresh) {
		const refreshed = await refresh();
		if (refreshed) {
			await response.body?.cancel();
			target.adoptHeaders(refreshed);
			const retryBody =
				"params" in body ? { ...body, params: await rebuildMCPToolCallParamsForAttempt(body.params) } : body;
			response = await sendJsonRpc(target, url, retryBody, signal);
		}
	}
	if (!response.ok) throw await mcpHttpFailure(target.serverUrl(), response);
	return response;
}

/**
 * POST the answer to a server-to-client request back to the server, for either HTTP transport.
 *
 * The server is waiting on this answer, so a reply that does not arrive is reported: a send that
 * throws and a send the server answers with a status other than 2xx alike. Delivery is retried
 * only by the auth retry of {@link postJsonRpc}.
 */
export async function deliverServerResponse(
	target: JsonRpcPostTarget,
	url: string,
	body: ServerRequestResponse,
	timeoutMs: number,
): Promise<void> {
	const operation = createMCPTimeout(timeoutMs);
	try {
		const response = await postJsonRpc(target, url, body, operation.signal);
		await response.body?.cancel();
	} catch (cause) {
		reportUndeliveredServerResponse({
			url: target.serverUrl(),
			requestId: body.id,
			kind: body.error ? "error" : "result",
			cause,
		});
	} finally {
		operation.clear();
	}
}

/**
 * Best-effort startup deadline for the optional Streamable HTTP GET SSE listener.
 *
 * Returns `0` (disabled) when the operator has explicitly disabled MCP client-side
 * timeouts via `timeout: 0` or `VEYYON_MCP_TIMEOUT_MS=0`, mirroring the rest of the
 * MCP timeout surface. Otherwise caps the wait at one second and scales below
 * short request timeouts so connect-time never exceeds the request budget.
 */
export function resolveSSEConnectTimeoutMs(configTimeout?: number): number {
	const requestTimeout = resolveMCPTimeoutMs(configTimeout);
	if (!isMCPTimeoutEnabled(requestTimeout)) return 0;
	const boundedTimeout = Math.min(HTTP_SSE_CONNECT_TIMEOUT_MS, Math.floor(requestTimeout / 4));
	return Math.max(1, boundedTimeout);
}
/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 */
export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	readonly #postTarget: JsonRpcPostTarget = {
		serverUrl: () => this.config.url,
		headers: () => this.#requestHeaders(JSON_RPC_POST_HEADERS),
		authRefresh: () => this.onAuthError,
		adoptHeaders: headers => {
			// Replaced rather than merged into, so the caller's config object is never written.
			this.config = { ...this.config, headers };
		},
		onResponse: response => {
			const sessionId = response.headers.get("Mcp-Session-Id");
			if (sessionId) this.#sessionId = sessionId;
		},
	};

	/** Messages on the GET stream, and those a request's response stream does not take for itself. */
	readonly #incoming: IncomingMessageRoutes = {
		server: () => this.config.url,
		// A response travels on the stream of the POST that sent its request; one arriving anywhere
		// else answers nothing this client is waiting on.
		response: () => {},
		serverRequest: request => {
			void answerServerRequest(this.onRequest, request).then(answer => {
				if (!this.#connected) return;
				return deliverServerResponse(
					this.#postTarget,
					this.config.url,
					answer,
					resolveMCPTimeoutMs(this.config.timeout),
				);
			});
		},
		notification: (method, params) => this.onNotification?.(method, params),
		unattributableError: error => this.onError?.(reportUnattributableError(this.config.url, error, 0)),
	};

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need persistent connection, but we track state.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
	}

	/**
	 * Headers for one request: `base`, then the configured headers (which may replace a base header
	 * and carry refreshed auth), then the session id the server assigned, if any. A fresh object per
	 * call, so an auth retry may merge refreshed headers into it.
	 */
	#requestHeaders(base: Readonly<Record<string, string>>): Record<string, string> {
		const headers: Record<string, string> = { ...base, ...this.config.headers };
		if (this.#sessionId) headers["Mcp-Session-Id"] = this.#sessionId;
		return headers;
	}

	/**
	 * Start SSE listener for server-initiated messages.
	 * Resolves once the SSE connection is established (or fails/unsupported).
	 * Message reading continues in the background.
	 */
	async startSSEListener(): Promise<void> {
		if (!this.#connected) return;
		if (this.#sseConnection) return;

		this.#sseConnection = new AbortController();
		const headers = this.#requestHeaders({ Accept: "text/event-stream" });

		let response: Response | null;
		let timedOut = false;
		let startupFinished = false;
		const connection = this.#sseConnection;
		const startupTimeoutMs = resolveSSEConnectTimeoutMs(this.config.timeout);
		const fetchPromise = fetch(this.config.url, {
			method: "GET",
			headers,
			signal: connection.signal,
		});
		let timer: NodeJS.Timeout | undefined;
		let timeoutPromise: Promise<null> | null = null;
		if (startupTimeoutMs > 0) {
			const { promise, resolve } = Promise.withResolvers<null>();
			timeoutPromise = promise;
			timer = setTimeout(() => {
				if (!startupFinished) {
					timedOut = true;
					connection.abort();
				}
				resolve(null);
			}, startupTimeoutMs);
		}
		try {
			response = timeoutPromise === null ? await fetchPromise : await Promise.race([fetchPromise, timeoutPromise]);
		} catch (error) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (error instanceof Error && !isAbortError(error) && !timedOut) {
				this.onError?.(error);
			}
			return;
		} finally {
			startupFinished = true;
			clearTimeout(timer);
		}
		if (response === null) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			// The startup race already gave up on this connection and reported through `onError`. This only drains
			// a response that arrives late so its socket is released; there is no longer anyone to tell.
			void fetchPromise.then(lateResponse => lateResponse.body?.cancel()).catch(() => {});
			return;
		}

		if (this.#sseConnection !== connection) {
			await response.body?.cancel();
			return;
		}
		if (response.status === 405 || !response.ok || !response.body) {
			await response.body?.cancel();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			return;
		}

		// Connection established — read messages in background.
		// If the stream ends unexpectedly (server restart, network drop),
		// fire onClose so the manager can trigger reconnection.
		const signal = connection.signal;
		void this.#readSSEStream(response.body!, signal).finally(() => {
			const wasConnected = this.#connected;
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (wasConnected) this.onClose?.();
		});
	}

	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<unknown>(body, signal)) {
				if (!this.#connected) break;
				routeIncomingMessage(message, this.#incoming);
			}
		} catch (error) {
			if (error instanceof Error && !isAbortError(error)) {
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected) {
			throw new Error(mcpNotConnectedMessage({ url: this.config.url }, `request "${method}"`));
		}

		const id = Snowflake.next();
		const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params ?? {} };

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);

		try {
			const response = await postJsonRpc(this.#postTarget, this.config.url, body, operation.signal);

			const contentType = response.headers.get("Content-Type") ?? "";

			// Handle SSE response
			if (contentType.includes("text/event-stream")) {
				return this.#parseSSEResponse<T>(response, id, options);
			}

			// Handle JSON response
			const result = (await response.json()) as JsonRpcResponse;

			if (result.error) {
				throw new Error(describeJsonRpcError(result.error));
			}

			return result.result as T;
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.config.url }, `request "${method}"`, timeout));
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	#parseSSEResponse<T>(response: Response, expectedId: string | number, options?: MCPRequestOptions): Promise<T> {
		if (!response.body) {
			throw new Error(mcpEmptyResponseBodyMessage({ url: this.config.url }));
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);
		const signal = operation.signal ?? getNeverAbortSignal();

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let captured = false;
		const settle = (outcome: () => void): void => {
			captured = true;
			operation.clear();
			outcome();
		};
		// This stream carries the answer to one request. An error that names no request answers that
		// one, as the same error in a JSON body does; every other message goes where the GET stream's
		// would, while this client is still connected.
		const routes: IncomingMessageRoutes = {
			server: this.#incoming.server,
			response: response => {
				if (captured || response.id !== expectedId) return;
				settle(() =>
					response.error ? reject(new Error(describeJsonRpcError(response.error))) : resolve(response.result as T),
				);
			},
			serverRequest: request => {
				if (this.#connected) this.#incoming.serverRequest(request);
			},
			notification: (method, params) => {
				if (this.#connected) this.#incoming.notification(method, params);
			},
			unattributableError: error => {
				if (!captured) settle(() => reject(new Error(describeJsonRpcError(error))));
				else if (this.#connected) this.#incoming.unattributableError(error);
			},
		};

		// Drain the SSE stream from a single iterator. We resolve the deferred
		// promise as soon as the matching response arrives, then keep iterating
		// in the background to pick up piggybacked notifications/requests.
		// Re-reading `response.body` after `for await` breaks would lock the
		// stream a second time and surface as "ReadableStream already has a
		// controller", so we must not exit the loop early.
		const drain = async (): Promise<void> => {
			try {
				for await (const frame of readSseJson<unknown>(response.body!, signal)) {
					routeIncomingMessage(frame, routes);
				}
				if (!captured) {
					reject(new Error(mcpNoResponseForRequestMessage({ url: this.config.url }, expectedId)));
				}
			} catch (error) {
				if (captured) return;
				if (operation.isTimeoutAbort(error)) {
					reject(
						new Error(
							mcpTimeoutMessage({ url: this.config.url }, "its streamed response to this request", timeout),
						),
					);
				} else {
					reject(error as Error);
				}
			} finally {
				operation.clear();
			}
		};

		void drain();
		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new Error(mcpNotConnectedMessage({ url: this.config.url }, `notification "${method}"`));
		}

		const body: JsonRpcNotification = { jsonrpc: "2.0", method, params: params ?? {} };

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout);

		try {
			// 202 Accepted is the usual answer to a notification, and a 2xx like any other.
			const response = await postJsonRpc(this.#postTarget, this.config.url, body, operation.signal);

			// The server may piggyback server-to-client requests or notifications
			// on the notification response (MCP Streamable HTTP spec). Read them.
			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				// Use the SSE connection's signal if available; otherwise keep the existing finite read timeout.
				if (this.#sseConnection) {
					void this.#readSSEStream(response.body, this.#sseConnection.signal);
				} else {
					const readOperation = createMCPTimeout(timeout);
					const signal = readOperation.signal ?? getNeverAbortSignal();
					void this.#readSSEStream(response.body, signal).finally(() => readOperation.clear());
				}
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.config.url }, `notification "${method}"`, timeout));
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	async close(): Promise<void> {
		if (!this.#connected) return;
		this.#connected = false;

		// Abort SSE listener
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}

		// Send session termination if we have a session
		if (this.#sessionId) {
			const timeout = resolveMCPTimeoutMs(this.config.timeout);
			const operation = createMCPTimeout(timeout);
			try {
				await fetch(this.config.url, {
					method: "DELETE",
					headers: this.#requestHeaders({}),
					signal: operation.signal,
				});
				operation.clear();
			} catch {
				operation.clear();
				// Ignore termination errors
			}
			this.#sessionId = null;
		}

		this.onClose?.();
		this.onClose = undefined;
	}
}

/**
 * Create and connect an HTTP transport.
 */
export async function createHttpTransport(config: MCPHttpServerConfig | MCPSseServerConfig): Promise<HttpTransport> {
	const transport = new HttpTransport(config);
	await transport.connect();
	return transport;
}
