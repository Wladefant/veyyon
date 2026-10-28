/**
 * Every request the Cursor server sends that waits on the client gets an answer.
 *
 * WHY. The server holds a turn open until the client answers each exec request and each
 * interaction query. A request the client dropped left nothing on the wire but heartbeats, and the
 * turn ended 30 minutes later as "Cursor made no progress for 1800s". Two holes did it: an exec
 * request whose case was newer than the generated protocol (`mcp_state_exec_args`, field 36) was
 * returned from without a reply, and an interaction query (Cursor's built-in web search asks for
 * approval this way) was never read at all. Field 36 is now in the protocol and answered with the
 * MCP server this client advertises, as Cursor's own client answers it.
 *
 * The class is "a server request with no answer", so the suite sweeps both oneofs from the generated
 * descriptors and adds one field number past the last the descriptor defines, standing in for the
 * next case a server adds. A new member arrives covered: it is either answered or the suite fails.
 *
 * What it does NOT catch: whether the server accepts the answer's content. The throw and the
 * rejection mirror Cursor's own client; a live turn is the proof that the server moves on.
 */
import { describe, expect, it } from "bun:test";
import { create, type DescMessage, fromBinary, ScalarType, toBinary } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { CursorExecHandlers, ToolResultMessage } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	InteractionQuerySchema,
	InteractionResponseSchema,
	type McpToolDefinition,
	McpToolDefinitionSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { cursorAssistantMessage, newBlockState } from "./helpers/cursor-stream-harness";

/** A field number no member of `schema` uses: the next case a newer server could send. */
function nextFieldNumber(schema: DescMessage): number {
	return Math.max(...schema.fields.map(field => field.number)) + 1;
}

/** Arguments a handler accepts: every string field is non-empty. */
function argsFor(schema: DescMessage): Record<string, unknown> {
	const init: Record<string, unknown> = {};
	for (const field of schema.fields) {
		if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING)
			init[field.localName] = `${field.localName}-value`;
	}
	return init;
}

/** The server message as the client receives it: encoded, then decoded by the generated schema. */
function overTheWire(message: AgentServerMessage): AgentServerMessage {
	return fromBinary(AgentServerMessageSchema, toBinary(AgentServerMessageSchema, message));
}

/** An empty length-delimited field the generated schema does not define. */
function unknownCase(no: number) {
	return [{ no, wireType: WireType.LengthDelimited, data: new Uint8Array([0]) }];
}

function newTurn(advertisedTools: McpToolDefinition[] = []) {
	const output = cursorAssistantMessage();
	const replies: AgentClientMessage[] = [];
	const run = async (toolCallId: string, toolName: string): Promise<ToolResultMessage> => ({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: `ran ${toolName}` }],
		isError: false,
		timestamp: 1,
	});
	const execHandlers = {
		read: (args: { toolCallId: string }) => run(args.toolCallId, "read"),
		ls: (args: { toolCallId: string }) => run(args.toolCallId, "read"),
		grep: (args: { toolCallId: string }) => run(args.toolCallId, "search"),
		write: (args: { toolCallId: string }) => run(args.toolCallId, "write"),
		delete: (args: { toolCallId: string }) => run(args.toolCallId, "delete"),
		shell: (args: { toolCallId: string }) => run(args.toolCallId, "bash"),
		shellStream: (args: { toolCallId: string }) => run(args.toolCallId, "bash"),
		diagnostics: (args: { toolCallId: string }) => run(args.toolCallId, "lsp"),
		mcp: (call: { toolCallId: string; toolName: string }) => run(call.toolCallId, call.toolName),
	} as unknown as CursorExecHandlers;
	const h2Request = {
		write: (frame: Uint8Array) => {
			replies.push(fromBinary(AgentClientMessageSchema, frame.subarray(5)));
			return true;
		},
	} as unknown as Parameters<typeof handleServerMessage>[5];
	const send = (message: AgentServerMessage) =>
		handleServerMessage(
			overTheWire(message),
			output,
			new AssistantMessageEventStream(),
			newBlockState(output),
			new Map(),
			h2Request,
			execHandlers,
			async result => result,
			advertisedTools,
		);
	return { replies, send };
}

const EXEC_ID = "exec-7";
const EXEC_REQUEST_ID = 7;

/** Whether `replies` hold an answer to exec request {@link EXEC_REQUEST_ID}: a typed result or a throw. */
function execAnswer(replies: readonly AgentClientMessage[]): "result" | "throw" | undefined {
	for (const reply of replies) {
		const message = reply.message;
		if (
			message.case === "execClientMessage" &&
			message.value.id === EXEC_REQUEST_ID &&
			message.value.execId === EXEC_ID &&
			message.value.message.case !== undefined &&
			message.value.message.case !== "shellStream"
		) {
			return "result";
		}
		if (
			message.case === "execClientControlMessage" &&
			message.value.message.case === "throw" &&
			message.value.message.value.id === EXEC_REQUEST_ID
		) {
			return "throw";
		}
	}
	return undefined;
}

/** The tools a turn advertises to Cursor over MCP, as `requestContextArgs` lists them. */
const ADVERTISED = ["goal", "set_cwd"].map(name =>
	create(McpToolDefinitionSchema, { name, toolName: name, providerIdentifier: "pi-agent" }),
);

/** The MCP state answer to exec request {@link EXEC_REQUEST_ID}: its case and each server's name, id and tools. */
function mcpStateAnswer(replies: readonly AgentClientMessage[]) {
	for (const reply of replies) {
		const message = reply.message;
		if (message.case !== "execClientMessage" || message.value.id !== EXEC_REQUEST_ID) continue;
		const answer = message.value.message;
		if (answer.case !== "mcpStateExecResult") return { case: answer.case };
		const result = answer.value.result;
		return {
			case: result.case,
			servers:
				result.case === "success"
					? result.value.servers.map(server => [
							server.serverName,
							server.serverIdentifier,
							server.tools.map(tool => tool.name),
						])
					: [],
		};
	}
	return undefined;
}

const PI_AGENT = ["pi-agent", "pi-agent", ["goal", "set_cwd"]];

const execCases = ExecServerMessageSchema.fields.filter(field => field.oneof !== undefined && field.message);

describe("an exec request Cursor sends", () => {
	it.each(execCases.map(field => [field.localName, field] as const))("%s is answered", async (_name, field) => {
		const turn = newTurn();
		const argsSchema = field.message as DescMessage;
		await turn.send(
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: EXEC_REQUEST_ID,
						execId: EXEC_ID,
						message: { case: field.localName, value: create(argsSchema, argsFor(argsSchema)) } as never,
					}),
				},
			}),
		);
		expect(execAnswer(turn.replies)).toBe("result");
	});

	it("whose case this client cannot decode is failed with a throw and the stream close", async () => {
		const turn = newTurn();
		const no = nextFieldNumber(ExecServerMessageSchema);
		const request = create(ExecServerMessageSchema, { id: EXEC_REQUEST_ID, execId: EXEC_ID });
		request.$unknown = unknownCase(no);
		await turn.send(create(AgentServerMessageSchema, { message: { case: "execServerMessage", value: request } }));

		expect(execAnswer(turn.replies)).toBe("throw");
		const control = turn.replies.flatMap(reply =>
			reply.message.case === "execClientControlMessage" ? [reply.message.value.message] : [],
		);
		expect(control.map(message => [message.case, message.value?.id])).toEqual([
			["throw", EXEC_REQUEST_ID],
			["streamClose", EXEC_REQUEST_ID],
		]);
		const thrown = control[0]?.case === "throw" ? control[0].value.error : "";
		expect(thrown).toBe(`This client does not run Cursor exec field ${no}.`);
	});

	// Backtest: the request a live turn sent before each call to a tool Cursor reaches over MCP
	// (`goal`, `set_cwd`), `mcp_state_exec_args` naming the `pi-agent` server. Failed with a throw,
	// it came again 3 to 8 s later; Cursor's own client answers it with its MCP servers.
	it("for MCP state, sent before an MCP tool call, lists the tools advertised under pi-agent", async () => {
		const turn = newTurn(ADVERTISED);
		const request = create(ExecServerMessageSchema, { id: EXEC_REQUEST_ID, execId: "" });
		// The captured bytes as protobuf-es keeps them: length prefix, then field 1 = "pi-agent".
		const mcpState = Uint8Array.from([0x0a, 0x0a, 0x08, ...new TextEncoder().encode("pi-agent")]);
		request.$unknown = [{ no: 36, wireType: WireType.LengthDelimited, data: mcpState }];
		await turn.send(create(AgentServerMessageSchema, { message: { case: "execServerMessage", value: request } }));

		expect(mcpStateAnswer(turn.replies)).toEqual({ case: "success", servers: [PI_AGENT] });
		expect(turn.replies.filter(reply => reply.message.case === "execClientControlMessage")).toEqual([]);
	});

	it.each([
		["names no server", [], ADVERTISED, [PI_AGENT]],
		["names pi-agent among others", ["other", "pi-agent"], ADVERTISED, [PI_AGENT]],
		["names only another server", ["other"], ADVERTISED, []],
		["arrives in a turn that advertises no tool", [], [], []],
	] as const)("for MCP state that %s lists the matching servers", async (_name, serverIdentifiers, tools, servers) => {
		const turn = newTurn([...tools]);
		await turn.send(
			create(AgentServerMessageSchema, {
				message: {
					case: "execServerMessage",
					value: create(ExecServerMessageSchema, {
						id: EXEC_REQUEST_ID,
						execId: EXEC_ID,
						message: { case: "mcpStateExecArgs", value: { serverIdentifiers: [...serverIdentifiers] } },
					}),
				},
			}),
		);
		expect(mcpStateAnswer(turn.replies)).toEqual({ case: "success", servers: [...servers] });
	});
});

const QUERY_ID = 3;

/** The field number of the response case `response` carries, read from its encoding. */
function responseFieldNumbers(reply: AgentClientMessage): number[] {
	if (reply.message.case !== "interactionResponse") return [];
	const bytes = toBinary(InteractionResponseSchema, reply.message.value);
	const reader = new BinaryReader(bytes);
	const numbers: number[] = [];
	while (reader.pos < reader.len) {
		const [no, wireType] = reader.tag();
		if (no !== 1) numbers.push(no);
		reader.skip(wireType);
	}
	return numbers;
}

const queryCases = InteractionQuerySchema.fields.filter(field => field.oneof !== undefined && field.message);

describe("an interaction query Cursor sends", () => {
	it.each(queryCases.map(field => [field.localName, field] as const))(
		"%s is answered under its own field number",
		async (_name, field) => {
			const turn = newTurn();
			const argsSchema = field.message as DescMessage;
			await turn.send(
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionQuery",
						value: create(InteractionQuerySchema, {
							id: QUERY_ID,
							query: { case: field.localName, value: create(argsSchema, argsFor(argsSchema)) } as never,
						}),
					},
				}),
			);
			const responses = turn.replies.filter(reply => reply.message.case === "interactionResponse");
			expect(responses).toHaveLength(1);
			const response = responses[0]!.message.value as { id: number };
			expect(response.id).toBe(QUERY_ID);
			expect(responseFieldNumbers(responses[0]!)).toEqual([field.number]);
		},
	);

	/** A response's own oneof, or, for askQuestion and createPlan, the oneof of the result it wraps. */
	interface Decision {
		result?: { case?: string; result?: { case?: string } };
	}

	it("approves Cursor's read-only lookups and rejects what needs a Cursor UI", async () => {
		const decisions: Record<string, string | undefined> = {};
		for (const field of queryCases) {
			const turn = newTurn();
			const argsSchema = field.message as DescMessage;
			await turn.send(
				create(AgentServerMessageSchema, {
					message: {
						case: "interactionQuery",
						value: create(InteractionQuerySchema, {
							id: QUERY_ID,
							query: { case: field.localName, value: create(argsSchema, argsFor(argsSchema)) } as never,
						}),
					},
				}),
			);
			const reply = turn.replies.find(r => r.message.case === "interactionResponse");
			const value = (reply?.message.value as { result: { value?: Decision } } | undefined)?.result.value;
			decisions[field.localName] = value?.result?.case ?? value?.result?.result?.case;
		}
		expect(decisions).toEqual({
			webSearchRequestQuery: "approved",
			askQuestionInteractionQuery: "rejected",
			switchModeRequestQuery: "rejected",
			exaSearchRequestQuery: "approved",
			exaFetchRequestQuery: "approved",
			createPlanRequestQuery: "error",
			setupVmEnvironmentArgs: undefined,
		});
	});

	it("whose case this client cannot decode is rejected under that field number", async () => {
		const turn = newTurn();
		const no = nextFieldNumber(InteractionQuerySchema);
		const query = create(InteractionQuerySchema, { id: QUERY_ID });
		query.$unknown = unknownCase(no);
		await turn.send(create(AgentServerMessageSchema, { message: { case: "interactionQuery", value: query } }));

		const responses = turn.replies.filter(reply => reply.message.case === "interactionResponse");
		expect(responses).toHaveLength(1);
		expect(responseFieldNumbers(responses[0]!)).toEqual([no]);
		// The mirrored response sets field 2, the `rejected` (or `error`) member of every Cursor response.
		const mirrored = responses[0]!.message.value as { $unknown?: { data: Uint8Array }[] };
		const inner = new BinaryReader(mirrored.$unknown![0]!.data).bytes();
		expect(Array.from(inner)).toEqual([(2 << 3) | WireType.LengthDelimited, 0]);
	});
});
