import type { ExtensionAPI } from "@veyyon/coding-agent";
import { bindReceipt, bridgeRequest, digest, MainplaneError, mainplaneRequestHash,
	remoteRunId, remoteSessionId, visibleError, WORKER_ID } from "./mainplane-bridge-wire";

export async function cancelRemoteSession(origin: string, token: string,
	input: { worker: string; sessionFile: string; toolCallId: string }, signal?: AbortSignal, transport: typeof fetch = fetch) {
	if (!WORKER_ID.test(input.worker)) throw new MainplaneError("Invalid worker");
	const id = remoteRunId(input.sessionFile, input.toolCallId);
	const session = remoteSessionId(input.sessionFile);
	try {
		const response = await bridgeRequest(origin, token, { path: "/fleet/kill", method: "POST", key: id,
			timeoutMs: 35_000, statuses: [200, 409, 502], body: JSON.stringify({ worker: input.worker, session }) }, signal, transport);
		const result = bindReceipt(response.data, response.status, id, "kill", input.worker, session,
			mainplaneRequestHash("kill", input.worker, session));
		if (result.state === "completed" && (result.exit !== 0 || result.output_sha256 !== digest(""))) {
			throw new MainplaneError("Invalid native cancellation acknowledgement");
		}
		return { id, result, replayed: response.status === 409 };
	} catch (error) {
		throw new MainplaneError(visibleError(error) + "; inspect receipt " + id + " before any retry");
	}
}

export function registerMainplaneCancellation(pi: ExtensionAPI): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "mainplane_worker_cancel_session", label: "Cancel this session on a Mainplane worker",
		description: "Explicitly stop this Veyyon session's interpreters and jobs on one owned worker. Does not stop other sessions. Never used automatically for compaction or a timeout.",
		parameters: z.object({ worker: z.string().regex(WORKER_ID) }).strict(),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return { content: [{ type: "text", text: "Cancellation requires the persisted current session" }], isError: true };
			try {
				const result = await cancelRemoteSession(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "",
					{ worker: params.worker, sessionFile, toolCallId }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result.result.state !== "completed",
					details: { run_id: result.id, state: result.result.state, worker: params.worker } };
			} catch (error) { return { content: [{ type: "text", text: visibleError(error) }], isError: true }; }
		},
	});
}
