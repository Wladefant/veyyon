import type { ExtensionAPI } from "@veyyon/coding-agent";
import { bindReceipt, bridgeRequest, MainplaneError, mainplaneRequestHash, receiptIsError,
	remoteRunId, remoteSessionId, validateReceipt, visibleError, WORKER_ID } from "./mainplane-bridge-wire";

export interface JobInput { worker: string; interpreter: string; code: string; sessionFile: string; toolCallId: string; }

export async function startRemoteJob(origin: string, token: string, input: JobInput,
	signal?: AbortSignal, transport: typeof fetch = fetch) {
	if (!WORKER_ID.test(input.worker) || !WORKER_ID.test(input.interpreter) || !input.code.trim()) throw new MainplaneError("Invalid native job request");
	const id = remoteRunId(input.sessionFile, input.toolCallId); const session = remoteSessionId(input.sessionFile);
	const fingerprint = mainplaneRequestHash("job", input.worker, session, input.interpreter, input.code);
	try {
		const response = await bridgeRequest(origin, token, { path: "/fleet/job", method: "POST", key: id,
			timeoutMs: 35_000, statuses: [202, 409, 502],
			body: JSON.stringify({ worker: input.worker, session, interpreter: input.interpreter, code: input.code }) }, signal, transport);
		const result = bindReceipt(response.data, response.status, id, "job", input.worker, session, fingerprint);
		return { id, result, replayed: response.status === 409, background: true,
			completed: result.state === "completed", process_succeeded: result.state === "completed" && result.exit === 0 };
	} catch (error) { throw new MainplaneError(visibleError(error) + "; inspect receipt " + id + " before any retry"); }
}

export async function inspectRemoteJob(origin: string, token: string, input: { runId: string; sessionFile: string },
	signal?: AbortSignal, transport: typeof fetch = fetch) {
	if (!WORKER_ID.test(input.runId)) throw new MainplaneError("Invalid native job key");
	const session = remoteSessionId(input.sessionFile);
	const response = await bridgeRequest(origin, token, { path: "/fleet/runs/" + input.runId, method: "GET" }, signal, transport);
	const result = validateReceipt(response.data, input.runId, "job");
	if (result.session !== session) throw new MainplaneError("Job belongs to another Veyyon session");
	return { id: input.runId, result, background: true, completed: result.state === "completed",
		process_succeeded: result.state === "completed" && result.exit === 0,
		requires_reconciliation: result.state === "uncertain" || result.state === "submitting" };
}

export function registerMainplaneJobs(pi: ExtensionAPI): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "mainplane_worker_start_job", label: "Start a native Mainplane background job",
		description: "Start owned-worker background work with a durable key. Accepted is pending, not success. Never relaunch uncertain work; inspect its receipt.",
		parameters: z.object({ worker: z.string().regex(WORKER_ID), interpreter: z.string().regex(WORKER_ID), code: z.string().min(1).max(256 * 1024) }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return { content: [{ type: "text", text: "Job launch requires the current persisted session" }], isError: true };
			try {
				const result = await startRemoteJob(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "", { ...params, sessionFile, toolCallId }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], isError: receiptIsError(result.result),
					details: { run_id: result.id, state: result.result.state, background: true, completed: result.completed } };
			} catch (error) { return { content: [{ type: "text", text: visibleError(error) }], isError: true }; }
		},
	});
	pi.registerTool({
		name: "mainplane_worker_job_status", label: "Inspect native background job status",
		description: "Read this session's durable job receipt. A restarted/untracked job is uncertain, not automatically relaunched or called running.",
		parameters: z.object({ runId: z.string().regex(WORKER_ID) }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return { content: [{ type: "text", text: "Job inspection requires the current persisted session" }], isError: true };
			try {
				const result = await inspectRemoteJob(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "", { ...params, sessionFile }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], isError: receiptIsError(result.result),
					details: { run_id: result.id, state: result.result.state, completed: result.completed } };
			} catch (error) { return { content: [{ type: "text", text: visibleError(error) }], isError: true }; }
		},
	});
}
