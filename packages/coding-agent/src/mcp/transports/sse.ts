import { isAbortError, logger, readSseEvents, Snowflake } from "@veyyon/utils";
import {
	describeJsonRpcError,
	type IncomingMessageRoutes,
	rejectAllPending,
	reportUnattributableError,
	routeIncomingMessage,
} from "../incoming-message";
import { JSON_RPC_POST_HEADERS } from "../json-rpc";
import { createMCPTimeout, getNeverAbortSignal, resolveMCPTimeoutMs } from "../timeout";
import type {
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../types";
import { answerServerRequest } from "../types";
import { deliverServerResponse, type JsonRpcPostTarget, postJsonRpc } from "./http";
import { mcpHttpFailure } from "./http-failure";
import {
	describeMCPTarget,
	mcpEmptyResponseBodyMessage,
	mcpNotConnectedMessage,
	mcpStreamClosedMessage,
	mcpTimeoutMessage,
} from "./transport-failure";

interface MCPTimeoutOperation {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
}

interface PendingLegacySseRequest {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	operation: MCPTimeoutOperation;
	abortHandler?: () => void;
}

/** Legacy MCP HTTP+SSE transport from protocol revision 2024-11-05. */
export class LegacySseTransport implements MCPTransport {
	#connected = false;
	#endpointUrl: string | null = null;
	#sseConnection: AbortController | null = null;
	#pending = new Map<string | number, PendingLegacySseRequest>();
	#config: MCPSseServerConfig;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	readonly #postTarget: JsonRpcPostTarget = {
		serverUrl: () => this.#config.url,
		headers: () => ({ ...JSON_RPC_POST_HEADERS, ...this.#config.headers }),
		authRefresh: () => this.onAuthError,
		adoptHeaders: headers => {
			// Replaced rather than merged into, so the caller's config object is never written.
			this.#config = { ...this.#config, headers };
		},
	};

	readonly #incoming: IncomingMessageRoutes = {
		server: () => this.#config.url,
		response: response => {
			const pending = this.#pending.get(response.id);
			if (!pending) return;
			this.#pending.delete(response.id);
			this.#release(pending);
			if (response.error) pending.reject(new Error(describeJsonRpcError(response.error)));
			else pending.resolve(response.result);
		},
		serverRequest: request => {
			void answerServerRequest(this.onRequest, request).then(answer => {
				const endpointUrl = this.#endpointUrl;
				if (!this.#connected || !endpointUrl) return;
				return deliverServerResponse(
					this.#postTarget,
					endpointUrl,
					answer,
					resolveMCPTimeoutMs(this.#config.timeout),
				);
			});
		},
		notification: (method, params) => this.onNotification?.(method, params),
		unattributableError: error => {
			const failed = rejectAllPending(this.#pending, error, request => this.#release(request));
			this.onError?.(reportUnattributableError(this.#config.url, error, failed));
		},
	};

	constructor(config: MCPSseServerConfig) {
		this.#config = config;
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.#config.url;
	}

	async connect(): Promise<void> {
		if (this.#connected) return;
		if (this.#sseConnection) return;

		const connection = new AbortController();
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, connection.signal);
		const endpointReady = Promise.withResolvers<void>();
		this.#sseConnection = connection;

		try {
			const response = await fetch(this.#config.url, {
				method: "GET",
				headers: {
					Accept: "text/event-stream",
					...this.#config.headers,
				},
				signal: operation.signal,
			});

			if (!response.ok) throw await mcpHttpFailure(this.#config.url, response);
			if (!response.body) {
				throw new Error(mcpEmptyResponseBodyMessage({ url: this.#config.url }));
			}

			void this.#readSSEStream(response.body, operation, endpointReady).finally(() => {
				const wasConnected = this.#connected;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (wasConnected) this.onClose?.();
			});
			await endpointReady.promise;
		} catch (error) {
			operation.clear();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			connection.abort();
			if (operation.isTimeoutAbort(error)) {
				throw new Error(
					mcpTimeoutMessage({ url: this.#config.url }, "the legacy SSE handshake (its `endpoint` event)", timeout),
				);
			}
			throw error;
		}
	}

	async #readSSEStream(
		body: ReadableStream<Uint8Array>,
		operation: MCPTimeoutOperation,
		endpointReady: PromiseWithResolvers<void>,
	): Promise<void> {
		const signal = operation.signal ?? getNeverAbortSignal();
		let endpointReceived = false;
		try {
			for await (const event of readSseEvents(body, signal)) {
				if (event.event === "endpoint") {
					if (!this.#endpointUrl) {
						const endpointUrl = new URL(event.data, this.#config.url);
						const configuredUrl = new URL(this.#config.url);
						if (endpointUrl.origin !== configuredUrl.origin) {
							// The remedy must not be "trust the new origin". This branch is
							// the defence against a server redirecting our Authorization
							// header to somewhere else, so a message that said "point the
							// url at ${endpointUrl.origin}" would talk the operator into
							// performing the attack by hand.
							throw new Error(
								`${describeMCPTarget({ url: this.#config.url })} advertised its message endpoint on a different origin: expected ${configuredUrl.origin}, received ${endpointUrl.origin}. Refusing it, because POSTing there would send this server's credentials to an origin you did not configure. Fix: do not point the config at ${endpointUrl.origin} to make this go away. Check this server's \`url\` in your MCP config, and if its operator has genuinely moved the server, verify the new origin with them before changing it.`,
							);
						}
						this.#endpointUrl = endpointUrl.href;
						this.#connected = true;
						endpointReceived = true;
						operation.clear();
						endpointReady.resolve();
					}
					continue;
				}
				if (event.data === "" || event.data === "[DONE]") continue;

				let payload: unknown;
				try {
					payload = JSON.parse(event.data) as unknown;
				} catch (error) {
					if (error instanceof SyntaxError) {
						throw new Error(
							`${describeMCPTarget({ url: this.#config.url })} sent a legacy SSE message that is not JSON: ${event.data}. Fix: this is a bug in the server; check its own logs. If the server is behind a proxy, the proxy may be rewriting the event stream.`,
						);
					}
					throw error;
				}

				routeIncomingMessage(payload, this.#incoming);
			}
			if (!endpointReceived) {
				endpointReady.reject(
					new Error(
						`${describeMCPTarget({ url: this.#config.url })} opened an SSE stream but never sent the \`endpoint\` event the legacy HTTP+SSE protocol requires, so there is no address to POST requests to. Fix: this server is probably not a legacy SSE server. Change its \`type\` to \`"http"\` in your MCP config, or run \`/mcp test <name>\` to see what it does answer.`,
					),
				);
			}
		} catch (error) {
			if (!endpointReceived) {
				endpointReady.reject(error);
			} else if (error instanceof Error && !isAbortError(error)) {
				logger.debug("Legacy SSE stream error", { url: this.#config.url, error: error.message });
				this.onError?.(error);
				this.#rejectPending(error);
			}
		} finally {
			operation.clear();
			if (endpointReceived) {
				this.#rejectPending(new Error(mcpStreamClosedMessage({ url: this.#config.url }, "its SSE stream ended")));
			}
		}
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error(mcpNotConnectedMessage({ url: this.#config.url }, `request "${method}"`));
		}

		const id = Snowflake.next();
		const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params ?? {} };
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);
		const deferred = Promise.withResolvers<unknown>();
		// Observe the response promise synchronously so a stream-close rejection
		// from `#rejectPending` that lands while `request()` is still awaiting the
		// POST round-trip is never flagged as an unhandled rejection. The real
		// `await deferred.promise` below still receives and propagates the error.
		void deferred.promise.catch(() => undefined);
		const pending: PendingLegacySseRequest = {
			resolve: deferred.resolve,
			reject: deferred.reject,
			operation,
		};
		if (operation.signal) {
			pending.abortHandler = () => {
				this.#pending.delete(id);
				operation.clear();
				deferred.reject(
					options?.signal?.aborted && options.signal.reason instanceof Error
						? options.signal.reason
						: new Error(mcpTimeoutMessage({ url: this.#config.url }, `request "${method}"`, timeout)),
				);
			};
			operation.signal.addEventListener("abort", pending.abortHandler, { once: true });
		}
		this.#pending.set(id, pending);

		try {
			const response = await this.#postJson(body, operation.signal);
			await response.body?.cancel();
			return (await deferred.promise) as T;
		} catch (error) {
			this.#pending.delete(id);
			this.#release(pending);
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.#config.url }, `request "${method}"`, timeout));
			}
			throw error;
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error(mcpNotConnectedMessage({ url: this.#config.url }, `notification "${method}"`));
		}

		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout);
		try {
			const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params: params ?? {} };
			const response = await this.#postJson(notification, operation.signal);
			operation.clear();
			await response.body?.cancel();
		} catch (error) {
			operation.clear();
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.#config.url }, `notification "${method}"`, timeout));
			}
			throw error;
		}
	}

	/** POST one JSON-RPC message to the endpoint the server announced; see {@link postJsonRpc}. */
	async #postJson(body: JsonRpcMessage, signal?: AbortSignal): Promise<Response> {
		const endpointUrl = this.#endpointUrl;
		if (!endpointUrl) throw new Error(mcpNotConnectedMessage({ url: this.#config.url }, "POST"));
		return postJsonRpc(this.#postTarget, endpointUrl, body, signal);
	}

	/** Stop one in-flight request's timer and abort listener; the caller has taken it out of the map. */
	#release(pending: PendingLegacySseRequest): void {
		pending.operation.clear();
		if (pending.abortHandler) pending.operation.signal?.removeEventListener("abort", pending.abortHandler);
	}

	#rejectPending(error: Error): void {
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			this.#release(pending);
			pending.reject(error);
		}
	}

	async close(): Promise<void> {
		if (!this.#connected && !this.#sseConnection) return;
		const wasConnected = this.#connected;
		this.#connected = false;
		this.#endpointUrl = null;
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}
		this.#rejectPending(
			new Error(
				`${describeMCPTarget({ url: this.#config.url })} was disconnected by this client while requests were still in flight, so they failed. Fix: if you did not expect this, run \`/mcp reconnect <name>\` and retry; \`/mcp list\` gives the name.`,
			),
		);
		if (wasConnected) this.onClose?.();
		this.onClose = undefined;
	}
}

/** Create and connect a legacy HTTP+SSE transport. */
export async function createSseTransport(config: MCPSseServerConfig): Promise<LegacySseTransport> {
	const transport = new LegacySseTransport(config);
	await transport.connect();
	return transport;
}
