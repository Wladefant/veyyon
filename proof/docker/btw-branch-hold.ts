/**
 * Holds a session branch open for proof/scenes/btw-branch-guards.sh.
 *
 * Promoting a /btw answer into the chat runs the `session_before_branch` hook before
 * the new session is written. With no extension that takes a few milliseconds, and
 * the panel's in-flight state is never on the glass long enough to photograph. An
 * extension that answers slowly is a real path -- the git-checkpoint example asks
 * the user a question here -- so this one waits BTW_BRANCH_HOLD_MS and lets the
 * branch continue. It cancels nothing and changes nothing the branch writes.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { ExtensionAPI } from "@veyyon/coding-agent";

const HOLD_MS = Number(process.env.BTW_BRANCH_HOLD_MS ?? 10_000);

export default function (pi: ExtensionAPI) {
	pi.on("session_before_branch", async () => {
		await sleep(HOLD_MS);
	});
}
