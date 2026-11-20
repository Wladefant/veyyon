import * as fs from "node:fs/promises";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, logger } from "@veyyon/utils";
import type { AgentSession } from "../session/agent-session";

/** Transfer the transcript owner to the live session only after startup succeeds. */
export async function openNativeTranscript(
	file: string,
	initialCwd: string,
	start: (manager: SessionManager) => Promise<AgentSession>,
): Promise<AgentSession> {
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd,
		suppressBreadcrumb: true,
		exclusiveOwner: true,
	});
	try {
		return await start(manager);
	} catch (error) {
		await manager.close().catch(closeError => {
			logger.warn("Closing a native transcript after failed startup failed", { error: errorMessage(closeError) });
		});
		throw error;
	}
}

export async function readNativeReviveInit(manager: SessionManager, id: string) {
	const init = manager.getEntries().findLast(entry => entry.type === "session_init");
	if (!init) throw new Error(`Cannot revive ${id}: persisted session contract is missing`);
	try {
		await fs.stat(manager.getHeader()?.cwd ?? manager.getCwd());
	} catch {
		throw new Error(`Cannot revive ${id}: persisted working directory is unavailable`);
	}
	return init;
}
