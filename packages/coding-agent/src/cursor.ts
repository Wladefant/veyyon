import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type {
	Agent,
	AgentEvent,
	AgentToolCall,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	AnyAgentTool,
	PreparedToolCall,
	ReadyToolCall,
} from "@veyyon/agent-core";
import type {
	CursorMcpCall,
	CursorShellStreamCallbacks,
	CursorExecHandlers as ICursorExecHandlers,
	ToolResultMessage,
} from "@veyyon/ai";
import { errorMessage, sanitizeText } from "@veyyon/utils";
import { cursorMcpPrefersReplaceEdit, normalizeCursorReplaceArgs } from "./cursor-bridge-tools";
import { resolveToCwd } from "./tools/core/path-utils";

export interface CursorExecBridgeOptions {
	cwd: string;
	tools: Map<string, AnyAgentTool>;
	/**
	 * Prepares a call as the agent loop prepares the calls it dispatches: `i` stripped, arguments repaired, validated
	 * and transformed. Cursor runs these calls itself, outside the loop.
	 */
	prepareToolCall: (tool: AnyAgentTool, toolCall: AgentToolCall) => PreparedToolCall;
	getToolContext?: () => AgentToolContext | undefined;
	emitEvent?: (event: AgentEvent) => void;
	getEditReplaceTool?: () => AnyAgentTool | undefined | Promise<AnyAgentTool | undefined>;
}

function createToolResultMessage(
	toolCallId: string,
	toolName: string,
	result: AgentToolResult<unknown>,
	isError: boolean,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}

function buildToolErrorResult(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

function sanitizedResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	return {
		content: result.content.map(c => (c.type === "text" ? { ...c, text: sanitizeText(c.text) } : c)),
		details: result.details,
	};
}

/**
 * `args` prepared for `tool`; a call the preparation rejects is answered here, its start and end emitted, and its
 * result message is returned instead.
 */
function prepareCall(
	options: CursorExecBridgeOptions,
	tool: AnyAgentTool,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
): ReadyToolCall | ToolResultMessage {
	const prepared = options.prepareToolCall(tool, {
		type: "toolCall",
		id: toolCallId,
		name: toolName,
		arguments: args,
	});
	if (prepared.ok) return prepared;
	const { error, intent } = prepared;
	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: prepared.args, intent });
	const result: AgentToolResult<unknown> = {
		content: [{ type: "text", text: error }],
		details: { isError: true, error },
	};
	options.emitEvent?.({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: sanitizedResult(result),
		isError: true,
	});
	return createToolResultMessage(toolCallId, toolName, result, true);
}

async function executeTool(
	options: CursorExecBridgeOptions,
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	toolOverride?: AnyAgentTool,
): Promise<ToolResultMessage> {
	const tool = toolOverride ?? options.tools.get(toolName);
	if (!tool) {
		const result = buildToolErrorResult(`Tool "${toolName}" not available`);
		return createToolResultMessage(toolCallId, toolName, result, true);
	}
	const call = prepareCall(options, tool, toolName, toolCallId, args);
	if ("role" in call) return call;
	const { display, intent } = call;

	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: display, intent });

	let result: AgentToolResult<unknown>;
	let isError = false;

	const onUpdate: AgentToolUpdateCallback<unknown> | undefined = options.emitEvent
		? partialResult => {
				options.emitEvent?.({
					type: "tool_execution_update",
					toolCallId,
					toolName,
					args: display,
					partialResult: sanitizedResult(partialResult),
				});
			}
		: undefined;

	try {
		result = await tool.execute(toolCallId, call.execution, undefined, onUpdate, options.getToolContext?.());
	} catch (error) {
		const message = errorMessage(error);
		result = buildToolErrorResult(message);
		isError = true;
	}
	isError ||= result.isError === true;

	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result: sanitizedResult(result), isError });

	return createToolResultMessage(toolCallId, toolName, result, isError);
}

async function executeDelete(options: CursorExecBridgeOptions, pathArg: string, toolCallId: string) {
	const toolName = "delete";
	options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: { path: pathArg } });

	const absolutePath = resolveToCwd(pathArg, options.cwd);
	let isError = false;
	let result: AgentToolResult<unknown>;

	try {
		let fileStat: fs.Stats | undefined;
		try {
			fileStat = fs.statSync(absolutePath);
		} catch {
			throw new Error(`File not found: ${pathArg}`);
		}
		if (!fileStat.isFile()) {
			throw new Error(`Path is not a file: ${pathArg}`);
		}

		fs.rmSync(absolutePath);

		const sizeText = fileStat.size ? ` (${fileStat.size} bytes)` : "";
		const message = `Deleted ${pathArg}${sizeText}`;
		result = { content: [{ type: "text", text: message }], details: {} };
	} catch (error) {
		const message = errorMessage(error);
		result = buildToolErrorResult(message);
		isError = true;
	}

	options.emitEvent?.({ type: "tool_execution_end", toolCallId, toolName, result, isError });
	return createToolResultMessage(toolCallId, toolName, result, isError);
}

/** The `bash` arguments for a Cursor shell call; an unset working directory or timeout is absent, as on the wire. */
function bashArgs(args: { command: string; workingDirectory: string; timeout: number }): Record<string, unknown> {
	return {
		command: args.command,
		...(args.workingDirectory ? { cwd: args.workingDirectory } : {}),
		...(args.timeout > 0 ? { timeout: args.timeout } : {}),
	};
}

function decodeToolCallId(toolCallId?: string): string {
	return toolCallId && toolCallId.length > 0 ? toolCallId : randomUUID();
}

function decodeMcpArgs(rawArgs: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(rawArgs)) {
		const text = new TextDecoder().decode(value);
		try {
			decoded[key] = JSON.parse(text);
		} catch {
			decoded[key] = text;
		}
	}
	return decoded;
}

function formatMcpToolErrorMessage(toolName: string, availableTools: string[]): string {
	const list = availableTools.length > 0 ? availableTools.join(", ") : "none";
	return `MCP tool "${toolName}" not found. Available tools: ${list}`;
}

export class CursorExecHandlers implements ICursorExecHandlers {
	constructor(private options: CursorExecBridgeOptions) {}

	async read(args: Parameters<NonNullable<ICursorExecHandlers["read"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(this.options, "read", toolCallId, { path: args.path });
		return toolResultMessage;
	}

	async ls(args: Parameters<NonNullable<ICursorExecHandlers["ls"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		// Redirect ls to read tool, which handles directories
		const toolResultMessage = await executeTool(this.options, "read", toolCallId, { path: args.path });
		return toolResultMessage;
	}

	async grep(args: Parameters<NonNullable<ICursorExecHandlers["grep"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const searchPath = args.glob ? `${args.path || "."}/${args.glob}` : args.path || ".";
		const toolResultMessage = await executeTool(this.options, "search", toolCallId, {
			type: "text",
			input: args.pattern,
			path: searchPath,
			...(args.caseInsensitive === true ? { case: false } : {}),
		});
		return toolResultMessage;
	}

	async write(args: Parameters<NonNullable<ICursorExecHandlers["write"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const content = args.fileText ?? new TextDecoder().decode(args.fileBytes ?? new Uint8Array());
		const toolResultMessage = await executeTool(this.options, "write", toolCallId, {
			path: args.path,
			content,
		});
		return toolResultMessage;
	}

	async delete(args: Parameters<NonNullable<ICursorExecHandlers["delete"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeDelete(this.options, args.path, toolCallId);
		return toolResultMessage;
	}

	async shell(args: Parameters<NonNullable<ICursorExecHandlers["shell"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(this.options, "bash", toolCallId, bashArgs(args));
		return toolResultMessage;
	}

	async shellStream(
		args: Parameters<NonNullable<ICursorExecHandlers["shellStream"]>>[0],
		callbacks: CursorShellStreamCallbacks,
	) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolName = "bash";
		const tool = this.options.tools.get(toolName);
		if (!tool) {
			const result = buildToolErrorResult(`Tool "${toolName}" not available`);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const call = prepareCall(this.options, tool, toolName, toolCallId, bashArgs(args));
		if ("role" in call) return call;
		const { display, intent } = call;
		this.options.emitEvent?.({ type: "tool_execution_start", toolCallId, toolName, args: display, intent });

		let result: AgentToolResult<unknown>;
		let isError = false;

		let rawText = "";
		let sanitizedRawText = "";
		let streamedSanitizedText = "";
		let canStreamSanitizedDelta = true;
		const onUpdate: AgentToolUpdateCallback<unknown> = partialResult => {
			const newRawText = partialResult.content.map(c => (c.type === "text" ? c.text : "")).join("");
			if (newRawText === rawText) {
				return;
			}
			rawText = newRawText;
			sanitizedRawText = sanitizeText(newRawText);
			this.options.emitEvent?.({
				type: "tool_execution_update",
				toolCallId,
				toolName,
				args: display,
				partialResult: {
					content: [{ type: "text" as const, text: sanitizedRawText }],
					details: partialResult.details,
				},
			});
			if (!canStreamSanitizedDelta) {
				return;
			}
			if (sanitizedRawText.startsWith(streamedSanitizedText)) {
				const sanitizedDelta = sanitizedRawText.slice(streamedSanitizedText.length);
				streamedSanitizedText = sanitizedRawText;
				if (sanitizedDelta) {
					callbacks.onStdout(sanitizedDelta);
				}
				return;
			}
			// Cursor's shell-stream callback is append-only. Once the sanitized snapshot
			// stops being a prefix extension, we can no longer repair the stream safely.
			// Keep emitting full snapshots via tool_execution_update, but stop stdout deltas.
			canStreamSanitizedDelta = false;
		};

		try {
			result = await tool.execute(toolCallId, call.execution, undefined, onUpdate, this.options.getToolContext?.());
		} catch (error) {
			const message = errorMessage(error);
			result = buildToolErrorResult(message);
			isError = true;
		}
		isError ||= result.isError === true;

		// onUpdate may not fire for every chunk — flush any remaining output
		// from the final result that wasn't already streamed.
		const finalRawText = result.content.map(c => (c.type === "text" ? c.text : "")).join("");
		if (finalRawText !== rawText) {
			rawText = finalRawText;
			sanitizedRawText = sanitizeText(finalRawText);
		}
		if (canStreamSanitizedDelta && sanitizedRawText.startsWith(streamedSanitizedText)) {
			const finalDelta = sanitizedRawText.slice(streamedSanitizedText.length);
			streamedSanitizedText = sanitizedRawText;
			if (finalDelta) {
				callbacks.onStdout(finalDelta);
			}
		}

		this.options.emitEvent?.({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: sanitizedResult(result),
			isError,
		});
		return createToolResultMessage(toolCallId, toolName, result, isError);
	}

	async diagnostics(args: Parameters<NonNullable<ICursorExecHandlers["diagnostics"]>>[0]) {
		const toolCallId = decodeToolCallId(args.toolCallId);
		const toolResultMessage = await executeTool(this.options, "lsp", toolCallId, {
			action: "diagnostics",
			file: args.path,
		});
		return toolResultMessage;
	}

	async mcp(call: CursorMcpCall) {
		const toolName = call.toolName || call.name;
		const toolCallId = decodeToolCallId(call.toolCallId);
		const args = Object.keys(call.args ?? {}).length > 0 ? call.args : decodeMcpArgs(call.rawArgs ?? {});
		if (cursorMcpPrefersReplaceEdit(toolName, args)) {
			const replaceTool = await this.options.getEditReplaceTool?.();
			if (!replaceTool) {
				const availableTools = Array.from(this.options.tools.keys()).filter(name => name.startsWith("mcp__"));
				const message = formatMcpToolErrorMessage(toolName, availableTools);
				return createToolResultMessage(toolCallId, toolName, buildToolErrorResult(message), true);
			}
			return await executeTool(this.options, "edit", toolCallId, normalizeCursorReplaceArgs(args), replaceTool);
		}
		const tool = this.options.tools.get(toolName);
		if (!tool) {
			const availableTools = Array.from(this.options.tools.keys()).filter(name => name.startsWith("mcp__"));
			const message = formatMcpToolErrorMessage(toolName, availableTools);
			const result = buildToolErrorResult(message);
			return createToolResultMessage(toolCallId, toolName, result, true);
		}

		const toolResultMessage = await executeTool(this.options, toolName, toolCallId, args);
		return toolResultMessage;
	}
}

/**
 * The bridge for an agent constructed after it: the agent's stream is handed the bridge, so the bridge reaches the
 * agent through `agent` once it exists. A call prepares through `prepareExternalToolCall`, and its events reach the
 * agent's subscribers through `emitExternalEvent`.
 */
export function cursorExecHandlersForAgent(
	options: Omit<CursorExecBridgeOptions, "prepareToolCall" | "emitEvent"> & { agent: () => Agent | undefined },
): CursorExecHandlers {
	const { agent, ...bridge } = options;
	return new CursorExecHandlers({
		...bridge,
		prepareToolCall: (tool, toolCall) => {
			const current = agent();
			if (!current) throw new Error("A Cursor tool call arrived before the agent was constructed.");
			return current.prepareExternalToolCall(tool, toolCall);
		},
		emitEvent: event => agent()?.emitExternalEvent(event),
	});
}
