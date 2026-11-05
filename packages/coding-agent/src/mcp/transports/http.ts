/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * Based on MCP spec 2025-03-26.
 */
import * as AIError from "@veyyon/ai/error";
import { isAbortError, logger, readSseEvents, readSseJson, Snowflake, untilAborted } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import {
	createMCPTimeout,
	getNeverAbortSignal,
	isMCPTimeoutEnabled,
	type MCPTimeoutOperation,
	resolveMCPTimeoutMs,
} from "../timeout";
import {
	describeJsonRpcError,
	type IncomingMessageRoutes,
	reportUnattributableError,
	routeIncomingMessage,
} from "../incoming-message";
import { JSON_RPC_POST_HEADERS } from "../json-rpc";
import type {
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPStreamRequest,
	MCPStreamRequestOptions,
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
// A single untrusted SSE event must not fan out unbounded work or log volume.
const MAX_HTTP_SSE_BATCH_MEMBERS = 256;
// Count request handling AND its HTTP response delivery in the same budget.
const MAX_PENDING_HTTP_SSE_SERVER_REQUESTS = 32;

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

/** Narrow untrusted stream frames before routing their notification or response fields. */
function isStreamMessage(value: unknown): value is JsonRpcMessage {
	if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
	if ("method" in value) {
		if (typeof value.method !== "string" || (value.params !== undefined && !isRecord(value.params))) return false;
		return !("id" in value) || typeof value.id === "string" || typeof value.id === "number";
	}
	if (value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") return false;
	if ("result" in value === "error" in value) return false;
	if ("error" in value) {
		return (
			isRecord(value.error) &&
			Number.isSafeInteger(value.error.code) &&
			typeof value.error.message === "string"
		);
	}
	return "result" in value;
}
/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 */
export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;
	#streamRequests = new Map<string | number, AbortController>();
	#requestController = new AbortController();
	#pendingSSEServerRequests = 0;

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

	/**
	 * MCP Streamable HTTP assigns session identity only in a successful,
	 * correlated initialization result. Other replies cannot rotate the
	 * session used on future client requests, even if HTTP is 200.
	 */
	#acceptInitializationSessionHeader(response: Response, method: string): void {
		if (method !== "initialize") return;
		const value = response.headers.get("Mcp-Session-Id");
		if (value === null) return;
		// MCP session ids use only visible ASCII, 0x21 through 0x7E.
		if (!/^[\x21-\x7e]+$/.test(value)) {
			throw new Error("MCP initialization response has invalid session identifier");
		}
		this.#sessionId = value;
	}

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
		if (this.#requestController.signal.aborted) this.#requestController = new AbortController();
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
				await this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && !isAbortError(error)) {
				// readSseJson may include untrusted SSE frame bytes in the
				// JSON.parse SyntaxError. Never send them to logs or onError.
				const diagnostic =
					error instanceof SyntaxError
						? new Error("MCP HTTP SSE stream received malformed JSON")
						: error;
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: diagnostic.message });
				this.onError?.(diagnostic);
			}
		}
	}

	/** Validate and admit an untrusted SSE event using bounded per-frame work. */
	async #dispatchSSEMessage(message: unknown): Promise<void> {
		const members = Array.isArray(message) ? message : [message];
		if (members.length > MAX_HTTP_SSE_BATCH_MEMBERS) {
			// Fail the connection instead of silently stranding valid request IDs.
			// Closing bounds rejection work independently of the batch length.
			try {
				this.onError?.(new Error("MCP HTTP SSE batch exceeds the 256-member limit"));
			} finally {
				await this.close();
			}
			return;
		}
		let invalidMember = false;
		let requestCapacityExceeded = false;
		for (const member of members) {
			if (!this.#connected) return;
			// JSON-RPC batches are flat; nested arrays and malformed envelopes
			// must never reach callbacks or recurse into untrusted structures.
			if (Array.isArray(member) || !isStreamMessage(member)) {
				invalidMember = true;
				continue;
			}
			// Server-to-client request: has both method and id.
			if ("method" in member && "id" in member && member.id != null) {
				if (this.#pendingSSEServerRequests >= MAX_PENDING_HTTP_SSE_SERVER_REQUESTS) {
					requestCapacityExceeded = true;
					// Apply reader backpressure instead of creating another unbounded
					// set of response POSTs when the handler budget is full.
					await this.#sendServerResponse({
						jsonrpc: "2.0",
						id: member.id,
						error: { code: -32000, message: "Server busy" },
					});
					continue;
				}
				this.#pendingSSEServerRequests++;
				void answerServerRequest(this.onRequest, member as JsonRpcRequest)
					.then(body => this.#sendServerResponse(body))
					.catch(() => logger.warn("MCP HTTP SSE server request could not be completed"))
					.finally(() => {
						this.#pendingSSEServerRequests--;
					});
				continue;
			}
			// Notification: has method but no id.
			if ("method" in member && !("id" in member)) {
				this.onNotification?.(member.method, member.params);
			}
		}
		// At most one static warning of each kind per SSE frame, regardless of
		// how many invalid or over-capacity members the peer supplied.
		if (invalidMember) logger.warn("Skipping invalid MCP HTTP SSE batch member");
		if (requestCapacityExceeded) logger.warn("MCP HTTP SSE server request capacity exceeded");
	}

	streamRequest(
		method: string,
		params: Record<string, unknown> | undefined,
		onNotification: (notification: JsonRpcMessage) => void,
		options?: MCPStreamRequestOptions,
	): MCPStreamRequest {
		if (!this.#connected) {
			throw new Error(mcpNotConnectedMessage({ url: this.config.url }, `stream request "${method}"`));
		}
		const id = Snowflake.next();
		options?.onRequestId?.(id);
		const controller = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		this.#streamRequests.set(id, controller);
		const { promise: done, resolve, reject } = Promise.withResolvers<void>();
		const requestParams = {
			...(params ?? {}),
			_meta: {
				...(params?._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta : {}),
				"io.modelcontextprotocol/subscriptionId": id,
			},
		};
		void (async () => {
			try {
				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					...this.config.headers,
				};
				if (this.#sessionId) headers["Mcp-Session-Id"] = this.#sessionId;
				const body = JSON.stringify({ jsonrpc: "2.0", id, method, params: requestParams });
				let response = await fetch(this.config.url, {
					method: "POST",
					headers,
					body,
					signal,
				});
				if (this.onAuthError && (response.status === 401 || response.status === 403)) {
					await response.body?.cancel();
					const refreshedHeaders = await untilAborted(signal, this.onAuthError());
					if (refreshedHeaders) {
						this.config = { ...this.config, headers: refreshedHeaders };
						response = await fetch(this.config.url, {
							method: "POST",
							headers: { ...headers, ...refreshedHeaders },
							body,
							signal,
						});
					}
				}
				if (response.ok && response.headers.get("Content-Type")?.includes("application/json")) {
					const raw: unknown = await untilAborted(signal, response.json());
					// A matching id alone does not establish a valid JSON-RPC 2.0
					// acknowledgement; reject malformed envelopes before accepting.
					if (!isStreamMessage(raw) || "method" in raw || raw.id !== id) {
						throw new Error("MCP event stream response has invalid JSON-RPC protocol or request identity");
					}
					const frame = raw as JsonRpcResponse;
					if (frame.error) {
						throw Object.assign(new Error(`MCP error ${frame.error.code}: ${frame.error.message}`), {
							code: frame.error.code,
							data: frame.error.data,
						});
					}
					if (!("result" in frame)) throw new Error("MCP event stream response has no result");
					this.#acceptInitializationSessionHeader(response, method);
					resolve();
					return;
				}
				if (
					!response.ok ||
					!response.body ||
					!response.headers.get("Content-Type")?.includes("text/event-stream")
				) {
					await response.body?.cancel();
					throw new Error(
						mcpHttpFailureMessage(this.config.url, response.status, "Event stream response required"),
					);
				}
				for await (const frame of readSseEvents(response.body, signal)) {
					if (frame.data === "") continue;
					if (frame.data === "[DONE]") break;
					let raw: unknown;
					try {
						raw = JSON.parse(frame.data);
					} catch {
						logger.warn("Skipping invalid JSON in MCP event stream", { url: this.config.url });
						continue;
					}
					const messages = Array.isArray(raw) ? raw : [raw];
					for (const value of messages) {
						if (!isStreamMessage(value)) {
							logger.warn("Skipping invalid MCP event stream message", { url: this.config.url });
							continue;
						}
						const message = value;
						if (!("method" in message) && message.id === id && ("result" in message || "error" in message)) {
							if (message.error) {
								throw Object.assign(new Error(`MCP error ${message.error.code}: ${message.error.message}`), {
									code: message.error.code,
									data: message.error.data,
								});
							}
							this.#acceptInitializationSessionHeader(response, method);
							resolve();
							return;
						}
						if ("method" in message && typeof message.method === "string" && !("id" in message)) {
							const params = message.params;
							const meta = params && typeof params === "object" && "_meta" in params ? params._meta : undefined;
							const subscriptionId =
								meta && typeof meta === "object" && "io.modelcontextprotocol/subscriptionId" in meta
									? meta["io.modelcontextprotocol/subscriptionId"]
									: undefined;
							if (subscriptionId === id) {
								onNotification(message);
							} else if (
								subscriptionId === undefined &&
								message.method === "notifications/events/list_changed"
							) {
								this.onNotification?.(message.method, message.params);
							}
						}
					}
				}
				resolve();
			} catch (error) {
				if (!signal.aborted) reject(error instanceof Error ? error : new Error(String(error)));
				else resolve();
			} finally {
				this.#streamRequests.delete(id);
			}
		})();
		return {
			id,
			done,
			cancel: () => controller.abort(),
		};
	}
	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		const timeout = options?.timeoutMs ?? resolveMCPTimeoutMs(this.config.timeout);
		const signal = options?.signal
			? AbortSignal.any([options.signal, this.#requestController.signal])
			: this.#requestController.signal;
		const operation = createMCPTimeout(timeout, signal);
		try {
			return await this.#executeRequest<T>(method, params, options, operation, timeout);
		} catch (error) {
			// Retry once on auth failure if onAuthError is wired and operation has not aborted
			const status = error instanceof Error ? AIError.status(error) : undefined;
			if (this.onAuthError && (status === 401 || status === 403) && !operation.signal?.aborted) {
				try {
					const newHeaders = await untilAborted(operation.signal, this.onAuthError());
					if (newHeaders && !operation.signal?.aborted) {
						// Persist refreshed headers so subsequent requests use them directly
						this.config = { ...this.config, headers: newHeaders };
						const retryParams = await untilAborted(operation.signal, rebuildMCPToolCallParamsForAttempt(params));
						return await this.#executeRequest<T>(method, retryParams, options, operation, timeout);
					}
				} catch (authError) {
					if (operation.isTimeoutAbort(authError)) {
						throw new Error(mcpTimeoutMessage({ url: this.config.url }, `request "${method}"`, timeout));
					}
					throw authError;
				}
			}
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.config.url }, `request "${method}"`, timeout));
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
		operation: MCPTimeoutOperation,
		timeout: number,
	): Promise<T> {
		if (!this.#connected) {
			throw new Error(mcpNotConnectedMessage({ url: this.config.url }, `request "${method}"`));
		}

		const id = Snowflake.next();
		options?.onRequestId?.(id);
		const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: params ?? {} };

		try {
			const response = await postJsonRpc(this.#postTarget, this.config.url, body, operation.signal);
			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream")) {
				return await this.#parseSSEResponse<T>(response, id, operation, timeout);
			}
			const result = (await untilAborted(operation.signal, response.json())) as JsonRpcResponse;
			if (result.error) throw new Error(describeJsonRpcError(result.error));
			return result.result as T;
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.config.url }, `request "${method}"`, timeout));
			}
			throw error;
		}

		const response = await fetch(this.config.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: operation.signal,
		});

		if (!response.ok) {
			const text = await untilAborted(operation.signal, response.text());
			const wwwAuthenticate = response.headers.get("WWW-Authenticate");
			const mcpAuthServer = response.headers.get("Mcp-Auth-Server");
			const authHints = [
				wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate}` : null,
				mcpAuthServer ? `Mcp-Auth-Server: ${mcpAuthServer}` : null,
			]
				.filter(Boolean)
				.join("; ");
			throw new Error(mcpHttpFailureMessage(this.config.url, response.status, text, authHints || undefined));
		}

		const contentType = response.headers.get("Content-Type") ?? "";

		// Handle SSE response
		if (contentType.includes("text/event-stream")) {
			return this.#parseSSEResponse<T>(response, id, method, operation, timeout);
		}

		// Handle JSON response. HTTP 200 does not establish JSON-RPC request identity:
		// a stale reply cannot become the current tool call's result.
		const raw: unknown = await untilAborted(operation.signal, response.json());
		if (
			!raw ||
			typeof raw !== "object" ||
			Array.isArray(raw) ||
			!("jsonrpc" in raw) ||
			raw.jsonrpc !== "2.0" ||
			!("id" in raw) ||
			raw.id !== id
		) {
			throw new Error("MCP HTTP server returned a JSON-RPC response with invalid protocol or request identity");
		}
		// Response envelopes need exactly one success/error branch. Otherwise
		// a matching-id HTTP 200 can appear to succeed with an undefined result.
		const envelope = raw as Record<string, unknown>;
		const hasResult = Object.hasOwn(envelope, "result");
		const hasError = Object.hasOwn(envelope, "error");
		if (hasResult === hasError) {
			throw new Error("MCP HTTP server returned a JSON-RPC response with invalid result/error shape");
		}
		if (hasError) {
			const peerError = envelope.error;
			if (
				!peerError ||
				typeof peerError !== "object" ||
				Array.isArray(peerError) ||
				!("code" in peerError) ||
				!Number.isSafeInteger(peerError.code) ||
				!("message" in peerError) ||
				typeof peerError.message !== "string"
			) {
				throw new Error("MCP HTTP server returned a JSON-RPC response with invalid error shape");
			}
		}
		const result = raw as JsonRpcResponse;
		if (result.error) {
			throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
		}

		this.#acceptInitializationSessionHeader(response, method);
		return result.result as T;
	}

	#parseSSEResponse<T>(
		response: Response,
		expectedId: string | number,
		method: string,
		operation: MCPTimeoutOperation,
		timeout: number,
	): Promise<T> {
		if (!response.body) {
			throw new Error(mcpEmptyResponseBodyMessage({ url: this.config.url }));
		}

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
				for await (const raw of readSseJson<JsonRpcMessage | JsonRpcMessage[]>(response.body!, signal)) {
					const messages = Array.isArray(raw) ? raw : [raw];
					for (const message of messages) {
						// Server-to-client requests can have their own ids. Only a
						// matching response-shaped frame claims this tool's result.
						const correlated =
							isRecord(message) &&
							message.id === expectedId &&
							(!("method" in message) || "result" in message || "error" in message);
						if (!captured && correlated) {
							captured = true;
							operation.clear();
							// SSE and JSON responses must satisfy the same JSON-RPC 2.0
							// union/id boundary before a tool result is accepted.
							if (!isStreamMessage(message) || "method" in message) {
								reject(new Error("MCP HTTP SSE response has invalid JSON-RPC envelope"));
								continue;
							}
							if ("error" in message) {
								reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
							} else {
								try {
									this.#acceptInitializationSessionHeader(response, method);
									resolve(message.result as T);
								} catch (error) {
									reject(error instanceof Error ? error : new Error("Invalid MCP initialization session"));
								}
							}
							continue;
						}
						if (!isStreamMessage(message)) {
							logger.warn("Skipping invalid MCP HTTP SSE stream frame");
							continue;
						}
						if (!this.#connected) continue;
						await this.#dispatchSSEMessage(message);
					}
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
			}
		};

		void drain();
		return promise;
	}

	/**
	 * POST a JSON-RPC response back to the server (for server-to-client requests
	 * received via SSE).
	 *
	 * A failure here used to be swallowed with the comment "best-effort response
	 * delivery". It is not best-effort from the server's side: the server asked a
	 * question (a sampling or elicitation request), we did the work to answer it,
	 * and then dropped the answer on the floor. The server waits on a reply that
	 * is never coming, and the operator sees an MCP tool that hangs with nothing
	 * anywhere connecting the hang to the send that failed (Law 10).
	 *
	 * Delivery is still not retried beyond the existing auth retry, because a
	 * dead connection cannot be talked into life from here. What changes is that
	 * the undelivered reply is reported.
	 */
	async #sendServerResponse(body: ServerRequestResponse): Promise<void> {
		if (!this.#connected) return;
		await deliverServerResponse(this.#postTarget, this.config.url, body, resolveMCPTimeoutMs(this.config.timeout));
	}
	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new Error(mcpNotConnectedMessage({ url: this.config.url }, `notification "${method}"`));
		}

		const body: JsonRpcNotification = { jsonrpc: "2.0", method, params: params ?? {} };

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#requestController.signal);

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
					const readOperation = createMCPTimeout(timeout, this.#requestController.signal);
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
		this.#requestController.abort(new DOMException("MCP transport was closed by this client", "AbortError"));
		for (const controller of this.#streamRequests.values()) controller.abort();
		this.#streamRequests.clear();

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
