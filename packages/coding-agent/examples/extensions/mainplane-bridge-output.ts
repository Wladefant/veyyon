import type { ExtensionAPI } from "@veyyon/coding-agent";
import { bridgeRequest, digest, MainplaneError, remoteSessionId, SHA256,
	validateReceipt, visibleError, WORKER_ID } from "./mainplane-bridge-wire";

export interface OutputPageInput {
	runId: string;
	sessionFile: string;
	offset?: number;
	limit?: number;
	outputSha256?: string;
}

export async function recoverRemoteOutput(origin: string, token: string, input: OutputPageInput,
	signal?: AbortSignal, transport: typeof fetch = fetch) {
	const offset = input.offset ?? 0;
	const limit = input.limit ?? 6000;
	if (!WORKER_ID.test(input.runId) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1024 * 1024 ||
		!Number.isSafeInteger(limit) || limit < 1 || limit > 20_000 ||
		(input.outputSha256 !== undefined && !SHA256.test(input.outputSha256))) {
		throw new MainplaneError("Invalid output page selector");
	}
	const session = remoteSessionId(input.sessionFile);
	const read = await bridgeRequest(origin, token, { path: "/fleet/runs/" + input.runId, method: "GET" }, signal, transport);
	const receipt = validateReceipt(read.data, input.runId, "run");
	if (receipt.session !== session || receipt.state !== "completed") {
		throw new MainplaneError("Output is not a completed run owned by this Veyyon session");
	}
	if (input.outputSha256 !== undefined && receipt.output_sha256 !== input.outputSha256) {
		throw new MainplaneError("Output revision changed between pages");
	}
	const { data } = await bridgeRequest(origin, token, { path: "/fleet/runs/" + input.runId + "/output",
		method: "GET", responseLimit: 2 * 1024 * 1024 }, signal, transport);
	if (data.schema_version !== 1 || data.idempotency_sha256 !== receipt.idempotency_sha256 ||
		data.request_sha256 !== receipt.request_sha256 || data.output_sha256 !== receipt.output_sha256 ||
		typeof data.bytes !== "number" || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || data.bytes > 1024 * 1024 ||
		typeof data.data_base64 !== "string") throw new MainplaneError("Output artifact identity mismatch");
	const bytes = Buffer.from(data.data_base64, "base64");
	if (bytes.toString("base64") !== data.data_base64 || bytes.length !== data.bytes || digest(bytes) !== receipt.output_sha256) {
		throw new MainplaneError("Output artifact integrity mismatch");
	}
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new MainplaneError("Output is binary; use a binary-aware recovery tool"); }
	if (text.includes("\0")) throw new MainplaneError("Output contains binary NUL bytes; use a binary-aware recovery tool");
	const characters = Array.from(text);
	if (offset > characters.length) throw new MainplaneError("Output offset is past the end");
	const end = Math.min(offset + limit, characters.length);
	return { run_id: input.runId, request_sha256: receipt.request_sha256, output_sha256: receipt.output_sha256,
		retrieval_only: true, execution_exit: receipt.exit, bytes: bytes.length,
		offset, next_offset: end < characters.length ? end : null, total_characters: characters.length,
		text: characters.slice(offset, end).join(""), cut_lines: receipt.cut ?? 0, full_output_path: receipt.full ?? null };
}

export function registerMainplaneOutputRecovery(pi: ExtensionAPI): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "mainplane_recover_output", label: "Recover verified prior worker output",
		description: "Read an immutable completed run's output for this session without executing again. Pages use Unicode code-point offsets; pin outputSha256 on later pages.",
		parameters: z.object({ runId: z.string().regex(WORKER_ID), offset: z.number().int().min(0).max(1024 * 1024).default(0),
			limit: z.number().int().min(1).max(20_000).default(6000), outputSha256: z.string().regex(SHA256).optional() }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return { content: [{ type: "text", text: "Recovery requires the persisted current session" }], isError: true };
			try {
				const result = await recoverRemoteOutput(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "",
					{ ...params, sessionFile }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: { run_id: result.run_id,
					output_sha256: result.output_sha256, next_offset: result.next_offset, retrieval_only: true } };
			} catch (error) { return { content: [{ type: "text", text: visibleError(error) }], isError: true }; }
		},
	});
}
