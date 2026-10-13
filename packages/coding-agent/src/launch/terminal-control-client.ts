import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { errorMessage, getConfigRootDir, isProcessAlive, isRecord } from "@veyyon/utils";
import { isValidSessionId } from "./session-notices";
import type { TerminalOwner } from "./terminal-control";

export interface TerminalControlClientOptions {
	root?: string;
	timeoutMs?: number;
}

export interface TerminalControlRotateResult {
	rotated: true;
}

/**
 * Remove secret tokens from error strings so secrets never enter error messages or CLI output.
 */
export function stripSecrets(text: string, secrets: string[]): string {
	let sanitized = text;
	for (const secret of secrets) {
		if (typeof secret === "string" && secret.length > 0) {
			sanitized = sanitized.split(secret).join("[REDACTED]");
		}
	}
	return sanitized;
}

/**
 * Validate that a discovery record has all required TerminalOwner identity and credential fields.
 */
export function isValidTerminalOwnerRecord(record: unknown): record is TerminalOwner {
	if (!isRecord(record)) return false;
	if (record.version !== 1) return false;
	if (typeof record.sessionId !== "string" || !isValidSessionId(record.sessionId)) return false;
	if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
	if (typeof record.cwd !== "string" || record.cwd.length === 0) return false;
	if (typeof record.sessionFile !== "string" || record.sessionFile.length === 0) return false;
	if (typeof record.endpoint !== "string" || record.endpoint.length === 0) return false;
	if (typeof record.token !== "string" || record.token.length === 0) return false;
	return true;
}

/**
 * Discover the single live terminal owner record for the specified session ID.
 * Rejects absent owners and ambiguous owners. Ignores stale records from dead processes.
 */
export async function discoverTerminalOwner(sessionId: string, root = getConfigRootDir()): Promise<TerminalOwner> {
	if (!isValidSessionId(sessionId)) {
		throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
	}

	const directory = path.join(root, "run", "terminals");
	let files: string[];
	try {
		files = await fs.readdir(directory);
	} catch (error) {
		if (isRecord(error) && "code" in error && error.code === "ENOENT") {
			throw new Error(`No active terminal owner found for session "${sessionId}".`);
		}
		throw error;
	}

	const matching: TerminalOwner[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		let content: string;
		try {
			content = await fs.readFile(path.join(directory, file), "utf8");
		} catch {
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			continue;
		}

		if (!isValidTerminalOwnerRecord(parsed)) continue;
		if (!isProcessAlive(parsed.pid)) continue;
		if (parsed.sessionId === sessionId) {
			matching.push(parsed);
		}
	}

	if (matching.length === 0) {
		throw new Error(`No active terminal owner found for session "${sessionId}".`);
	}
	if (matching.length > 1) {
		throw new Error(`Multiple active terminal owners found for session "${sessionId}". Ambiguous owner.`);
	}

	return matching[0]!;
}

/**
 * Send an authenticated `rotate` operation to the discovered terminal owner over its control endpoint.
 * The request is bounded by a timeout and expects `{ rotated: true }` in the response result.
 */
export async function sendTerminalControlRotate(
	owner: TerminalOwner,
	options?: { timeoutMs?: number },
): Promise<TerminalControlRotateResult> {
	const { promise, resolve, reject } = Promise.withResolvers<TerminalControlRotateResult>();
	let settled = false;
	let socket: net.Socket | undefined;

	const timeoutMs = options?.timeoutMs ?? 5_000;
	const timer = setTimeout(() => {
		settle(() => reject(new Error("Terminal control request timed out")));
	}, timeoutMs);

	const settle = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (socket !== undefined && !socket.destroyed) socket.destroy();
		fn();
	};

	try {
		socket = net.createConnection(owner.endpoint);
	} catch (error) {
		const sanitized = stripSecrets(errorMessage(error), [owner.token]);
		settle(() => reject(new Error(`Failed to connect to terminal control owner: ${sanitized}`)));
		return promise;
	}

	socket.setEncoding("utf8");

	const requestId = crypto.randomUUID();
	const requestFrame = JSON.stringify({
		version: 1,
		id: requestId,
		token: owner.token,
		sessionId: owner.sessionId,
		op: "rotate",
	});

	socket.on("connect", () => {
		if (socket && !socket.destroyed) {
			socket.write(`${requestFrame}\n`);
		}
	});

	let buffer = "";
	const MAX_BUFFER_BYTES = 64 * 1024;

	socket.on("data", chunk => {
		buffer += chunk;
		if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES) {
			settle(() => reject(new Error("Terminal control response exceeded maximum length")));
			return;
		}

		const newlineIndex = buffer.indexOf("\n");
		if (newlineIndex >= 0) {
			const line = buffer.slice(0, newlineIndex);
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				settle(() => reject(new Error("Invalid response frame from terminal control owner")));
				return;
			}

			if (!isRecord(parsed)) {
				settle(() => reject(new Error("Invalid response structure from terminal control owner")));
				return;
			}

			if (parsed.id !== requestId) {
				settle(() => reject(new Error("Response ID mismatch from terminal control owner")));
				return;
			}

			if (parsed.ok === true) {
				const result = parsed.result;
				if (!isRecord(result) || result.rotated !== true) {
					settle(() =>
						reject(new Error("Unexpected terminal control rotation response; expected { rotated: true }")),
					);
					return;
				}
				settle(() => resolve({ rotated: true }));
				return;
			}

			if (parsed.ok === false) {
				settle(() => reject(new Error("Terminal control rotation failed")));
				return;
			}

			settle(() => reject(new Error("Terminal control response missing ok status")));
		}
	});

		socket.on("error", () => {
			settle(() => reject(new Error("Failed to connect to terminal control owner")));
		});

	socket.on("close", () => {
		settle(() => reject(new Error("Terminal control socket closed before response was received")));
	});

	return promise;
}

/**
 * Discover the owner of the given session ID and perform an authenticated credential rotation.
 */
export async function rotateTerminalControl(
	sessionId: string,
	options?: TerminalControlClientOptions,
): Promise<TerminalControlRotateResult> {
	const owner = await discoverTerminalOwner(sessionId, options?.root);
	return sendTerminalControlRotate(owner, { timeoutMs: options?.timeoutMs });
}
