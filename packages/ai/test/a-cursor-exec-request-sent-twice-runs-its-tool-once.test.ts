/**
 * WHY. Cursor re-sends an exec request for a tool call it already dispatched, under the same
 * tool-call id. The provider treated every request as new: it synthesized a second `toolCall`
 * block under the id and ran the tool a second time, which for `bash`, `write` and `delete` is a
 * second side effect. The agent loop renamed the second block `<id>_2`, nothing answered it, and
 * the turn ended holding a call with no result. Recorded Cursor turns carried one such phantom for
 * more than a third of their calls, and each phantom kept the session from continuing after the
 * stream died, because an unanswered exec-channel call reads as a call whose result is still on
 * its way.
 *
 * The class: an exec request whose tool-call id the turn already dispatched must never run a tool
 * or open a block again, for ANY exec case that runs a tool, and the server must still receive an
 * answer to it. The sweep enumerates the exec cases from the generated `ExecServerMessage` schema
 * at run time: a new case that carries a `toolCallId` is swept automatically, and it fails until
 * a handler runs it exactly once.
 *
 * What this suite does NOT catch: it drives `handleServerMessage` rather than a live HTTP/2 turn,
 * so a dispatch path that bypasses that function is outside it. It cannot see why Cursor re-sends
 * a request; it pins what the client does when it does.
 */
import { describe, expect, it } from "bun:test";
import { create, type DescMessage, fromBinary, ScalarType } from "@bufbuild/protobuf";
import { handleServerMessage } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, CursorExecHandlers, ToolResultMessage } from "@veyyon/ai/types";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ExecServerMessageSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { cursorAssistantMessage, newBlockState } from "./helpers/cursor-stream-harness";

const TOOL_CALL_ID = "call-3059677f-b703-4b8a-8737-4493b21f4a19-0\nfc_eabb0594-4ec2-9515-848e-30f9e1054dcd_0";

/**
 * Exec cases that carry a `toolCallId` yet run nothing: the provider answers each with a fixed
 * refusal or an empty result, so a repeat of one is answered the same way and needs no record.
 */
const ANSWERED_WITHOUT_RUNNING = ["backgroundShellSpawnArgs", "computerUseArgs", "fetchArgs", "recordScreenArgs"];

/** Every exec case whose arguments carry a `toolCallId`. */
function execCasesWithToolCallId(): { execCase: string; argsSchema: DescMessage }[] {
	const cases: { execCase: string; argsSchema: DescMessage }[] = [];
	for (const field of ExecServerMessageSchema.fields) {
		if (field.oneof === undefined || field.message === undefined) continue;
		if (!field.message.fields.some(argField => argField.localName === "toolCallId")) continue;
		cases.push({ execCase: field.localName, argsSchema: field.message });
	}
	return cases;
}

/** Arguments a handler accepts: every string field the tool reads is non-empty. */
function execArgs(argsSchema: DescMessage, toolCallId: string): Record<string, unknown> {
	const init: Record<string, unknown> = { toolCallId };
	for (const field of argsSchema.fields) {
		if (field.localName === "toolCallId" || field.fieldKind !== "scalar") continue;
		if (field.scalar === ScalarType.STRING) init[field.localName] = `${field.localName}-value`;
	}
	return init;
}

function execRequest(
	execCase: string,
	argsSchema: DescMessage,
	execId: string,
	id: number,
	toolCallId: string,
): AgentServerMessage {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id,
				execId,
				message: { case: execCase, value: create(argsSchema, execArgs(argsSchema, toolCallId)) } as never,
			}),
		},
	});
}

interface ExecTurn {
	output: AssistantMessage;
	/** Tool-call ids in the order a handler ran them. */
	ran: string[];
	/** Tool results the provider handed to `onToolResult`. */
	results: ToolResultMessage[];
	/** Every client message written back to the server. */
	replies: AgentClientMessage[];
	send: (message: AgentServerMessage) => Promise<void>;
	/** Hold every handler until {@link release}, so a repeat can land while the first run is in flight. */
	hold: () => void;
	release: () => void;
}

function newExecTurn(): ExecTurn {
	const output = cursorAssistantMessage();
	const stream = new AssistantMessageEventStream();
	const state = newBlockState(output);
	const ran: string[] = [];
	const results: ToolResultMessage[] = [];
	const replies: AgentClientMessage[] = [];
	let gate: Promise<void> | undefined;
	let open: (() => void) | undefined;

	const run = async (toolCallId: string, toolName: string): Promise<ToolResultMessage> => {
		ran.push(toolCallId);
		if (gate) await gate;
		return {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: `ran ${toolName}` }],
			isError: false,
			timestamp: 1,
		};
	};
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

	return {
		output,
		ran,
		results,
		replies,
		send: message =>
			handleServerMessage(
				message,
				output,
				stream,
				state,
				new Map(),
				h2Request,
				execHandlers,
				async result => {
					results.push(result);
					return result;
				},
				[],
			),
		hold: () => {
			const deferred = Promise.withResolvers<void>();
			gate = deferred.promise;
			open = deferred.resolve;
		},
		release: () => open?.(),
	};
}

/** The typed result each exec request received, by exec id, ignoring shell stream events. */
function resultsByExecId(replies: AgentClientMessage[]): Map<string, { case: string | undefined; bytes: string }[]> {
	const byExecId = new Map<string, { case: string | undefined; bytes: string }[]>();
	for (const reply of replies) {
		if (reply.message.case !== "execClientMessage") continue;
		const exec = reply.message.value;
		if (exec.message.case === "shellStream") continue;
		const list = byExecId.get(exec.execId) ?? [];
		list.push({
			case: exec.message.case,
			bytes: JSON.stringify(exec.message.value, (_key, value) =>
				typeof value === "bigint" ? value.toString() : value,
			),
		});
		byExecId.set(exec.execId, list);
	}
	return byExecId;
}

function toolCallIds(output: AssistantMessage): string[] {
	return output.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []));
}

const casesWithToolCallId = execCasesWithToolCallId();
const cases = casesWithToolCallId.filter(c => !ANSWERED_WITHOUT_RUNNING.includes(c.execCase));

describe("an exec request Cursor sends twice", () => {
	it("sweeps every exec case that carries a tool-call id, and runs a tool for all but the pinned ones", () => {
		expect(cases.map(c => c.execCase).sort()).toEqual([
			"deleteArgs",
			"diagnosticsArgs",
			"grepArgs",
			"lsArgs",
			"mcpArgs",
			"readArgs",
			"shellArgs",
			"shellStreamArgs",
			"writeArgs",
		]);
		expect(
			casesWithToolCallId
				.filter(c => ANSWERED_WITHOUT_RUNNING.includes(c.execCase))
				.map(c => c.execCase)
				.sort(),
		).toEqual([...ANSWERED_WITHOUT_RUNNING].sort());
	});

	for (const execCase of ANSWERED_WITHOUT_RUNNING) {
		it(`answers both requests of ${execCase} without running anything`, async () => {
			const turn = newExecTurn();
			const { argsSchema } = casesWithToolCallId.find(c => c.execCase === execCase)!;
			await turn.send(execRequest(execCase, argsSchema, "exec-1", 1, TOOL_CALL_ID));
			await turn.send(execRequest(execCase, argsSchema, "exec-2", 2, TOOL_CALL_ID));

			expect(turn.ran).toEqual([]);
			expect(toolCallIds(turn.output)).toEqual([]);
			const answered = resultsByExecId(turn.replies);
			expect(answered.get("exec-1")).toHaveLength(1);
			expect(answered.get("exec-2")).toEqual(answered.get("exec-1"));
		});
	}

	for (const { execCase, argsSchema } of cases) {
		describe(execCase, () => {
			it("runs the tool once and answers both requests alike when the repeat follows the answer", async () => {
				const turn = newExecTurn();
				await turn.send(execRequest(execCase, argsSchema, "exec-1", 1, TOOL_CALL_ID));
				await turn.send(execRequest(execCase, argsSchema, "exec-2", 2, TOOL_CALL_ID));

				expect(turn.ran).toEqual([TOOL_CALL_ID]);
				expect(turn.results.map(r => r.toolCallId)).toEqual([TOOL_CALL_ID]);
				const answered = resultsByExecId(turn.replies);
				expect(answered.get("exec-1")).toHaveLength(1);
				expect(answered.get("exec-2")).toEqual(answered.get("exec-1"));
			});

			it("runs the tool once when the repeat lands while the first run is in flight", async () => {
				const turn = newExecTurn();
				turn.hold();
				const first = turn.send(execRequest(execCase, argsSchema, "exec-1", 1, TOOL_CALL_ID));
				const repeat = turn.send(execRequest(execCase, argsSchema, "exec-2", 2, TOOL_CALL_ID));
				await Promise.resolve();
				expect(resultsByExecId(turn.replies).get("exec-2")).toBeUndefined();
				turn.release();
				await Promise.all([first, repeat]);

				expect(turn.ran).toEqual([TOOL_CALL_ID]);
				const answered = resultsByExecId(turn.replies);
				expect(answered.get("exec-2")).toEqual(answered.get("exec-1"));
			});
		});
	}

	it("opens one block per call for a synthesized exec tool", async () => {
		const turn = newExecTurn();
		const read = cases.find(c => c.execCase === "readArgs")!;
		await turn.send(execRequest(read.execCase, read.argsSchema, "exec-1", 1, TOOL_CALL_ID));
		await turn.send(execRequest(read.execCase, read.argsSchema, "exec-2", 2, TOOL_CALL_ID));

		expect(toolCallIds(turn.output)).toEqual([TOOL_CALL_ID]);
	});

	it("answers a repeated shell stream with a complete stream carrying the first run's output", async () => {
		const turn = newExecTurn();
		const shell = cases.find(c => c.execCase === "shellStreamArgs")!;
		const framing = (replies: AgentClientMessage[]) =>
			replies.map(reply => {
				if (reply.message.case === "execClientControlMessage") return `control:${reply.message.value.message.case}`;
				if (reply.message.case !== "execClientMessage") return reply.message.case;
				const exec = reply.message.value;
				return exec.message.case === "shellStream" ? `stream:${exec.message.value.event.case}` : exec.message.case;
			});
		await turn.send(execRequest(shell.execCase, shell.argsSchema, "exec-1", 1, TOOL_CALL_ID));
		const firstReplies = turn.replies.length;
		await turn.send(execRequest(shell.execCase, shell.argsSchema, "exec-2", 2, TOOL_CALL_ID));

		const repeat = framing(turn.replies.slice(firstReplies));
		expect(repeat).toEqual(["stream:start", "stream:stdout", "stream:exit", "shellResult", "control:streamClose"]);
		expect(turn.ran).toEqual([TOOL_CALL_ID]);
	});

	it("keeps distinct calls distinct in a batch Cursor re-sent call by call", async () => {
		// The recorded shape, minimized: each call of a batch arrives twice, and a repeat can
		// trail a later call rather than follow its original directly.
		const turn = newExecTurn();
		const read = cases.find(c => c.execCase === "readArgs")!;
		const shell = cases.find(c => c.execCase === "shellArgs")!;
		const ids = ["call-a", "call-b", "call-c"];
		const order: [typeof read, string][] = [
			[read, ids[0]],
			[read, ids[0]],
			[shell, ids[1]],
			[read, ids[2]],
			[shell, ids[1]],
			[read, ids[2]],
		];
		let id = 0;
		for (const [kind, toolCallId] of order) {
			id += 1;
			await turn.send(execRequest(kind.execCase, kind.argsSchema, `exec-${id}`, id, toolCallId));
		}

		expect(toolCallIds(turn.output)).toEqual(ids);
		expect(turn.ran).toEqual(ids);
		expect(turn.results.map(r => r.toolCallId)).toEqual(ids);
		expect([...resultsByExecId(turn.replies).keys()]).toHaveLength(order.length);
	});
});
