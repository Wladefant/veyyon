import { expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeVmContextsByOwner } from "@veyyon/coding-agent/eval/js/context-manager";
import { executeJs } from "@veyyon/coding-agent/eval/js/executor";
import { callSessionTool, type JsStatusEvent } from "@veyyon/coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const BLOCKED = "[credential output withheld]";
const COMMAND = "ALPHA=fixture-a\nBETA=fixture-b\nGAMMA=fixture-c\n:";
const PREVIEW = `${"safe preview ".repeat(45)}\nVALUE=fixture-after-limit`;

function makeSession(cwd: string): ToolSession {
	const bash = {
		name: "bash",
		parameters: type({ command: "string" }),
		execute: async () => ({ content: [{ type: "text", text: PREVIEW }], details: { exitCode: 0 } }),
	} as AgentTool;
	const search = {
		name: "search",
		parameters: type({ input: "string", path: "string" }),
		execute: async () => ({
			content: [{ type: "text", text: "one match" }],
			details: { result: { matchCount: 1, files: [{ path: "sample.txt", lines: ["VALUE=fixture-match", 7] }] } },
		}),
	} as AgentTool;
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getToolByName: name => (name === "bash" ? bash : name === "search" ? search : undefined),
	};
}

it("sanitizes command and full output before the bridge publishes status", async () => {
	using dir = TempDir.createSync("@veyyon-eval-status-");
	const events: JsStatusEvent[] = [];
	await callSessionTool(
		"bash",
		{ command: COMMAND },
		{
			session: makeSession(dir.path()),
			emitStatus: event => events.push(event),
		},
	);
	expect(events).toEqual([{ op: "run", cmd: BLOCKED, code: 0, output: BLOCKED }]);
});

it("shares sanitized nested tool status between the live callback and retained displays", async () => {
	using dir = TempDir.createSync("@veyyon-eval-status-");
	const id = crypto.randomUUID();
	const events: JsStatusEvent[] = [];
	try {
		const result = await executeJs(
			'await tool.search({ input: "sample", path: "." }); env("VALUE=fixture-key", "ignored"); void 0;',
			{
				sessionId: id,
				kernelOwnerId: id,
				session: makeSession(dir.path()),
				onStatus: event => events.push(event),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(events).toEqual([
			{
				op: "search",
				pattern: "sample",
				path: ".",
				count: 1,
				matches: [{ path: "sample.txt", lines: [BLOCKED, 7] }],
			},
			{ op: "env", key: BLOCKED, value: "<redacted>", action: "set" },
		]);
		const statuses = result.displayOutputs.filter(output => output.type === "status");
		expect(statuses).toHaveLength(2);
		expect(statuses[0]?.event).toBe(events[0]);
		expect(statuses[1]?.event).toBe(events[1]);
	} finally {
		await disposeVmContextsByOwner(id);
	}
});
