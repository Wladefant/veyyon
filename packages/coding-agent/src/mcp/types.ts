/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Based on MCP specification 2025-03-26:
 * https://modelcontextprotocol.io/specification/2025-03-26/
 */

// =============================================================================
// JSON-RPC 2.0 Types
// =============================================================================

import type { SourceMeta } from "../discovery/capability/types";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

/**
 * A JSON-RPC response from an MCP server, for every transport this package speaks.
 *
 * `T` names the shape of `result` when the caller knows it. `json-rpc.ts` declared its own
 * generic copy of this interface one directory over, with the error object written out inline
 * instead of naming {@link JsonRpcError}, so the two could disagree about `data` without anything
 * comparing them. The transports (`stdio`, `http`, `sse`) already used this one.
 */
export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	/**
	 * `null` when the server could not attribute the answer to a request.
	 *
	 * JSON-RPC 2.0 requires it for an error found before the id could be read: a parse error, an
	 * invalid envelope. This used to be typed `string | number`, so the case was not expressible
	 * and every transport's dispatcher tested `message.id != null` and dropped such a reply on the
	 * floor -- the caller's promise then sat until its timeout and reported that the server had not
	 * answered, when the server had answered and said exactly what was wrong.
	 */
	id: string | number | null;
	result?: T;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// =============================================================================
// MCP Server Configuration (.mcp.json format)
// =============================================================================

/** Authentication configuration for MCP servers */
export interface MCPAuthConfig {
	/** Authentication type */
	type: "oauth" | "apikey";
	/** Credential ID for OAuth (references agent.db) */
	credentialId?: string;
	/** Token endpoint URL — persisted for proactive token refresh */
	tokenUrl?: string;
	/** Client ID — persisted for token refresh */
	clientId?: string;
	/** Client secret — persisted for token refresh */
	clientSecret?: string;
	/** MCP resource URI — persisted for OAuth resource indicators during refresh */
	resource?: string;
}

/** Supported delivery modes for MCP Events */
export type MCPEventDeliveryMode = "poll" | "push" | "webhook";

/** Webhook delivery configuration for an event subscription */
export interface MCPEventWebhookConfig {
	/** Reachable HTTPS callback URL the MCP server will POST events to */
	callbackUrl: string;
	/** Loopback receiver port exposed through the configured callback relay */
	listenPort: number;
	/** Explicit environment variable reference to a Bitwarden-provisioned webhook signing secret */
	secretRef: string;
}

/** Explicit event subscription configuration */
export interface MCPServerEventSubscriptionConfig {
	/** Event name to subscribe to, matching an advertised event from events/list */
	name: string;
	/** Delivery mode for this event subscription: poll, push, or webhook */
	mode: MCPEventDeliveryMode;
	/** Optional subscription arguments conforming to the event inputSchema */
	arguments?: Record<string, unknown>;
	/** Webhook delivery configuration (required when mode is "webhook") */
	webhook?: MCPEventWebhookConfig;
}

/** Per-server event subscriptions configuration (opt-in draft MCP Events support) */
export interface MCPServerEventsConfig {
	/** Whether event subscriptions are enabled for this server (default: false, opt-in) */
	enabled?: boolean;
	/** Explicit list of event subscriptions for this server */
	subscriptions?: MCPServerEventSubscriptionConfig[];
}

/** Base server config with shared options */
interface MCPServerConfigBase {
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** MCP request timeout in milliseconds (default: 30000, 0 to disable) */
	timeout?: number;
	/** Authentication configuration (optional) */
	auth?: MCPAuthConfig;
	/** OAuth configuration for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		clientSecret?: string;
		/** Optional space-separated OAuth scopes overriding discovered scopes for DCR and authorization */
		scopes?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		/** `prompt` param for the authorization request (default "consent"; "" to omit) */
		prompt?: string;
	};
	/** Event subscriptions configuration (opt-in draft MCP Events support) */
	events?: MCPServerEventsConfig;
}

/** Stdio server configuration */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/**
	 * Ambient variables to forward to this server, by name.
	 *
	 * A stdio server sees only what a program needs in order to run (see
	 * `mcp/child-environment.ts`); a secret it legitimately needs is either written into `env` or
	 * named here. Naming one is the operator saying this server may read it.
	 */
	envPassthrough?: string[];
	/**
	 * Hand this server the WHOLE ambient environment, including every credential in it.
	 *
	 * Per server, never global, and the transport warns on every spawn that uses it. Prefer
	 * `envPassthrough`.
	 */
	inheritEnv?: boolean;
	cwd?: string;
}

/** HTTP server configuration (Streamable HTTP transport) */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
}

/** SSE server configuration (deprecated, use HTTP) */
export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json";

/** Root mcp.json/.mcp.json file structure */
export interface MCPConfigFile {
	$schema?: string;
	mcpServers?: Record<string, MCPServerConfig>;
	/** Names to hide regardless of any source `enabled` flag. Highest precedence. */
	disabledServers?: string[];
	/** Names to force-enable when a non-writable source reports `enabled: false`. */
	enabledServers?: string[];
}

// =============================================================================
// MCP Protocol Types
// =============================================================================

/** MCP implementation info */
export interface MCPImplementation {
	name: string;
	version: string;
}

/** MCP client capabilities */
export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean };
	sampling?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/** MCP server capabilities */
export interface MCPServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	events?: { listChanged?: boolean };
	logging?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/** Initialize request params */
export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: MCPClientCapabilities;
	clientInfo: MCPImplementation;
}

/** Initialize response result */
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: MCPImplementation;
	instructions?: string;
}

/** Draft MCP Events descriptor. */
export interface MCPEventDescriptor {
	name: string;
	description?: string;
	delivery: Array<"poll" | "push" | "webhook">;
	inputSchema: Record<string, unknown>;
	payloadSchema: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

export interface MCPEventOccurrence {
	eventId: string;
	name: string;
	timestamp: string;
	data: unknown;
	cursor?: string | null;
	_meta?: Record<string, unknown>;
}

export interface MCPEventsListResult {
	events: MCPEventDescriptor[];
	nextCursor?: string;
}

export interface MCPEventsPollResult {
	events: MCPEventOccurrence[];
	cursor?: string | null;
	truncated?: boolean;
	hasMore?: boolean;
	nextPollMs?: number;
}

/** Callback when an MCP event occurrence arrives from a server */
export type MCPEventCallback = (
	serverName: string,
	event: MCPEventOccurrence,
	subscriptionKey: string,
) => void | "queued" | "duplicate" | Promise<void | "queued" | "duplicate">;

/** Payload for durable per-session MCP event state persistence */
export interface MCPEventStatePayload {
	subscriptionKey?: string;
	cursor?: string;
	seenEventIds?: string[];
	eventId?: string;
	event?: MCPEventOccurrence;
	pendingEvent?: MCPEventOccurrence;
	enqueued?: boolean;
}

/**
 * Returns true if event subscriptions are explicitly enabled and configured on the server config.
 * Disabled or empty config causes no event requests.
 */
export function isMCPEventsEnabled(config?: MCPServerEventsConfig): boolean {
	return config?.enabled === true && Array.isArray(config.subscriptions) && config.subscriptions.length > 0;
}

/**
 * Validate an MCP server events configuration object.
 * Returns an array of human-readable error messages, or an empty array if valid.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateMCPEventsConfig(serverName: string, config: unknown): string[] {
	if (config === undefined || config === null) return [];
	if (!isRecord(config)) {
		return [`Server "${serverName}" has invalid "events" configuration: must be an object.`];
	}

	const errors: string[] = [];

	if ("enabled" in config && typeof config.enabled !== "boolean") {
		errors.push(`Server "${serverName}" "events.enabled" must be a boolean.`);
	}

	// Forbid raw secret fields at top-level events config
	if ("secret" in config || "rawSecret" in config) {
		errors.push(
			`Server "${serverName}" "events" sets a plaintext secret field. Plaintext secrets are forbidden in MCP config; use an explicit environment reference in "webhook.secretRef" instead.`,
		);
	}

	if ("subscriptions" in config && config.subscriptions !== undefined) {
		if (!Array.isArray(config.subscriptions)) {
			errors.push(`Server "${serverName}" "events.subscriptions" must be an array.`);
		} else {
			const validModes: readonly string[] = ["poll", "push", "webhook"];
			for (let i = 0; i < config.subscriptions.length; i++) {
				const sub = config.subscriptions[i];
				const prefix = `Server "${serverName}" events.subscriptions[${i}]`;
				if (!isRecord(sub)) {
					errors.push(`${prefix} must be an object.`);
					continue;
				}

				if (typeof sub.name !== "string" || sub.name.trim().length === 0) {
					errors.push(`${prefix} requires a non-empty string "name".`);
				}

				if (typeof sub.mode !== "string" || !validModes.includes(sub.mode)) {
					errors.push(
						`${prefix} "mode" must be one of "poll", "push", or "webhook" (got ${JSON.stringify(sub.mode)}).`,
					);
				}

				if ("arguments" in sub && sub.arguments !== undefined) {
					if (!isRecord(sub.arguments)) {
						errors.push(`${prefix} "arguments" must be an object if specified.`);
					}
				}

				if ("secret" in sub || "rawSecret" in sub) {
					errors.push(
						`${prefix} sets a plaintext secret field. Plaintext secrets are forbidden in MCP config; use "webhook.secretRef" instead.`,
					);
				}

				if (sub.mode === "webhook") {
					if (!("webhook" in sub) || !isRecord(sub.webhook)) {
						errors.push(
							`${prefix} mode "webhook" requires a "webhook" configuration object with "callbackUrl", "listenPort", and "secretRef".`,
						);
					} else {
						const wh = sub.webhook;

						if ("secret" in wh || "rawSecret" in wh) {
							errors.push(
								`${prefix}.webhook sets a plaintext "secret" field. Plaintext secrets are forbidden; use "secretRef" instead.`,
							);
						}

						if (typeof wh.callbackUrl !== "string" || wh.callbackUrl.trim().length === 0) {
							errors.push(`${prefix}.webhook requires a non-empty string "callbackUrl".`);
						} else {
							try {
								const parsedUrl = new URL(wh.callbackUrl);
								if (
									parsedUrl.protocol !== "https:" ||
									parsedUrl.username.length > 0 ||
									parsedUrl.password.length > 0 ||
									parsedUrl.hash.length > 0
								) {
									errors.push(
										`${prefix}.webhook "callbackUrl" must use HTTPS without embedded credentials or a fragment.`,
									);
								}
							} catch {
								errors.push(`${prefix}.webhook "callbackUrl" is not a valid URL: "${wh.callbackUrl}".`);
							}
						}

						if (typeof wh.secretRef !== "string" || wh.secretRef.trim().length === 0) {
							errors.push(
								`${prefix}.webhook requires an explicit $ENV or \${ENV} reference for a Bitwarden-provisioned signing secret.`,
							);
						} else if (!/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(wh.secretRef)) {
							errors.push(
								`${prefix}.webhook "secretRef" must be an explicit $ENV or \${ENV} reference; raw values and other secret stores are not supported.`,
							);
						}

						if (!Number.isInteger(wh.listenPort) || (wh.listenPort as number) < 1 || (wh.listenPort as number) > 65535) {
							errors.push(`${prefix}.webhook "listenPort" must be an integer from 1 through 65535.`);
						}
					}
				} else if ("webhook" in sub) {
					errors.push(`${prefix} "webhook" configuration is valid only when mode is "webhook".`);
				}
			}
		}
	}

	return errors;
}

/** MCP tool definition */
export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
}

/** tools/list response */
export interface MCPToolsListResult {
	tools: MCPToolDefinition[];
	nextCursor?: string;
}

/** tools/call params */
export interface MCPToolCallParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** Content types in tool results */
export interface MCPTextContent {
	type: "text";
	text: string;
}

export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** tools/call response */
export interface MCPToolCallResult {
	content: MCPContent[];
	isError?: boolean;
}

// =============================================================================
// Transport Types
// =============================================================================

export interface MCPRequestOptions {
	/** Abort signal (e.g. Escape-to-interrupt) */
	signal?: AbortSignal;
	/** Timeout in milliseconds (0 disables request deadline) */
	timeoutMs?: number;
	/** Synchronous callback receiving the allocated request ID before transmission */
	onRequestId?: (id: string | number) => void;
}

/** A long-lived request whose matching server notifications are delivered to its callback. */
export interface MCPStreamRequest {
	/** JSON-RPC id used to correlate this stream's notifications. */
	readonly id: string | number;
	/** Settles when the stream ends, is cancelled, or the transport closes. */
	readonly done: Promise<void>;
	/** Abort this stream without affecting other transport requests. */
	cancel(): void;
}

export type MCPStreamNotificationHandler = (notification: JsonRpcMessage) => void;

export type MCPStreamRequestOptions = MCPRequestOptions;

/** Transport interface - abstracts stdio/http */
export interface MCPTransport {
	/** Send a request and wait for response */
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;
	/** Start a long-lived request and deliver notifications correlated to its request id. */
	streamRequest?(
		method: string,
		params: Record<string, unknown> | undefined,
		onNotification: MCPStreamNotificationHandler,
		options?: MCPStreamRequestOptions,
	): MCPStreamRequest;

	/** Send a notification (no response expected) */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	/** Close the transport */
	close(): Promise<void>;

	/** Whether the transport is connected */
	readonly connected: boolean;

	/** Event handlers */
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	/** Handler for server-to-client requests (e.g. roots/list). Returns result or throws a JsonRpcError. */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/** Transport factory function */
export type TransportFactory = (config: MCPServerConfig) => Promise<MCPTransport>;

// =============================================================================
// MCP Client Types
// =============================================================================

/** Connected MCP server state */
export interface MCPServerConnection {
	/** Server name from config */
	name: string;
	/** Original config */
	config: MCPServerConfig;
	/** Transport instance */
	transport: MCPTransport;
	/** Server info from initialize */
	serverInfo: MCPImplementation;
	/** Server capabilities */
	capabilities: MCPServerCapabilities;
	/** Cached tools (populated on demand) */
	tools?: MCPToolDefinition[];
	/** Source metadata (for display) */
	_source?: SourceMeta;
	/** Cached resources (populated on demand) */
	resources?: MCPResource[];
	/** Cached resource templates (populated on demand) */
	resourceTemplates?: MCPResourceTemplate[];
	/** Server instructions from initialize */
	instructions?: string;
	/** Cached prompts (populated on demand) */
	prompts?: MCPPrompt[];
}

/** MCP tool with server context */
export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}

// =============================================================================
// MCP Resource Types
// =============================================================================

/** Annotations for resources, templates, and content blocks */
export interface MCPAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

/** A concrete resource exposed by an MCP server */
export interface MCPResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: MCPAnnotations;
}

/** A parameterized resource template (RFC 6570 URI template) */
export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: MCPAnnotations;
}

/** Result of resources/list */
export interface MCPResourcesListResult {
	resources: MCPResource[];
	nextCursor?: string;
}

/** Result of resources/templates/list */
export interface MCPResourceTemplatesListResult {
	resourceTemplates: MCPResourceTemplate[];
	nextCursor?: string;
}

/** A single content item from resources/read */
export interface MCPResourceContentItem {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** Result of resources/read */
export interface MCPResourceReadResult {
	contents: MCPResourceContentItem[];
}

/** Params for resources/read */
export interface MCPResourceReadParams {
	uri: string;
}

/** Params for resources/subscribe and resources/unsubscribe */
export interface MCPResourceSubscribeParams {
	uri: string;
}

// =============================================================================
// MCP Prompt Types
// =============================================================================

/** An argument definition for an MCP prompt */
export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** A prompt definition exposed by an MCP server */
export interface MCPPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

/** Result of prompts/list */
export interface MCPPromptsListResult {
	prompts: MCPPrompt[];
	nextCursor?: string;
}

/** Audio content in prompt messages */
export interface MCPAudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

/** Content type union for prompt messages */
export type MCPPromptContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

/** A single message in a prompt result */
export interface MCPPromptMessage {
	role: "user" | "assistant";
	content: MCPPromptContent | MCPPromptContent[];
}

/** Params for prompts/get */
export interface MCPGetPromptParams {
	name: string;
	arguments?: Record<string, string>;
}

/** Result of prompts/get */
export interface MCPGetPromptResult {
	description?: string;
	messages: MCPPromptMessage[];
}

// =============================================================================
// MCP Notification Method Names
// =============================================================================

/** MCP server notification method names */
export const MCPNotificationMethods = {
	TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
	RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
	RESOURCES_UPDATED: "notifications/resources/updated",
	PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
} as const;

/** Extract a JsonRpcError from a thrown value. Preserves `.code` and `.message` from Error instances or plain objects. */
export function toJsonRpcError(error: unknown): JsonRpcError {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "number" ? error.code : -32603;
		return { code, message: error.message };
	}
	if (typeof error === "string") {
		// Preserve throw-site strings — collapsing them to "Internal error" hides the cause.
		return { code: -32603, message: error.length > 0 ? error : "Internal error" };
	}
	if (typeof error === "object" && error !== null) {
		const obj = error as Record<string, unknown>;
		if (typeof obj.code === "number" && typeof obj.message === "string") {
			return { code: obj.code, message: obj.message };
		}
	}
	return { code: -32603, message: "Internal error" };
}

/** A response to a server-to-client request, whose id the transport always read. */
export type ServerRequestResponse = JsonRpcResponse & Pick<JsonRpcRequest, "id">;

/**
 * The JSON-RPC response a transport sends for a server-to-client request.
 *
 * A transport with no `onRequest` handler answers "Method not found", a handler that throws answers with
 * {@link toJsonRpcError} of the thrown value, and a handler that returns nothing answers an empty result.
 */
export async function answerServerRequest(
	onRequest: MCPTransport["onRequest"],
	request: JsonRpcRequest,
): Promise<ServerRequestResponse> {
	if (!onRequest) return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
	try {
		return { jsonrpc: "2.0", id: request.id, result: (await onRequest(request.method, request.params)) ?? {} };
	} catch (error) {
		return { jsonrpc: "2.0", id: request.id, error: toJsonRpcError(error) };
	}
}
