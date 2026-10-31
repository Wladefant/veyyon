/** Optional tools for the owner's native Mainplane Go bridge; never loaded by default. */
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@veyyon/coding-agent";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_REQUEST = 256 * 1024;
const MAX_REPLY = 512 * 1024;
// Go retains two 50 KiB outputs; JSON control escaping can expand NUL-heavy output sixfold.
const MAX_RUN_REPLY = 1024 * 1024;

export class MainplaneError extends Error {}
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function bridgeOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new MainplaneError("Mainplane URL is not a valid origin");
	}
	if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new MainplaneError("Mainplane URL must be a bare origin without credentials");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
		throw new MainplaneError("Mainplane bridge requires HTTPS except local loopback");
	}
	return url.origin;
}

function checkToken(token: string): void {
	if (!token || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) {
		throw new MainplaneError("Missing or invalid Mainplane key");
	}
}

export function remoteRunId(sessionFile: string, toolCallId: string): string {
	if (!sessionFile || !toolCallId || sessionFile.includes("\0") || toolCallId.includes("\0")) {
		throw new MainplaneError("Persisted session and tool-call identities are required");
	}
	return "sb-" + hash(sessionFile + "\0" + toolCallId).slice(0, 48);
}

export function remoteSessionId(sessionFile: string): string {
	if (!sessionFile) throw new MainplaneError("Persisted session is required");
	return "sb-" + hash(sessionFile).slice(0, 40);
}

/** Same UTF-8 byte framing as the native Go bridge, independent of JSON encoding. */
export function mainplaneRequestHash(...parts: string[]): string {
	const digest = createHash("sha256");
	for (const part of ["superboard-mainplane-v2", ...parts]) {
		const bytes = Buffer.from(part, "utf8");
		if (bytes.toString("utf8") !== part) throw new MainplaneError("Request contains invalid Unicode");
		digest.update(String(bytes.byteLength) + ":");
		digest.update(bytes);
	}
	return digest.digest("hex");
}

async function boundedJson(response: Response, limit: number): Promise<Record<string, unknown>> {
	if (!response.body) throw new MainplaneError("Mainplane response body is empty");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new MainplaneError("Mainplane response exceeded limit");
			chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
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
		throw new MainplaneError("Mainplane returned malformed JSON");
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new MainplaneError("Mainplane returned malformed record");
	}
	return data as Record<string, unknown>;
}

async function exchange(
	origin: string, token: string, path: string, method: "GET" | "POST", body: string | undefined,
	key: string | undefined, timeoutMs: number, limit: number, allowed: readonly number[],
	signal: AbortSignal | undefined, transport: typeof fetch,
): Promise<{ status: number; data: Record<string, unknown> }> {
	const url = bridgeOrigin(origin) + path;
	checkToken(token);
	if (body !== undefined && Buffer.byteLength(body, "utf8") > MAX_REQUEST) {
		throw new MainplaneError("Serialized Mainplane request exceeded byte limit");
	}
	const abort = new AbortController();
	const cancel = () => abort.abort();
	const timer = setTimeout(cancel, timeoutMs);
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		abort.signal.throwIfAborted();
		const response = await transport(url, {
			method, body, redirect: "error", signal: abort.signal,
			headers: { Authorization: "Bearer " + token, "Content-Type": "application/json",
				...(key ? { "Idempotency-Key": key } : {}) },
		});
		if (!allowed.includes(response.status)) {
			void response.body?.cancel().catch(() => undefined);
			throw new MainplaneError("Mainplane request refused (" + response.status + ")");
		}
		return { status: response.status, data: await boundedJson(response, limit) };
	} catch (error) {
		if (error instanceof MainplaneError) throw error;
		throw new MainplaneError("Mainplane transport failed or timed out; execution outcome may be uncertain");
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", cancel);
	}
}

export interface RunReceipt {
	schema_version: 2;
	idempotency_sha256: string;
	request_sha256: string;
	operation: "run";
	worker: string;
	session: string;
	state: "submitting" | "uncertain" | "completed";
	exit?: number;
	output_sha256?: string;
	cut?: number;
	full?: string;
	body?: string;
}

export function validateRunReceipt(value: Record<string, unknown>, runId: string): RunReceipt {
	if (value.schema_version !== 2 || value.operation !== "run" ||
		value.idempotency_sha256 !== hash(runId) || typeof value.request_sha256 !== "string" ||
		!SHA256.test(value.request_sha256) || typeof value.worker !== "string" || !ID.test(value.worker) ||
		typeof value.session !== "string" || !ID.test(value.session) ||
		!["submitting", "uncertain", "completed"].includes(String(value.state))) {
		throw new MainplaneError("Mainplane receipt identity or schema mismatch");
	}
	const result: RunReceipt = {
		schema_version: 2, operation: "run", idempotency_sha256: hash(runId),
		request_sha256: value.request_sha256, worker: value.worker, session: value.session,
		state: value.state as RunReceipt["state"],
	};
	if (result.state === "completed") {
		if (typeof value.exit !== "number" || !Number.isSafeInteger(value.exit) ||
			typeof value.output_sha256 !== "string" || !SHA256.test(value.output_sha256)) {
			throw new MainplaneError("Mainplane completed receipt has no valid exit or output digest");
		}
		result.exit = value.exit;
		result.output_sha256 = value.output_sha256;
		if (value.body !== undefined) {
			if (typeof value.body !== "string" || hash(value.body) !== value.output_sha256) {
				throw new MainplaneError("Mainplane output digest mismatch");
			}
			result.body = value.body;
		}
	} else if (value.exit !== undefined || value.output_sha256 !== undefined || value.body !== undefined) {
		throw new MainplaneError("Unconfirmed Mainplane receipt cannot claim output");
	}
	if (value.cut !== undefined) {
		if (typeof value.cut !== "number" || !Number.isSafeInteger(value.cut) || value.cut < 0) {
			throw new MainplaneError("Mainplane output cut count is invalid");
		}
		result.cut = value.cut;
	}
	if (value.full !== undefined) {
		if (typeof value.full !== "string" || value.full.length > 4096) {
			throw new MainplaneError("Mainplane output reference is invalid");
		}
		result.full = value.full;
	}
	return result;
}

export async function readRemoteReceipt(
	origin: string, token: string, runId: string, signal?: AbortSignal, transport: typeof fetch = fetch,
): Promise<RunReceipt> {
	if (!ID.test(runId)) throw new MainplaneError("Invalid Mainplane run identifier");
	const { data } = await exchange(origin, token, "/fleet/runs/" + runId, "GET", undefined,
		undefined, 30_000, MAX_REPLY, [200], signal, transport);
	return validateRunReceipt(data, runId);
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
	origin: string, token: string, args: RunInput, signal?: AbortSignal, transport: typeof fetch = fetch,
): Promise<{ id: string; result: RunReceipt; replayed: boolean; output_available: boolean }> {
	if (!ID.test(args.worker) || !ID.test(args.interpreter) ||
		!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 1 || args.timeoutSeconds > 600 ||
		!args.code.trim()) throw new MainplaneError("Invalid Mainplane worker execution fields");
	const id = remoteRunId(args.sessionFile, args.toolCallId);
	const session = remoteSessionId(args.sessionFile);
	const fingerprint = mainplaneRequestHash("run", args.worker, session, args.interpreter,
		String(args.timeoutSeconds), args.code);
	const { data, status } = await exchange(origin, token, "/fleet/run", "POST", JSON.stringify({
		worker: args.worker, session, interpreter: args.interpreter, code: args.code, timeout: args.timeoutSeconds,
	}), id, (args.timeoutSeconds + 15) * 1000, MAX_RUN_REPLY, [200, 409, 502], signal, transport);
	const result = validateRunReceipt(data, id);
	if (result.request_sha256 !== fingerprint || result.worker !== args.worker || result.session !== session) {
		throw new MainplaneError("Mainplane receipt belongs to different work");
	}
	if ((status === 200 && result.state !== "completed") || (status === 502 && result.state !== "uncertain")) {
		throw new MainplaneError("Mainplane HTTP status contradicts its receipt");
	}
	return { id, result, replayed: status === 409, output_available: result.body !== undefined };
}

export async function readRemoteText(
	origin: string, token: string, worker: string, path: string,
	signal?: AbortSignal, transport: typeof fetch = fetch,
): Promise<{ text: string; bytes: number; sha256: string; truncated: boolean }> {
	if (!ID.test(worker) || !path || Buffer.byteLength(path, "utf8") > 4096 || path.includes("\0")) {
		throw new MainplaneError("Invalid worker or remote path");
	}
	const { data } = await exchange(origin, token, "/fleet/read", "POST", JSON.stringify({ worker, path }),
		undefined, 35_000, 2 * 1024 * 1024, [200], signal, transport);
	if (data.schema_version !== 1 || data.worker !== worker || typeof data.data_base64 !== "string" ||
		typeof data.bytes !== "number" || !Number.isSafeInteger(data.bytes) || data.bytes < 0 ||
		data.bytes > 1024 * 1024 || typeof data.sha256 !== "string" || !SHA256.test(data.sha256)) {
		throw new MainplaneError("Mainplane returned invalid read metadata");
	}
	const bytes = Buffer.from(data.data_base64, "base64");
	if (bytes.toString("base64") !== data.data_base64 || bytes.byteLength !== data.bytes || hash(bytes) !== data.sha256) {
		throw new MainplaneError("Mainplane read digest or length mismatch");
	}
	let value: string;
	try {
		value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new MainplaneError("Mainplane returned binary; use a binary-aware artifact tool");
	}
	// Reject NUL anywhere in the verified payload, including beyond the preview.
	if (value.includes("\0")) {
		throw new MainplaneError("Mainplane returned binary; use a binary-aware artifact tool");
	}
	let end = Math.min(value.length, 50_000);
	if (end < value.length && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end--;
	return { text: value.slice(0, end), bytes: bytes.byteLength, sha256: data.sha256, truncated: end < value.length };
}

function visibleError(error: unknown): string {
	return error instanceof MainplaneError ? error.message : "Mainplane operation failed; inspect its receipt before retrying";
}

export default function mainplaneWorkerBridge(pi: ExtensionAPI) {
	const { z } = pi.zod;
	pi.registerTool({
		name: "mainplane_worker_run", label: "Mainplane native worker run",
		description: "Run on a named owned Go worker. Uncertain outcomes and nonzero exits are errors; never blindly replay.",
		parameters: z.object({ worker: z.string().regex(ID), interpreter: z.string().regex(ID),
			code: z.string().min(1).max(MAX_REQUEST), timeoutSeconds: z.number().int().min(1).max(600).default(90) }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) return { content: [{ type: "text", text: "A persisted Veyyon session is required" }], isError: true };
			try {
				const answer = await runRemote(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "",
					{ ...params, sessionFile, toolCallId }, signal);
				return { content: [{ type: "text", text: JSON.stringify(answer) }],
					isError: answer.result.state !== "completed" || answer.result.exit !== 0,
					details: { run_id: answer.id, state: answer.result.state, exit: answer.result.exit, replayed: answer.replayed } };
			} catch (error) {
				return { content: [{ type: "text", text: visibleError(error) }], isError: true };
			}
		},
	});
	pi.registerTool({
		name: "mainplane_worker_read_text", label: "Mainplane native worker file read",
		description: "Read verified UTF-8 from a named owned Go worker; binary data is not disguised as text.",
		parameters: z.object({ worker: z.string().regex(ID), path: z.string().min(1).max(4096) }),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await readRemoteText(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "",
					params.worker, params.path, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			} catch (error) {
				return { content: [{ type: "text", text: visibleError(error) }], isError: true };
			}
		},
	});
	pi.registerTool({
		name: "mainplane_run_receipt", label: "Mainplane run receipt",
		description: "Inspect a validated durable receipt; this does not execute or retry work.",
		parameters: z.object({ runId: z.string().regex(ID) }),
		async execute(_toolCallId, params, signal) {
			try {
				const result = await readRemoteReceipt(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "",
					params.runId, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }],
					isError: result.state !== "completed" || result.exit !== 0 };
			} catch (error) {
				return { content: [{ type: "text", text: visibleError(error) }], isError: true };
			}
		},
	});
}
