/**
 * Optional Mainplane Go bridge tools for an operator-owned fleet.
 *
 * This extension only uses the native Go bridge endpoint from Superboard #1800.
 * It does not replace Veyyon providers, grants, codecs, or central auth broker.
 */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@veyyon/coding-agent";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const MAX_REPLY = 128 * 1024;

export function bridgeOrigin(value: string): string {
	const url = new URL(value);
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new Error("Mainplane URL must be a bare origin without credentials");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
		throw new Error("Mainplane bridge requires HTTPS except local loopback");
	}
	return url.origin;
}

export function remoteRunId(sessionFile: string, toolCallId: string): string {
	if (!sessionFile || !toolCallId) throw new Error("Persisted session and tool-call identities are required");
	return "sb-" + createHash("sha256").update(sessionFile + "\0" + toolCallId).digest("hex").slice(0, 48);
}

function sessionId(sessionFile: string): string {
	return "sb-" + createHash("sha256").update(sessionFile).digest("hex").slice(0, 40);
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
	if (!response.body) throw new Error("Mainplane response body is empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_REPLY) throw new Error("Mainplane response exceeded limit");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.length;
	}
	let data: unknown;
	try {
		data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Mainplane returned malformed JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Mainplane returned malformed record");
	}
	return data as Record<string, unknown>;
}

export async function readRemoteReceipt(
	origin: string,
	token: string,
	runId: string,
	signal?: AbortSignal,
	transport: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
	if (!ID.test(runId)) throw new Error("Invalid Mainplane run identifier");
	const response = await transport(bridgeOrigin(origin) + "/fleet/runs/" + runId, {
		method: "GET",
		headers: { Authorization: "Bearer " + token },
		redirect: "error",
		signal,
	});
	if (!response.ok) throw new Error("Mainplane receipt read refused (" + response.status + ")");
	return boundedJson(response);
}

export interface RunInput {
	worker: string;
	interpreter: string;
	code: string;
	timeoutSeconds: number;
	sessionFile: string;
	toolCallId: string;
}

export async function runRemote(
	origin: string,
	token: string,
	args: RunInput,
	signal?: AbortSignal,
	transport: typeof fetch = fetch,
): Promise<{ id: string; result: Record<string, unknown>; replayed: boolean }> {
	if (!token || /[\r\n]/.test(token)) throw new Error("Missing or invalid Mainplane key");
	if (!ID.test(args.worker) || !ID.test(args.interpreter) ||
		!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 1 || args.timeoutSeconds > 600 ||
		!args.code.trim() || args.code.length > 256 * 1024) {
		throw new Error("Invalid Mainplane worker execution fields");
	}
	const id = remoteRunId(args.sessionFile, args.toolCallId);
	const response = await transport(bridgeOrigin(origin) + "/fleet/run", {
		method: "POST",
		headers: {
			Authorization: "Bearer " + token,
			"Content-Type": "application/json",
			"Idempotency-Key": id,
		},
		redirect: "error",
		signal,
		body: JSON.stringify({
			worker: args.worker, session: sessionId(args.sessionFile),
			interpreter: args.interpreter, code: args.code, timeout: args.timeoutSeconds,
		}),
	});
	if (response.status === 409) {
		// A prior submission may have completed or remain uncertain. Never re-run it.
		return {
			id,
			result: await readRemoteReceipt(origin, token, id, signal, transport),
			replayed: true,
		};
	}
	if (!response.ok) throw new Error("Mainplane execution refused or uncertain (" + response.status + "); check receipt " + id);
	const result = await boundedJson(response);
	if (result.state !== "completed") throw new Error("Mainplane did not confirm completion; check receipt " + id);
	return { id, result, replayed: false };
}

export default function mainplaneWorkerBridge(pi: ExtensionAPI) {
	const { z } = pi.zod;

	pi.registerTool({
		name: "mainplane_worker_run",
		label: "Mainplane native worker run",
		description: "Run a command on a named, connected owner-controlled Mainplane Go worker. A network failure is uncertain; NEVER blindly resubmit. Requires an explicitly installed bridge.",
		parameters: z.object({
			worker: z.string().regex(ID).describe("Connected Mainplane worker name"),
			interpreter: z.string().regex(ID).describe("Worker interpreter, e.g. pwsh, bash, or js"),
			code: z.string().min(1).max(256 * 1024).describe("Code executed on the selected worker"),
			timeoutSeconds: z.number().int().min(1).max(600).default(90),
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				return { content: [{ type: "text", text: "Mainplane requires a persisted Veyyon session" }], isError: true };
			}
			try {
				const answer = await runRemote(
					process.env.MAINPLANE_BRIDGE_URL ?? "",
					process.env.MAINPLANE_API_KEY ?? "",
					{ ...params, sessionFile, toolCallId }, signal,
				);
				return {
					content: [{ type: "text", text: JSON.stringify(answer) }],
					details: { run_id: answer.id, replayed: answer.replayed },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : "Mainplane command failed" }],
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "mainplane_run_receipt",
		label: "Mainplane run receipt",
		description: "Read a durable Mainplane Go execution receipt by its stable run key; does not execute anything.",
		parameters: z.object({ runId: z.string().regex(ID) }),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await readRemoteReceipt(
					process.env.MAINPLANE_BRIDGE_URL ?? "",
					process.env.MAINPLANE_API_KEY ?? "",
					params.runId,
					signal,
				);
				return { content: [{ type: "text", text: JSON.stringify(result) }] };
			} catch (error) {
				return { content: [{ type: "text", text: error instanceof Error ? error.message : "Receipt unavailable" }], isError: true };
			}
		},
	});
}
