import type { ToolSession } from "../tools";

export type EvalSessionSource = Pick<ToolSession, "cwd" | "getSessionFile">;

/**
 * The eval session a session's cells run in: its session file, or its cwd when it has none.
 *
 * Every kernel applies the cwd of each cell when the cell runs, so a session with a file keeps its
 * one kernel and the variables in it when it changes directory. A cwd in that id started a new
 * kernel per directory and kept every earlier one alive until the session ended, at several hundred
 * megabytes each. A session without a file has no other identity: every such session in one cwd
 * shares a kernel, and a directory change moves it to the kernel of the new cwd.
 */
export function defaultEvalSessionId(session: EvalSessionSource): string {
	const sessionFile = session.getSessionFile?.() ?? undefined;
	return sessionFile ? `session:${sessionFile}` : `cwd:${session.cwd}`;
}
