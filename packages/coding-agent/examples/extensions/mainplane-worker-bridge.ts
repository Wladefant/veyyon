/** Explicit opt-in native Mainplane worker tools; provider/auth services are unchanged. */
import type { ExtensionAPI } from "@veyyon/coding-agent";
import { bindReceipt, bridgeRequest, type BridgeReceipt, digest, MainplaneError, mainplaneRequestHash,
	receiptIsError, remoteRunId, remoteSessionId, SHA256, validateReceipt, visibleError, WORKER_ID } from "./mainplane-bridge-wire";
import { registerMainplaneWrite } from "./mainplane-bridge-write";
import { registerMainplaneCancellation } from "./mainplane-bridge-cancel";
import { registerMainplaneOutputRecovery } from "./mainplane-bridge-output";
import { registerMainplaneJobs } from "./mainplane-bridge-jobs";

// Go JSON control escaping can expand the two retained 50 KiB outputs sixfold.
const MAX_RUN_REPLY = 1024 * 1024;

export async function readRemoteReceipt(origin: string, token: string, runId: string,
	signal?: AbortSignal, transport: typeof fetch = fetch): Promise<BridgeReceipt> {
	if (!WORKER_ID.test(runId)) throw new MainplaneError("Invalid Mainplane run identifier");
	const { data } = await bridgeRequest(origin, token, { path: "/fleet/runs/" + runId, method: "GET" }, signal, transport);
	return validateReceipt(data, runId);
}
export interface RunInput { worker: string; interpreter: string; code: string; timeoutSeconds: number; sessionFile: string; toolCallId: string; }
export async function runRemote(origin: string, token: string, args: RunInput,
	signal?: AbortSignal, transport: typeof fetch = fetch) {
	if (!WORKER_ID.test(args.worker) || !WORKER_ID.test(args.interpreter) || !Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 1 || args.timeoutSeconds > 600 || !args.code.trim()) throw new MainplaneError("Invalid Mainplane worker execution fields");
	const id = remoteRunId(args.sessionFile, args.toolCallId); const session = remoteSessionId(args.sessionFile);
	const fingerprint = mainplaneRequestHash("run", args.worker, session, args.interpreter, String(args.timeoutSeconds), args.code);
	try {
		const response = await bridgeRequest(origin, token, { path: "/fleet/run", method: "POST", key: id,
			timeoutMs: (args.timeoutSeconds + 15) * 1000, responseLimit: MAX_RUN_REPLY, statuses: [200, 409, 502],
			body: JSON.stringify({ worker: args.worker, session, interpreter: args.interpreter, code: args.code, timeout: args.timeoutSeconds }) }, signal, transport);
		const result = bindReceipt(response.data, response.status, id, "run", args.worker, session, fingerprint);
		return { id, result, replayed: response.status === 409, output_available: result.body !== undefined };
	} catch (error) { throw new MainplaneError(visibleError(error) + "; inspect receipt " + id + " before any retry"); }
}
export async function readRemoteText(origin: string, token: string, worker: string, path: string,
	signal?: AbortSignal, transport: typeof fetch = fetch) {
	if (!WORKER_ID.test(worker) || !path || Buffer.byteLength(path, "utf8") > 4096 || path.includes("\0")) throw new MainplaneError("Invalid worker or remote path");
	const { data } = await bridgeRequest(origin, token, { path: "/fleet/read", method: "POST", timeoutMs: 35_000,
		responseLimit: 2 * 1024 * 1024, body: JSON.stringify({ worker, path }) }, signal, transport);
	if (data.schema_version !== 1 || data.worker !== worker || typeof data.data_base64 !== "string" || typeof data.bytes !== "number" || !Number.isSafeInteger(data.bytes) || data.bytes < 0 || data.bytes > 1024 * 1024 || typeof data.sha256 !== "string" || !SHA256.test(data.sha256)) throw new MainplaneError("Mainplane returned invalid read metadata");
	const bytes = Buffer.from(data.data_base64, "base64");
	if (bytes.toString("base64") !== data.data_base64 || bytes.byteLength !== data.bytes || digest(bytes) !== data.sha256) throw new MainplaneError("Mainplane read digest or length mismatch");
	let value: string;
	try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new MainplaneError("Mainplane returned binary; use a binary-aware artifact tool"); }
	// Reject NUL anywhere in the verified payload, including beyond the preview.
	if (value.includes("\0")) {
		throw new MainplaneError("Mainplane returned binary; use a binary-aware artifact tool");
	}
	let end = Math.min(value.length, 50_000);
	if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end--;
	return { text: value.slice(0, end), bytes: bytes.byteLength, sha256: data.sha256, truncated: end < value.length };
}
export default function mainplaneWorkerBridge(pi: ExtensionAPI) {
	const { z } = pi.zod;
	pi.registerTool({
		name: "mainplane_worker_run", label: "Mainplane native worker run",
		description: "Run on an owned Go worker. Uncertain outcomes and nonzero exits are errors; never blindly replay.",
		parameters: z.object({ worker: z.string().regex(WORKER_ID), interpreter: z.string().regex(WORKER_ID), code: z.string().min(1).max(256 * 1024), timeoutSeconds: z.number().int().min(1).max(600).default(90) }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return { content: [{ type: "text", text: "A persisted Veyyon session is required" }], isError: true };
			try {
				const answer = await runRemote(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "", { ...params, sessionFile, toolCallId }, signal);
				return { content: [{ type: "text", text: JSON.stringify(answer) }], isError: receiptIsError(answer.result),
					details: { run_id: answer.id, state: answer.result.state, exit: answer.result.exit, replayed: answer.replayed } };
			} catch (error) { return { content: [{ type: "text", text: visibleError(error) }], isError: true }; }
		},
	});
	pi.registerTool({
		name: "mainplane_worker_read_text", label: "Mainplane native worker file read",
		description: "Read verified UTF-8 from an owned Go worker; binary data is not disguised as text.",
		parameters: z.object({ worker: z.string().regex(WORKER_ID), path: z.string().min(1).max(4096) }),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await readRemoteText(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "", params.worker, params.path, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			} catch (error) { return { content: [{ type: "text", text: visibleError(error) }], isError: true }; }
		},
	});
	pi.registerTool({
		name: "mainplane_run_receipt", label: "Mainplane operation receipt",
		description: "Inspect a validated durable operation receipt; never executes or retries work. Accepted jobs remain pending.",
		parameters: z.object({ runId: z.string().regex(WORKER_ID) }),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await readRemoteReceipt(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "", params.runId, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], isError: receiptIsError(result) };
			} catch (error) { return { content: [{ type: "text", text: visibleError(error) }], isError: true }; }
		},
	});
	registerMainplaneWrite(pi);
	registerMainplaneCancellation(pi);
	registerMainplaneOutputRecovery(pi);
	registerMainplaneJobs(pi);
}
