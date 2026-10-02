import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeTerminalBreadcrumb } from "@veyyon/kernel/session/session-paths";
import { getAgentDir, getTerminalSessionsDir, setAgentDir, TempDir } from "@veyyon/utils";
import { getTerminalId } from "@veyyon/utils/ttyid";

describe("terminal breadcrumb write skipping", () => {
	it("leaves identical breadcrumb file unwritten when the same session is recorded again", () => {
		const agentDirObj = TempDir.createSync("@veyyon-agent-");
		const cwdObj = TempDir.createSync("@veyyon-cwd-");
		const agentDir = agentDirObj.path();
		const cwd = cwdObj.path();
		const originalAgentDir = getAgentDir();
		const originalTmuxPane = process.env.TMUX_PANE;
		process.env.TMUX_PANE = "%pointer-write-test";
		setAgentDir(agentDir);
		try {
			const terminalId = getTerminalId();
			if (!terminalId) throw new Error("Expected a terminal id for breadcrumb test");
			const sessionFile = path.join(cwd, "custom.jsonl");
			writeTerminalBreadcrumb(cwd, sessionFile);
			const crumb = path.join(getTerminalSessionsDir(agentDir), terminalId);
			expect(fs.existsSync(crumb)).toBe(true);

			const written = new Date(Date.now() - 60_000);
			fs.utimesSync(crumb, written, written);

			// Resume/re-adopt re-records the same pointer: no disk write.
			writeTerminalBreadcrumb(cwd, sessionFile);
			expect(fs.statSync(crumb).mtimeMs).toBe(written.getTime());

			// A changed pointer (fresh lazy boundary) still lands.
			writeTerminalBreadcrumb(cwd, sessionFile, true);
			expect(fs.readFileSync(crumb, "utf8").split("\n")).toContain("fresh");
		} finally {
			setAgentDir(originalAgentDir);
			if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
			else process.env.TMUX_PANE = originalTmuxPane;
			agentDirObj.removeSync();
			cwdObj.removeSync();
		}
	});
});
