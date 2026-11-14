import { postmortem } from "@veyyon/utils";
import { resolveLiveToolCaller } from "../../internal-urls/history-caller";
import type { AgentRef } from "../../registry/agent-registry";
import type { ToolSession } from "..";

export const CALLER_ATTESTATION_PATH = "/v1/caller";
export const CALLER_ATTESTATION_TTL_SECONDS = 24 * 60 * 60;
const MAX_ACTIVE_CALLER_RECEIPTS = 4096;

export const RESERVED_CALLER_ENV_KEYS: Readonly<Record<string, true>> = Object.freeze({
	VEYYON_CALLER_URL: true,
	VEYYON_CALLER_TOKEN: true,
	VEYYON_AGENT_ID: true,
	VEYYON_SESSION_FILE: true,
});

const CLEARED_CALLER_ENV: Readonly<Record<string, string>> = Object.freeze({
	VEYYON_CALLER_URL: "",
	VEYYON_CALLER_TOKEN: "",
	VEYYON_AGENT_ID: "",
	VEYYON_SESSION_FILE: "",
});

export interface CallerAttestationReceipt {
	readonly version: 1;
	readonly caller_id: string;
	readonly caller_kind: "main" | "sub";
	readonly session_file: string | null;
	readonly session_id: string;
	readonly root_id: string;
	readonly root_session_file: string | null;
	readonly issued_at: number;
	readonly expires_at: number;
}

export interface AttestedBashCaller {
	readonly callerId: string;
	readonly callerKind: "main" | "sub";
	readonly sessionId: string;
	readonly sessionFile: string | null;
	readonly rootId: string;
	readonly rootSessionFile: string | null;
}

interface StoredCallerReceipt {
	readonly receipt: CallerAttestationReceipt;
	readonly expiresAtMs: number;
}

interface AttestationHostState {
	server: Bun.Server<undefined> | undefined;
	url: string | undefined;
	cancelCleanup: (() => void) | undefined;
	readonly receipts: Map<string, StoredCallerReceipt>;
}

const state: AttestationHostState = {
	server: undefined,
	url: undefined,
	cancelCleanup: undefined,
	receipts: new Map(),
};

function readLiveSessionFile(ref: AgentRef): string | null {
	try {
		const fromManager = ref.session?.sessionManager?.getSessionFile?.();
		if (typeof fromManager === "string" && fromManager.trim().length > 0) {
			return fromManager;
		}
	} catch {
		// Fall back to the registry's recorded path if SessionManager throws during teardown.
	}
	return typeof ref.sessionFile === "string" && ref.sessionFile.trim().length > 0 ? ref.sessionFile : null;
}

function pruneExpiredReceipts(nowMs: number): void {
	for (const [token, entry] of state.receipts) {
		if (nowMs >= entry.expiresAtMs) {
			state.receipts.delete(token);
		}
	}
}

function parseBearerToken(header: string | null): string | undefined {
	if (!header) return undefined;
	const match = /^Bearer\s+(\S+)$/.exec(header.trim());
	return match?.[1];
}

function handleCallerRequest(request: Request): Response {
	const url = new URL(request.url);
	if (url.pathname !== CALLER_ATTESTATION_PATH) {
		return new Response("Not Found", { status: 404 });
	}
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET" },
		});
	}

	const nowMs = Date.now();
	pruneExpiredReceipts(nowMs);

	const token = parseBearerToken(request.headers.get("authorization"));
	if (!token) {
		return new Response("Unauthorized", { status: 401 });
	}

	const entry = state.receipts.get(token);
	if (!entry || nowMs >= entry.expiresAtMs) {
		if (entry) state.receipts.delete(token);
		return new Response("Unauthorized", { status: 401 });
	}

	return Response.json(entry.receipt, {
		headers: {
			"Cache-Control": "no-store",
		},
	});
}

function ensureAttestationServer(): string {
	if (state.server && state.url) {
		return state.url;
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 10,
		fetch: handleCallerRequest,
		error() {
			return new Response("Internal Server Error", { status: 500 });
		},
	});
	// Keep the attestation host from holding the CLI or test runner open when idle.
	server.unref();

	const port = server.port;
	if (typeof port !== "number" || port <= 0) {
		void server.stop(true);
		throw new Error("Caller attestation server failed to bind a loopback port");
	}

	state.server = server;
	state.url = `http://127.0.0.1:${port}${CALLER_ATTESTATION_PATH}`;
	state.cancelCleanup = postmortem.register("bash-caller-attestation", async () => {
		await stopCallerAttestationServer();
	});
	return state.url;
}

function mintOpaqueToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

function mintCallerReceipt(
	caller: AttestedBashCaller,
	options: { nowMs?: number; ttlSeconds?: number } = {},
): { url: string; token: string; receipt: CallerAttestationReceipt } {
	const nowMs = options.nowMs ?? Date.now();
	const rawTtl = options.ttlSeconds ?? CALLER_ATTESTATION_TTL_SECONDS;
	const ttlSeconds = Math.max(1, Math.min(CALLER_ATTESTATION_TTL_SECONDS, Math.floor(rawTtl)));
	const issuedAt = Math.floor(nowMs / 1000);
	const expiresAt = issuedAt + ttlSeconds;
	const expiresAtMs = expiresAt * 1000;

	pruneExpiredReceipts(nowMs);
	while (state.receipts.size >= MAX_ACTIVE_CALLER_RECEIPTS) {
		const oldestKey = state.receipts.keys().next().value;
		if (oldestKey === undefined) break;
		state.receipts.delete(oldestKey);
	}

	const url = ensureAttestationServer();
	const token = mintOpaqueToken();
	const receipt: CallerAttestationReceipt = {
		version: 1,
		caller_id: caller.callerId,
		caller_kind: caller.callerKind,
		session_file: caller.sessionFile,
		session_id: caller.sessionId,
		root_id: caller.rootId,
		root_session_file: caller.rootSessionFile,
		issued_at: issuedAt,
		expires_at: expiresAt,
	};
	state.receipts.set(token, { receipt, expiresAtMs });
	return { url, token, receipt };
}

/**
 * Derive a live main or subagent caller from the host ToolSession and global
 * AgentRegistry, rooting every subagent through `registry.mainInScope(scope)`.
 * Returns undefined for advisor, synthetic, disposed, mismatched, or unrooted sessions.
 */
export function resolveAttestedBashCaller(session: ToolSession): AttestedBashCaller | undefined {
	const caller = resolveLiveToolCaller(session);
	if (!caller) return undefined;

	const { actor, agentId, registry, scope, sessionId } = caller;
	if (actor.kind !== "main" && actor.kind !== "sub") {
		return undefined;
	}

	const root = registry.mainInScope(scope);
	if (
		!root ||
		root.kind !== "main" ||
		root.scope !== scope ||
		(root.status !== "running" && root.status !== "idle") ||
		!root.session ||
		root.session.isDisposed
	) {
		return undefined;
	}
	if (actor.kind === "main" && root.id !== actor.id) {
		return undefined;
	}

	return {
		callerId: agentId,
		callerKind: actor.kind,
		sessionId,
		sessionFile: readLiveSessionFile(actor),
		rootId: root.id,
		rootSessionFile: readLiveSessionFile(root),
	};
}

/**
 * Build the four authoritative caller attestation env vars for a `BashTool`
 * invocation. When the session has no live attested caller (synthetic/test/advisor/
 * mismatched), returns empty strings so inherited Main receipts are stripped.
 */
export function resolveBashCallerEnv(session: ToolSession): Readonly<Record<string, string>> {
	const caller = resolveAttestedBashCaller(session);
	if (!caller) {
		return CLEARED_CALLER_ENV;
	}

	const { url, token } = mintCallerReceipt(caller);
	return {
		VEYYON_CALLER_URL: url,
		VEYYON_CALLER_TOKEN: token,
		VEYYON_AGENT_ID: caller.callerId,
		VEYYON_SESSION_FILE: caller.sessionFile ?? "",
	};
}

/** Test-only helper for deterministic expiry/pruning tests without waiting 24 hours. */
export function mintCallerReceiptForTests(
	caller: AttestedBashCaller,
	options: { nowMs?: number; ttlSeconds?: number } = {},
): { url: string; token: string; receipt: CallerAttestationReceipt } {
	return mintCallerReceipt(caller, options);
}

/** Test-only helper returning the active receipt count after pruning expired entries. */
export function activeCallerReceiptCountForTests(nowMs = Date.now()): number {
	pruneExpiredReceipts(nowMs);
	return state.receipts.size;
}

/** Shutdown and test cleanup for the lazy loopback attestation server. */
export async function stopCallerAttestationServer(): Promise<void> {
	state.receipts.clear();
	const cancel = state.cancelCleanup;
	state.cancelCleanup = undefined;
	cancel?.();

	const server = state.server;
	state.server = undefined;
	state.url = undefined;
	if (server) {
		await server.stop(true);
	}
}
