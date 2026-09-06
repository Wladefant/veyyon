import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listSessions } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { computeDefaultSessionDir } from "../../session/session-paths";
import { FileSessionStorage } from "../../session/session-storage";
import { writeFrame } from "../frames";
import { sessionEntryToTranscriptEntry, sessionHeaderToView, sessionInfoToSummary } from "../session-bridge";
import { disposeTurnSession, type ClientSessionState } from "../turns";
import type { ErrorScope, TranscriptEntry } from "../wire";
import type { ActionContext } from "./types";

export const sessionStorage = new FileSessionStorage();

export function sessionDirFor(cwd: string, agentDir: string): string {
	return computeDefaultSessionDir(cwd, sessionStorage, path.join(agentDir, "sessions"));
}

interface SharedSession {
	manager: SessionManager;
	clients: Set<ClientSessionState>;
}

const sharedSessions = new Map<string, SharedSession>();


export function registerSharedSession(sessionPath: string, sm: SessionManager, client?: ClientSessionState): void {
	const norm = path.resolve(sessionPath);
	let shared = sharedSessions.get(norm);
	if (!shared) {
		shared = { manager: sm, clients: new Set() };
		sharedSessions.set(norm, shared);
	}
	if (client) {
		shared.clients.add(client);
	}
}

export function unregisterSharedSession(sessionPath: string, client: ClientSessionState): void {
	const norm = path.resolve(sessionPath);
	const shared = sharedSessions.get(norm);
	if (!shared) return;
	shared.clients.delete(client);
	if (shared.clients.size === 0) {
		sharedSessions.delete(norm);
	}
}

/** Resolve a session id or file path to the file on disk, or `undefined`. */
export async function findSessionPath(session: string, cwd: string, agentDir: string): Promise<string | undefined> {
	try {
		await fs.access(session);
		return session;
	} catch {
		// Not a path: resolve it as a session id below.
	}
	const sessions = await listSessions(sessionDirFor(cwd, agentDir), sessionStorage);
	return sessions.find(s => s.id === session || s.path === session)?.path;
}

export function activeManager(ctx: ActionContext): SessionManager | undefined {
	return ctx.clientState.sessionManager ?? ctx.clientState.agentSession?.sessionManager;
}

export function isActive(sm: SessionManager | undefined, session: string): sm is SessionManager {
	return sm !== undefined && (sm.getSessionId() === session || sm.getSessionFile() === session);
}

export function replyError(ctx: ActionContext, code: string, error: unknown, scope: ErrorScope = "Session"): void {
	ctx.reply.failure({
		scope,
		code,
		message: error instanceof Error ? error.message : String(error),
		retryable: false,
	});
}

export function replySessionNotFound(ctx: ActionContext, session: string): void {
	ctx.reply.failure({
		scope: "Session",
		code: "SESSION_NOT_FOUND",
		message: `Session '${session}' was not found`,
		retryable: false,
	});
}

export function emitActiveSessionAndTranscript(
	ctx: ActionContext,
	sm: SessionManager,
	entries?: TranscriptEntry[],
): void {
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		ActiveSession: { revision: ctx.clientState.revision, value: sessionHeaderToView(sm.getHeader()) },
	});
	ctx.clientState.revision += 1;
	const transcriptEntries =
		entries ?? sm.getEntries().map(e => sessionEntryToTranscriptEntry(e, ctx.clientState.revision));
	ctx.reply.snapshot({
		Transcript: { revision: ctx.clientState.revision, value: transcriptEntries },
	});
}

export async function emitSessionList(ctx: ActionContext) {
	const sessions = await listSessions(sessionDirFor(ctx.cwd, ctx.agentDir), sessionStorage);
	const summaries = sessions.map(sessionInfoToSummary);
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Sessions: [{ revision: ctx.clientState.revision, value: summaries }, []],
	});
	return summaries;
}

export function wireSessionManager(ctx: ActionContext, sm: SessionManager): void {
	ctx.clientState.unsubscribeSession?.();
	ctx.clientState.sessionManager = sm;
	const unsubscribe = sm.onEntryAppended(entry => {
		ctx.clientState.revision += 1;
		const transcriptEntry = sessionEntryToTranscriptEntry(entry, ctx.clientState.revision);
		writeFrame(ctx.socket, {
			TranscriptAppended: { revision: ctx.clientState.revision, entries: [transcriptEntry] },
		});
	});
	ctx.clientState.unsubscribeSession = () => {
		unsubscribe();
		const sessionFile = sm.getSessionFile();
		if (sessionFile) {
			unregisterSharedSession(sessionFile, ctx.clientState);
		}
	};
}

/**
 * Make `session` the client's active session. A live agent session switches
 * in place, so its extensions see `session_before_switch` and its listeners
 * stay attached; without one the session file is opened as a plain manager,
 * and the first prompt attaches an agent over it. Returns `undefined` when
 * the session does not exist or an extension cancelled the switch, after
 * replying with the failure.
 */
export async function activateSession(ctx: ActionContext, session: string): Promise<SessionManager | undefined> {
	const current = activeManager(ctx);
	if (isActive(current, session)) return current;

	const sessionPath = await findSessionPath(session, ctx.cwd, ctx.agentDir);
	if (!sessionPath) {
		replySessionNotFound(ctx, session);
		return undefined;
	}

	const agent = ctx.clientState.agentSession;
	if (agent) {
		if (!(await agent.switchSession(sessionPath))) {
			ctx.reply.failure({
				scope: "Session",
				code: "SWITCH_CANCELLED",
				message: "An extension cancelled the session switch",
				retryable: true,
			});
			return undefined;
		}
		return agent.sessionManager;
	}

	await disposeTurnSession(ctx.clientState);
	const normalized = path.resolve(sessionPath);
	let shared = sharedSessions.get(normalized);
	let sm: SessionManager;
	if (shared) {
		sm = shared.manager;
	} else {
		sm = await SessionManager.open(sessionPath, undefined, undefined, { suppressBreadcrumb: true });
		shared = { manager: sm, clients: new Set() };
		sharedSessions.set(normalized, shared);
	}
	shared.clients.add(ctx.clientState);
	wireSessionManager(ctx, sm);
	return sm;
}
