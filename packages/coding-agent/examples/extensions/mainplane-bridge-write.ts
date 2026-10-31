import type { ExtensionAPI } from "@veyyon/coding-agent";
import { bindReceipt, bridgeRequest, digest, MainplaneError, mainplaneRequestHash,
	remoteRunId, remoteSessionId, visibleError, WORKER_ID } from "./mainplane-bridge-wire";

export interface WriteTextInput {
	worker: string;
	path: string;
	text: string;
	sessionFile: string;
	toolCallId: string;
}

export async function writeRemoteText(origin: string, token: string, input: WriteTextInput,
	signal?: AbortSignal, transport: typeof fetch = fetch) {
	if (!WORKER_ID.test(input.worker) || !input.path || Buffer.byteLength(input.path, "utf8") > 4096 || input.path.includes("\0")) {
		throw new MainplaneError("Invalid worker or remote path");
	}
	const data = Buffer.from(input.text, "utf8");
	if (data.length > 1024 * 1024 || data.toString("utf8") !== input.text) throw new MainplaneError("Write text exceeds limit or contains invalid Unicode");
	const id = remoteRunId(input.sessionFile, input.toolCallId);
	const session = remoteSessionId(input.sessionFile);
	const sha256 = digest(data);
	const fingerprint = mainplaneRequestHash("write", input.worker, session, input.path, sha256);
	try {
		const response = await bridgeRequest(origin, token, { path: "/fleet/write", method: "POST", key: id,
			timeoutMs: 50_000, requestLimit: 2 * 1024 * 1024, statuses: [200, 409, 502],
			body: JSON.stringify({ worker: input.worker, session, path: input.path, sha256, data_base64: data.toString("base64") }) }, signal, transport);
		const result = bindReceipt(response.data, response.status, id, "write", input.worker, session, fingerprint);
		if (result.state === "completed" && (result.exit !== 0 || result.output_sha256 !== sha256 || result.full !== input.path)) {
			throw new MainplaneError("Mainplane write readback does not match the intended file");
		}
		return { id, result, bytes: data.length, replayed: response.status === 409 };
	} catch (error) {
		throw new MainplaneError(visibleError(error) + "; inspect receipt " + id + " before any retry");
	}
}

export function registerMainplaneWrite(pi: ExtensionAPI): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "mainplane_worker_write_text", label: "Mainplane verified native file write",
		description: "Write exact UTF-8 to an owned worker and verify readback. This overwrites the selected path. Never replay uncertain writes.",
		parameters: z.object({ worker: z.string().regex(WORKER_ID), path: z.string().min(1).max(4096), text: z.string().max(1024 * 1024) }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return { content: [{ type: "text", text: "A persisted Veyyon session is required" }], isError: true };
			try {
				const result = await writeRemoteText(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "",
					{ ...params, sessionFile, toolCallId }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }],
					isError: result.result.state !== "completed", details: { run_id: result.id, bytes: result.bytes, state: result.result.state } };
			} catch (error) {
				return { content: [{ type: "text", text: visibleError(error) }], isError: true };
			}
		},
	});
}
