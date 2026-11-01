import { createHash } from "node:crypto";

export const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export class MainplaneError extends Error {}
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function bridgeOrigin(value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new MainplaneError("Mainplane URL is not a valid origin"); }
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new MainplaneError("Mainplane URL must be a bare origin without credentials");
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new MainplaneError("Mainplane bridge requires HTTPS except local loopback");
	return url.origin;
}
export function remoteRunId(sessionFile: string, toolCallId: string): string {
	if (!sessionFile || !toolCallId || sessionFile.includes("\0") || toolCallId.includes("\0")) throw new MainplaneError("Persisted session and tool-call identities are required");
	return "sb-" + digest(sessionFile + "\0" + toolCallId).slice(0, 48);
}
export function remoteSessionId(sessionFile: string): string {
	if (!sessionFile) throw new MainplaneError("Persisted session is required");
	return "sb-" + digest(sessionFile).slice(0, 40);
}
export function remoteJobId(runId: string): string { return "sb-" + digest(runId).slice(0, 48); }
export function mainplaneRequestHash(...parts: string[]): string {
	const hash = createHash("sha256");
	for (const part of ["superboard-mainplane-v2", ...parts]) {
		const bytes = Buffer.from(part, "utf8");
		if (bytes.toString("utf8") !== part) throw new MainplaneError("Request contains invalid Unicode");
		hash.update(String(bytes.byteLength) + ":"); hash.update(bytes);
	}
	return hash.digest("hex");
}
async function boundedJson(response: Response, limit: number): Promise<Record<string, unknown>> {
	if (!response.body) throw new MainplaneError("Mainplane response body is empty");
	const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read(); if (done) break;
			size += value.byteLength; if (size > limit) throw new MainplaneError("Mainplane response exceeded limit");
			chunks.push(value);
		}
	} finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
	const bytes = new Uint8Array(size); let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	let data: unknown;
	try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
	catch { throw new MainplaneError("Mainplane returned malformed JSON"); }
	if (!data || typeof data !== "object" || Array.isArray(data)) throw new MainplaneError("Mainplane returned malformed record");
	return data as Record<string, unknown>;
}
export interface BridgeRequest {
	path: string; method: "GET" | "POST"; body?: string; key?: string; timeoutMs?: number;
	responseLimit?: number; requestLimit?: number; statuses?: readonly number[];
}
export async function bridgeRequest(origin: string, token: string, options: BridgeRequest,
	signal?: AbortSignal, transport: typeof fetch = fetch): Promise<{ status: number; data: Record<string, unknown> }> {
	const url = bridgeOrigin(origin) + options.path;
	if (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) throw new MainplaneError("Missing or invalid Mainplane key");
	if (options.body !== undefined && Buffer.byteLength(options.body, "utf8") > (options.requestLimit ?? 256 * 1024)) throw new MainplaneError("Serialized Mainplane request exceeded byte limit");
	const abort = new AbortController(); const cancel = () => abort.abort();
	const timer = setTimeout(cancel, options.timeoutMs ?? 30_000);
	signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
	try {
		abort.signal.throwIfAborted();
		const response = await transport(url, { method: options.method, body: options.body, redirect: "error", signal: abort.signal,
			headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(options.key ? { "Idempotency-Key": options.key } : {}) } });
		if (!(options.statuses ?? [200]).includes(response.status)) {
			void response.body?.cancel().catch(() => undefined);
			throw new MainplaneError("Mainplane request refused (" + response.status + ")");
		}
		return { status: response.status, data: await boundedJson(response, options.responseLimit ?? 512 * 1024) };
	} catch (error) {
		if (error instanceof MainplaneError) throw error;
		throw new MainplaneError("Mainplane transport failed or timed out; execution outcome may be uncertain");
	} finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
export interface BridgeReceipt {
	schema_version: 2; idempotency_sha256: string; request_sha256: string; operation: "run" | "write" | "kill" | "job";
	worker: string; session: string; state: "submitting" | "uncertain" | "accepted" | "cancelled" | "completed";
	exit?: number; output_sha256?: string; cut?: number; full?: string; body?: string;
	job?: string; pid?: number; log?: string; owner_instance?: string;
}
export function validateReceipt(value: Record<string, unknown>, runId: string, operation?: BridgeReceipt["operation"]): BridgeReceipt {
	if (value.schema_version !== 2 || typeof value.operation !== "string" ||
		!["run", "write", "kill", "job"].includes(value.operation) ||
		(operation !== undefined && value.operation !== operation) || value.idempotency_sha256 !== digest(runId) ||
		typeof value.request_sha256 !== "string" || !SHA256.test(value.request_sha256) ||
		typeof value.worker !== "string" || !WORKER_ID.test(value.worker) || typeof value.session !== "string" || !WORKER_ID.test(value.session) ||
		typeof value.state !== "string" ||
		!["submitting", "uncertain", "accepted", "cancelled", "completed"].includes(value.state)) throw new MainplaneError("Mainplane receipt identity or schema mismatch");
	const result: BridgeReceipt = { schema_version: 2, operation: value.operation as BridgeReceipt["operation"],
		idempotency_sha256: digest(runId), request_sha256: value.request_sha256, worker: value.worker,
		session: value.session, state: value.state as BridgeReceipt["state"] };
	if (result.operation === "job") {
		if (value.job !== remoteJobId(runId) || typeof value.owner_instance !== "string" || !WORKER_ID.test(value.owner_instance) ||
			(value.pid !== undefined && (typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 0)) ||
			(value.log !== undefined && (typeof value.log !== "string" || !value.log || Buffer.byteLength(value.log, "utf8") > 4096))) {
			throw new MainplaneError("Mainplane job identity is invalid");
		}
		if (["accepted", "completed", "cancelled"].includes(result.state) &&
			(typeof value.pid !== "number" || value.pid < 1 || typeof value.log !== "string" || !value.log)) {
			throw new MainplaneError("Mainplane acknowledged job has no native PID/log");
		}
		result.job = value.job; result.owner_instance = value.owner_instance;
		if (value.pid !== undefined) result.pid = value.pid as number;
		if (value.log !== undefined) result.log = value.log as string;
	} else if (value.job !== undefined || value.pid !== undefined || value.log !== undefined || value.owner_instance !== undefined ||
		result.state === "accepted" || result.state === "cancelled") throw new MainplaneError("Non-job receipt contains job lifecycle data");
	if (result.state === "completed") {
		if (typeof value.exit !== "number" || !Number.isSafeInteger(value.exit) || typeof value.output_sha256 !== "string" || !SHA256.test(value.output_sha256)) throw new MainplaneError("Mainplane completed receipt has no valid exit or output digest");
		result.exit = value.exit; result.output_sha256 = value.output_sha256;
		if (value.body !== undefined) {
			if (typeof value.body !== "string" || digest(value.body) !== value.output_sha256) throw new MainplaneError("Mainplane output digest mismatch");
			result.body = value.body;
		}
	} else if (value.exit !== undefined || value.output_sha256 !== undefined || value.body !== undefined) throw new MainplaneError("Unconfirmed Mainplane receipt cannot claim output");
	if (value.cut !== undefined) {
		if (typeof value.cut !== "number" || !Number.isSafeInteger(value.cut) || value.cut < 0) throw new MainplaneError("Mainplane output cut count is invalid");
		result.cut = value.cut;
	}
	if (value.full !== undefined) {
		if (typeof value.full !== "string" || Buffer.byteLength(value.full, "utf8") > 4096) throw new MainplaneError("Mainplane output reference is invalid");
		result.full = value.full;
	}
	return result;
}
export function bindReceipt(value: Record<string, unknown>, status: number, id: string,
	operation: BridgeReceipt["operation"], worker: string, session: string, fingerprint: string): BridgeReceipt {
	const result = validateReceipt(value, id, operation);
	if (result.request_sha256 !== fingerprint || result.worker !== worker || result.session !== session) throw new MainplaneError("Mainplane receipt belongs to different work");
	if ((status === 200 && result.state !== "completed") || (status === 202 && result.state !== "accepted") ||
		(status === 502 && result.state !== "uncertain")) throw new MainplaneError("Mainplane HTTP status contradicts its receipt");
	return result;
}
export function receiptIsError(receipt: BridgeReceipt): boolean {
	return receipt.state !== "accepted" && (receipt.state !== "completed" || receipt.exit !== 0);
}
export function visibleError(error: unknown): string {
	return error instanceof MainplaneError ? error.message : "Mainplane operation failed; inspect its receipt before retrying";
}
