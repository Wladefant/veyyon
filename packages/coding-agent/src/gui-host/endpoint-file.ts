/**
 * Where a running GUI host states the endpoint it bound, for clients that were
 * not handed it.
 *
 * The desktop client knows the endpoint because it either passed one or applies
 * `socket-path.ts`'s rule to derive the default socket. A client that is neither —
 * the standalone Telegram bot daemon is the case this exists for — has no way to
 * learn a `tcp:` endpoint at all, and on Windows `tcp:` is the ONLY option, since
 * a Windows AF_UNIX listen through libuv needs a `\\.\pipe\` name rather than the
 * filesystem path `guiHostSocketPath` returns. Printing the endpoint on stdout,
 * which is all the `gui` command used to do, reaches a human reading a terminal
 * and nothing else.
 *
 * So the host writes it down: one line, the same string `GuiHostServer.endpoint`
 * reports, in the active profile's agent directory. A reader finds the file where
 * it finds every other per-profile artefact, and two profiles never collide.
 *
 * The file is removed on a clean shutdown. A crash leaves it behind, and that is
 * survivable rather than silent: the endpoint in a stale file refuses the
 * connection, which a client reports, and the next host start overwrites it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@veyyon/utils";

/** Filename inside an agent profile directory. The mirror of `SOCKET_FILENAME`. */
export const ENDPOINT_FILENAME = "gui-host.endpoint";

/** Absolute path of the endpoint file for `agentDir`. */
export function guiHostEndpointPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, ENDPOINT_FILENAME);
}

/**
 * Record `endpoint` as this machine's GUI host endpoint.
 *
 * @returns the path written.
 */
export function publishGuiHostEndpoint(endpoint: string, agentDir: string = getAgentDir()): string {
	const target = guiHostEndpointPath(agentDir);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${endpoint}\n`, "utf8");
	return target;
}

/**
 * Remove the endpoint file, but only when it still names `endpoint`.
 *
 * A second host that took over the file owns it now, and a shutting-down
 * predecessor deleting it would leave the live host undiscoverable.
 */
export function withdrawGuiHostEndpoint(endpoint: string, agentDir: string = getAgentDir()): boolean {
	const target = guiHostEndpointPath(agentDir);
	try {
		if (fs.readFileSync(target, "utf8").trim() !== endpoint.trim()) {
			return false;
		}
		fs.rmSync(target, { force: true });
		return true;
	} catch {
		return false;
	}
}
