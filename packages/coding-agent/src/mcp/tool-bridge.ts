/**
 * MCP to CustomTool bridge.
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 */

import type { AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai";
import { namesDeadSocket } from "@veyyon/ai/error/flags";
import { normalizeSchemaForMCP } from "@veyyon/ai/utils/schema";
import { errorMessage, isAbortError, isRecord, untilAborted } from "@veyyon/utils";
import type { ToolViewRenderer } from "@veyyon/view";
import { INTENT_FIELD } from "@veyyon/wire";
import type { SourceMeta } from "../discovery/capability/types";
import type { CustomTool, CustomToolContext, CustomToolResult } from "../extensibility/custom-tools/types";
import { resolveLocalUrlToFile } from "../internal-urls/local-protocol";
import { resolveProviderTextTransform, transformProviderPayload } from "../provider-boundary";
import type { OutputMeta } from "../tools/core/output-notice";
import { normalizeLocalScheme } from "../tools/core/path-utils";
import { ToolAbortError, throwIfAborted, toolAbort } from "../tools/core/tool-errors";
import { callTool } from "./client";
import { retainMCPToolArgsAttemptFactory } from "./transports/http";
import { isMCPTransportStateMessage } from "./transports/transport-failure";
import type { MCPContent, MCPServerConnection, MCPToolCallParams, MCPToolCallResult, MCPToolDefinition } from "./types";
import { createMCPToolView } from "./view";

/** Reconnect callback: tears down stale connection, returns new one or null. */
export type MCPReconnect = () => Promise<MCPServerConnection | null>;

/**
 * Whether a failed MCP call is worth tearing the connection down and sending once more.
 *
 * Two kinds of fault qualify, and they belong to different layers. The socket vocabulary is the
 * error registry's — a refused, reset or unreachable peer reads the same in every package — and this
 * module used to keep nine literals of its own beside it. What is local is the SHAPE of a stale MCP
 * session: a server that restarted answers the old session id with 404, and a proxy in front of it
 * with 502 or 503, so those three statuses mean "reconnect" here and mean "the peer is alive and
 * failing" to a provider call. A live server returning 500 stays a failed tool call.
 */
export function mcpFailureWarrantsReconnect(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	// Stale session (server restarted, old session ID is gone). Unanchored on
	// purpose: `mcpHttpFailureMessage` leads with the URL that failed, so the
	// status now sits mid-sentence ("... failed: HTTP 404: ..."). The old
	// `/^http (404|502|503):/` still matched only the shape that builder
	// replaced, so every stale-session reconnect had stopped firing.
	if (/\bhttp (404|502|503)\b/.test(msg)) return true;
	// The transports' own wording for a dead connection, owned next to the
	// strings rather than duplicated as literals here.
	if (isMCPTransportStateMessage(msg)) return true;
	return namesDeadSocket(msg);
}

type MCPToolArgs = NonNullable<MCPToolCallParams["arguments"]>;
const MCP_TOOL_CALL_BOUNDARY = "MCP tool call";

function normalizeToolArgs(value: unknown): MCPToolArgs {
	if (!isRecord(value)) {
		return {};
	}
	return value as MCPToolArgs;
}

function isUnusedOptionalPlaceholder(value: unknown): boolean {
	return value === undefined || value === "" || (isRecord(value) && Object.keys(value).length === 0);
}

function omitUnusedOptionalArgs(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	const properties = inputSchema.properties;
	if (!properties) return args;

	let cleaned: MCPToolArgs | undefined;
	const required = new Set(inputSchema.required ?? []);
	for (const [key, value] of Object.entries(args)) {
		if (required.has(key) || !Object.hasOwn(properties, key) || !isUnusedOptionalPlaceholder(value)) {
			continue;
		}
		cleaned ??= { ...args };
		delete cleaned[key];
	}

	return cleaned ?? args;
}

/**
 * Drop the harness-internal intent field (`INTENT_FIELD`) before forwarding
 * args to an MCP server. The harness injects `i` into every tool's wire
 * schema; the direct model tool-call path strips it via `extractIntent`, but
 * the `eval` `tool.*` bridge and any other in-process caller forwards args
 * verbatim. Strict-schema servers (Linear, anything with
 * `additionalProperties:false` / Zod `.strict()`) reject every call that
 * carries `i`. The MCP boundary is the authoritative guard so callers don't
 * have to pre-strip.
 *
 * Leaves `i` in place when the server's own `inputSchema.properties` declares
 * it, so a server that legitimately uses `i` as a parameter is unaffected.
 */
function stripHarnessIntent(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	if (!Object.hasOwn(args, INTENT_FIELD)) return args;
	if (inputSchema.properties && Object.hasOwn(inputSchema.properties, INTENT_FIELD)) return args;
	const { [INTENT_FIELD]: _intent, ...rest } = args;
	return rest;
}

async function resolveOutboundLocalUrlArgs(
	value: unknown,
	context: CustomToolContext,
	seen: WeakSet<object> = new WeakSet(),
): Promise<unknown> {
	if (typeof value === "string") {
		const normalized = normalizeLocalScheme(value);
		if (!normalized.startsWith("local://")) return value;
		const localFile = await resolveLocalUrlToFile(normalized, {
			cwd: context.sessionManager?.getCwd?.(),
			settings: context.settings,
			localProtocolOptions: context.localProtocolOptions,
		});
		return localFile?.path ?? value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (Array.isArray(value)) {
		let resolved: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const next = await resolveOutboundLocalUrlArgs(item, context, seen);
			if (next === item && !resolved) continue;
			resolved ??= value.slice();
			resolved[index] = next;
		}
		return resolved ?? value;
	}

	const input = value as Record<string, unknown>;
	let resolved: Record<string, unknown> | undefined;
	for (const key in input) {
		const item = input[key];
		const next = await resolveOutboundLocalUrlArgs(item, context, seen);
		if (next === item && !resolved) continue;
		resolved ??= { ...input };
		resolved[key] = next;
	}
	return resolved ?? value;
}

/**
 * Build one physical tools/call attempt from the untouched caller params.
 * Session-local URLs are expanded first. Only after that asynchronous local
 * work completes do we resolve the live provider transform and recursively
 * transform every outbound string key and value.
 */
async function prepareOutboundArgs(
	params: unknown,
	inputSchema: MCPToolDefinition["inputSchema"],
	context: CustomToolContext,
): Promise<MCPToolArgs> {
	const args = omitUnusedOptionalArgs(stripHarnessIntent(normalizeToolArgs(params), inputSchema), inputSchema);
	const localArgs = (await resolveOutboundLocalUrlArgs(args, context)) as MCPToolArgs;
	const transform = resolveProviderTextTransform(() => context.obfuscateProviderText, MCP_TOOL_CALL_BOUNDARY);
	const transformedArgs = transformProviderPayload(localArgs, transform, MCP_TOOL_CALL_BOUNDARY) as MCPToolArgs;
	return retainMCPToolArgsAttemptFactory({ ...transformedArgs }, () =>
		prepareOutboundArgs(params, inputSchema, context),
	);
}

/** Details included in MCP tool results for rendering */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}
/**
 * Format MCP content for LLM consumption.
 */
function formatMCPContent(content: MCPContent[]): string {
	const parts: string[] = [];

	for (const item of content) {
		switch (item.type) {
			case "text":
				parts.push(item.text);
				break;
			case "image":
				parts.push(`[Image: ${item.mimeType}]`);
				break;
			case "resource":
				if (item.resource.text) {
					parts.push(`[Resource: ${item.resource.uri}]\n${item.resource.text}`);
				} else {
					parts.push(`[Resource: ${item.resource.uri}]`);
				}
				break;
		}
	}

	return parts.join("\n\n");
}

/**
 * Whether `text` repeats any argument VALUE of this call. Keys are never
 * matched: they come from the tool's own schema, and a server that rejects a
 * call ordinarily names the field it rejected ("image_path is required"), which
 * withheld every such error under the old key check while protecting nothing.
 */
function containsRawToolArgument(text: string, value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
	if (typeof value === "string") return value.length > 0 && text.includes(value);
	if (value === null || typeof value !== "object" || seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some(item => containsRawToolArgument(text, item, seen));
	return Object.values(value).some(item => containsRawToolArgument(text, item, seen));
}

/**
 * The MODEL is the first reader of every message below, and that decides the wording.
 *
 * A failing MCP tool used to hand the model `MCP error: Transport not connected`.
 * The model cannot open a selector, cannot read a docs page, and cannot run a
 * slash command, so a message that names only the failure leaves it exactly two
 * behaviours: call the same tool again with the same arguments, or abandon the
 * task. Both cost eval score directly, and the retry loop costs turns as well.
 *
 * So the model's action is stated explicitly: a retry budget of one, and an
 * escalation with the facts to escalate. The operator-facing fix (`/mcp
 * reconnect`, a `timeout` in the config, a `reauth`) is already inside `detail`,
 * put there by the layer that knows it: see `transports/transport-failure.ts`
 * and `transports/http-failure.ts`. This layer adds only what it alone knows:
 * who is reading.
 */
const MODEL_NEXT_STEP =
	"Next step: retry this call at most once. A transport, auth or configuration failure returns the same error on every attempt, so a retry loop costs turns and changes nothing. If a second attempt fails, stop calling this tool and tell the operator what failed, which server it was on, and the fix named above.";

/** `serverName` and `mcpToolName` come from config and the tool schema, never from the caller's arguments, so naming them cannot leak one. */
function mcpToolFailureText(serverName: string, mcpToolName: string, detail: string): string {
	return `MCP tool "${mcpToolName}" on server "${serverName}" failed: ${detail}\n${MODEL_NEXT_STEP}`;
}

/**
 * The error text, or an explanation of its absence.
 *
 * When a server echoes the call's arguments back inside its error, the error is
 * withheld: a tool argument can carry a credential and the transcript is
 * re-read on every turn. The old fallback for that case was the bare sentence
 * "MCP request failed.", which told the model neither what happened nor that
 * anything had been withheld, so it read as a transport failure and got retried.
 */
function safeMCPErrorMessage(error: unknown, rawParams: unknown): string {
	const message = errorMessage(error);
	if (!containsRawToolArgument(message, rawParams)) return message;
	return "the server's error message echoed this call's arguments back, so it was withheld to keep credentials out of the transcript. Change the arguments and call again, or ask the operator to check the server's own logs for the real error.";
}

/**
 * One execution of an MCP tool: what it sends, and which server and source its result names.
 *
 * `source` attributes the result when the connection that served it has no source of its own: the
 * connection the tool was built on, or the server's discovered source for a tool built before its
 * server connected.
 */
interface MCPCall {
	readonly tool: MCPToolDefinition;
	readonly serverName: string;
	readonly source: SourceMeta | undefined;
	readonly rawParams: unknown;
	readonly ctx: CustomToolContext;
	readonly signal: AbortSignal | undefined;
}

/** Build a CustomToolResult from the callTool response `connection` returned. */
function buildResult(
	call: MCPCall,
	connection: MCPServerConnection,
	result: MCPToolCallResult,
): CustomToolResult<MCPToolDetails> {
	const { serverName, rawParams } = call;
	const mcpToolName = call.tool.name;
	const source = connection._source ?? call.source;
	const text = formatMCPContent(result.content);
	const leaksRawArgs = result.isError === true && containsRawToolArgument(text, rawParams);
	const details: MCPToolDetails = {
		serverName,
		mcpToolName,
		isError: result.isError,
		...(leaksRawArgs ? {} : { rawContent: result.content }),
		provider: source?.provider,
		providerName: source?.providerName,
	};
	const contentText = result.isError
		? mcpToolFailureText(
				serverName,
				mcpToolName,
				leaksRawArgs
					? "the server reported an error whose text echoed this call's arguments, so it was withheld to keep credentials out of the transcript. Change the arguments and call again, or ask the operator to check the server's own logs."
					: text,
			)
		: text;
	const toolResult: CustomToolResult<MCPToolDetails> = { content: [{ type: "text", text: contentText }], details };
	if (result.isError) {
		toolResult.isError = true;
	}
	return toolResult;
}

/** Build an error CustomToolResult from a caught exception; `connection` is the one the call failed on, if any. */
function buildErrorResult(
	call: MCPCall,
	connection: MCPServerConnection | undefined,
	error: unknown,
): CustomToolResult<MCPToolDetails> {
	const { serverName } = call;
	const mcpToolName = call.tool.name;
	const source = connection?._source ?? call.source;
	const message = safeMCPErrorMessage(error, call.rawParams);
	return {
		content: [{ type: "text", text: mcpToolFailureText(serverName, mcpToolName, message) }],
		details: {
			serverName,
			mcpToolName,
			isError: true,
			provider: source?.provider,
			providerName: source?.providerName,
		},
		isError: true,
	};
}

/**
 * Re-throw abort-related errors so they bypass error-result handling.
 *
 * The guard itself was always right: it fires before every error-to-result
 * conversion, which is why a cancelled MCP call was never quietly turned into a
 * tool result. What it used to lose was WHY. Two of its three branches minted a
 * bare `new ToolAbortError()`, so an MCP call stopped by an expired deadline, by
 * a parent tool cancelling a child, or by the call's own timeout all reached the
 * operator as the generic "Operation aborted", and the `TimeoutError` identity
 * that distinguishes a deadline from an Escape was dropped with the message.
 *
 * Both branches now go through `toolAbort` / `throwIfAborted`, the same owners
 * the tools layer uses, so the reason survives in the message and on `cause`.
 * `what` names the operation for the case where nothing else says anything.
 */
function rethrowIfAborted(error: unknown, signal?: AbortSignal, what = "MCP call"): void {
	if (error instanceof ToolAbortError) throw error;
	if (isAbortError(error)) throw toolAbort(error, what);
	throwIfAborted(signal, what);
}

async function reconnectWithAbort(reconnect: MCPReconnect, signal?: AbortSignal): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, reconnect);
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

/** Send `call` over `connection`. Throws what the send throws. */
async function sendMCPCall(call: MCPCall, connection: MCPServerConnection): Promise<CustomToolResult<MCPToolDetails>> {
	// Built per attempt from the raw arguments, so a resend applies the provider transform current at that time.
	const args = await prepareOutboundArgs(call.rawParams, call.tool.inputSchema, call.ctx);
	throwIfAborted(call.signal);
	return buildResult(call, connection, await callTool(connection, call.tool.name, args, { signal: call.signal }));
}

/**
 * Reconnect and send `call` once more. Resolves null when the reconnect yields no connection; a
 * failure of the second send is returned as the result. `onConnection` receives the new connection
 * before the send.
 */
async function resendMCPCall(
	call: MCPCall,
	reconnect: MCPReconnect,
	onConnection?: (connection: MCPServerConnection) => void,
): Promise<CustomToolResult<MCPToolDetails> | null> {
	const connection = await reconnectWithAbort(reconnect, call.signal);
	if (!connection) return null;
	onConnection?.(connection);
	try {
		return await sendMCPCall(call, connection);
	} catch (error) {
		rethrowIfAborted(error, call.signal);
		return buildErrorResult(call, connection, error);
	}
}

/**
 * Send `call` over `connection`, and once more over a reconnected one when the failure is one a
 * reconnect cures ({@link mcpFailureWarrantsReconnect}). Aborts propagate; other failures become
 * the result.
 */
async function sendMCPCallWithReconnect(
	call: MCPCall,
	connection: MCPServerConnection,
	reconnect: MCPReconnect | undefined,
	onConnection?: (connection: MCPServerConnection) => void,
): Promise<CustomToolResult<MCPToolDetails>> {
	try {
		return await sendMCPCall(call, connection);
	} catch (error) {
		rethrowIfAborted(error, call.signal);
		const resent =
			reconnect && mcpFailureWarrantsReconnect(error) ? await resendMCPCall(call, reconnect, onConnection) : null;
		return resent ?? buildErrorResult(call, connection, error);
	}
}

/**
 * Reduce a server or tool name to the characters a tool name may contain.
 *
 * DIGITS ARE KEPT. They used to be replaced along with everything else, which
 * made `github1` and `github2` sanitize to the same `github` — two different
 * servers producing byte-identical tool names, so one silently shadowed the
 * other in the registry and calls went wherever the lookup happened to land.
 * Numbered server names are ordinary (`mcp-server-1`, `jira2`), and every
 * provider accepts digits in a tool name, so dropping them bought nothing and
 * cost correctness.
 */
function sanitizeMCPToolNamePart(value: string, fallback: string, keepDigits = true): string {
	const sanitized = value
		.toLowerCase()
		.replace(keepDigits ? /[^a-z0-9_]+/g : /[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * The `mcp__<server>_` prefix every tool from `serverName` carries.
 *
 * One owner, because two callers need the exact same string and derived it
 * separately: `createMCPToolName` built it from the SANITIZED server name while
 * the manager's reconnect path filtered on the RAW one. For any server whose
 * name needed sanitizing the two never matched, so a reconnect failed to drop
 * the previous tools and pushed a second copy of every one of them.
 */
export function mcpToolNamePrefix(serverName: string, keepDigits = true): string {
	return `mcp__${sanitizeMCPToolNamePart(serverName, "server", keepDigits)}_`;
}

/**
 * Shared mint pipeline. `keepDigits` selects the sanitizer variant: the
 * current mint keeps `0-9`, the legacy variant strips them exactly as the
 * pre-fix `sanitizeMCPToolNamePart` did. Both halves route through this one
 * function so the two mints can only ever differ by that character class —
 * if the prefix-strip or prefix rules change, the legacy alias changes with them.
 */
function mintMCPToolName(serverName: string, toolName: string, keepDigits: boolean): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server", keepDigits);
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool", keepDigits);

	// Strip redundant server name prefix from tool name if present
	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return `${mcpToolNamePrefix(serverName, keepDigits)}${normalizedToolName}`;
}

/**
 * Mint the name {@link createMCPToolName} produced before digits were kept in
 * sanitized parts (`[^a-z_]+` collapsed to `_`). Digit-bearing servers/tools
 * were renamed by that fix, so user config keys written against the old form
 * (`tools.approval`, `tools.xdevInlineDevices`) would no longer match.
 * Approval resolution consults this legacy key as a fail-closed fallback.
 * Returns `undefined` when minting is unchanged (no digits involved).
 */
export function createLegacyMCPToolName(serverName: string, toolName: string): string | undefined {
	const legacyName = mintMCPToolName(serverName, toolName, false);
	const currentName = createMCPToolName(serverName, toolName);
	return legacyName !== currentName ? legacyName : undefined;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	return mintMCPToolName(serverName, toolName, true);
}

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith("mcp__")) return null;

	const rest = name.slice(5);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

/**
 * The fields every MCP-backed tool exposes, built from its server name and tool definition. The
 * subclass sets how a call reaches the server.
 */
abstract class MCPToolBase implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;
	/**
	 * MCP-backed tools opt out of strict structured-output grammar. The server
	 * owns validation, and strict mode makes OpenAI-family models over-fill
	 * mutually exclusive optional fields (#4336/#4340). Serializers preserve an
	 * explicit `false`; an omitted flag would leave nothing to preserve.
	 */
	readonly strict = false as const;
	/** The card this tool draws, bound to the `server/tool` its call row names. */
	readonly view: Required<ToolViewRenderer<unknown, CustomToolResult<MCPToolDetails>>>;

	constructor(serverName: string, tool: MCPToolDefinition) {
		this.name = createMCPToolName(serverName, tool.name);
		this.label = `${serverName}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${serverName}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = serverName;
		this.view = createMCPToolView(this.label);
	}

	abstract execute(
		toolCallId: string,
		params: unknown,
		onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>>;
}

/**
 * CustomTool wrapping an MCP tool with an active connection.
 */
export class MCPTool extends MCPToolBase {
	/** Create MCPTool instances for all tools from an MCP server connection */
	static fromTools(connection: MCPServerConnection, tools: MCPToolDefinition[], reconnect?: MCPReconnect): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
	) {
		super(connection.name, tool);
	}

	/** A reconnected connection serves this instance's later calls too. */
	readonly #rebind = (connection: MCPServerConnection): void => {
		this.connection = connection;
	};

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const connection = this.connection;
		const call: MCPCall = {
			tool: this.tool,
			serverName: this.mcpServerName,
			source: connection._source,
			rawParams: params,
			ctx,
			signal,
		};
		return sendMCPCallWithReconnect(call, connection, this.reconnect, this.#rebind);
	}
}

/**
 * CustomTool wrapping an MCP tool with deferred connection resolution.
 */
export class DeferredMCPTool extends MCPToolBase {
	/** Create DeferredMCPTool instances for all tools from an MCP server */
	static fromTools(
		serverName: string,
		tools: MCPToolDefinition[],
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
	): DeferredMCPTool[] {
		return tools.map(tool => new DeferredMCPTool(serverName, tool, getConnection, source, reconnect));
	}

	constructor(
		serverName: string,
		private readonly tool: MCPToolDefinition,
		private readonly getConnection: () => Promise<MCPServerConnection>,
		private readonly source?: SourceMeta,
		private readonly reconnect?: MCPReconnect,
	) {
		super(serverName, tool);
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const call: MCPCall = {
			tool: this.tool,
			serverName: this.mcpServerName,
			source: this.source,
			rawParams: params,
			ctx,
			signal,
		};
		let connection: MCPServerConnection;
		try {
			connection = await untilAborted(signal, () => this.getConnection());
		} catch (error) {
			// The server never connected or its connection is gone. Unlike a failed call, this always
			// warrants a reconnect: "MCP server not connected" is not a transport failure that
			// mcpFailureWarrantsReconnect recognizes.
			rethrowIfAborted(error, signal);
			const resent = this.reconnect ? await resendMCPCall(call, this.reconnect) : null;
			return resent ?? buildErrorResult(call, undefined, error);
		}
		throwIfAborted(signal);
		return sendMCPCallWithReconnect(call, connection, this.reconnect);
	}
}
