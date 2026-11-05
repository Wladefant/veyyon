/**
 * What a message from an MCP server is, and the one place every transport decides it.
 *
 * WHY THIS EXISTS. The stdio, Streamable HTTP and legacy SSE transports each classified a
 * server's messages with their own copy of the same branches, and the copies drifted: one read a
 * batch and another did not, one treated a method with a null id as a notification and two dropped
 * it, one logged a frame it could not read and two dropped it, and only two of the three reported an
 * error the server could not attribute to a request. {@link routeIncomingMessage} is the
 * classification; a transport supplies what it does with each kind.
 *
 * JSON-RPC 2.0 requires `"id": null` on an error found before the request's id could be read: a
 * parse error, an invalid envelope. A dispatcher that tests `message.id != null` matches such a
 * reply to neither a response nor a server request, and it has no `method`, so it was dropped
 * without a word. The caller's promise then sat until its timeout and reported that the server had
 * not answered, when the server had answered and named the problem. Veyyon's own memory server
 * emits exactly this shape (`err(null, -32700, "Parse error")` in `@veyyon/mnemopi`). A connection
 * that cannot parse what we send is broken for every request on it, not one, so an unattributable
 * error fails ALL of them with the server's own code and message.
 */
import { logger, truncate } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import type { JsonRpcError, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./types";

/** One in-flight request, as each transport's pending map holds it. */
export interface RejectablePendingRequest {
	reject(error: Error): void;
}

/** A response that names the request it answers. */
export type AttributedResponse = JsonRpcResponse & { id: string | number };

/** What a transport does with each kind of message its server sends. */
export interface IncomingMessageRoutes {
	/** The server as a log line identifies it: its URL or its command. */
	server(): string;
	/** A response to a request this client sent. */
	response(response: AttributedResponse): void;
	/** A request the server sends this client, which the transport answers. */
	serverRequest(request: JsonRpcRequest): void;
	/** A message with a method and no id to answer to. */
	notification(method: string, params: unknown): void;
	/** An error that names no request; see {@link isUnattributableError}. */
	unattributableError(error: JsonRpcError): void;
}

/**
 * The message is a response carrying an error that names no request.
 *
 * Requires `error` rather than accepting any null-id response: a null id with a `result` is not
 * something the spec produces, and treating it as a failure would invent one.
 */
export function isUnattributableError(message: JsonRpcMessage): message is JsonRpcResponse {
	return "id" in message && message.id === null && "error" in message && message.error != null;
}

/** The operator-facing text for a JSON-RPC error, in the one format every transport uses. */
export function describeJsonRpcError(error: { code: number; message: string }): string {
	return `MCP error ${error.code}: ${error.message}`;
}

/**
 * Fail every in-flight request with the server's error, and empty the map.
 *
 * @returns how many requests were failed, so a caller can log something truthful. Zero is a real
 *   outcome, not a no-op to hide: a server that reports a parse error while nothing is in flight
 *   still told us the connection is broken.
 */
export function rejectAllPending<TRequest extends RejectablePendingRequest>(
	pending: Map<string | number, TRequest>,
	error: { code: number; message: string },
	onEach?: (request: TRequest) => void,
): number {
	const failed = Array.from(pending.values());
	pending.clear();
	for (const request of failed) {
		onEach?.(request);
		request.reject(new Error(describeJsonRpcError(error)));
	}
	return failed.length;
}

/**
 * Log an unattributable error and return the error a transport passes to `onError`.
 *
 * @param failedRequests how many in-flight requests the error failed, from {@link rejectAllPending}.
 */
export function reportUnattributableError(server: string, error: JsonRpcError, failedRequests: number): Error {
	logger.warn("MCP server reported an error it could not attribute to a request", {
		server,
		code: error.code,
		message: error.message,
		failedRequests,
	});
	return new Error(describeJsonRpcError(error));
}

/**
 * Hand each message of one frame from a server to the route for its kind.
 *
 * A batch routes each member in order. A member with a `method` is a server request when it carries
 * an id and a notification when its id is absent or null. A member with an id and no `method` is a
 * response. A frame that is none of these is reported through {@link reportIgnoredMessage} and
 * dropped, because no route can act on it.
 */
export function routeIncomingMessage(frame: unknown, routes: IncomingMessageRoutes): void {
	if (Array.isArray(frame)) {
		for (const member of frame) routeIncomingMessage(member, routes);
		return;
	}
	if (!isRecord(frame)) {
		reportIgnoredMessage(routes.server(), frame, NOT_JSON_RPC);
		return;
	}
	const message = frame as unknown as JsonRpcMessage;
	if (isUnattributableError(message)) {
		routes.unattributableError(message.error as JsonRpcError);
		return;
	}
	const attributed = frame.id !== undefined && frame.id !== null;
	if (typeof frame.method === "string") {
		if (attributed) routes.serverRequest(message as JsonRpcRequest);
		else routes.notification(frame.method, frame.params);
		return;
	}
	if (attributed) {
		routes.response(message as AttributedResponse);
		return;
	}
	reportIgnoredMessage(routes.server(), frame, NOT_JSON_RPC);
}

const NOT_JSON_RPC = "not a JSON-RPC request, response or notification";

/**
 * Log a message from a server that no route acted on, with why. A dropped message may have been the
 * response a request is waiting for, so the report connects it to the hang the operator sees.
 */
export function reportIgnoredMessage(server: string, frame: unknown, reason: string): void {
	logger.warn("Ignored an unreadable message from an MCP server", {
		server,
		error: reason,
		// Truncated: a server can send an arbitrarily large frame, and the log identifies WHICH
		// message was lost rather than reproducing it.
		line: truncate(String(JSON.stringify(frame) ?? frame), 500),
		fix: "If a tool call from this server hangs, this is likely why. Check the server's own logs.",
	});
}
