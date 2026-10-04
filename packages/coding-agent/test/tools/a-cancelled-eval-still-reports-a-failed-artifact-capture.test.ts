import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { formatArtifactErrorNotice } from "@veyyon/coding-agent/tools/core/output-meta";
import { ToolAbortError } from "@veyyon/coding-agent/tools/core/tool-errors";
import { EvalTool } from "@veyyon/coding-agent/tools/shell/eval";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";

// WHY: a cancelled eval throws ToolAbortError, and that path used to await the sink and discard
// the artifact failure it reported, so a cancelled cell whose full output could not be saved said
// nothing about it while the completed path warned. The class closed here: every way an eval call
// ends (completed, cancelled) tells the model the saved output is incomplete, and a cancellation
// stays a ToolAbortError carrying that warning. /dev/full is the real platform ENOSPC writer
// (Linux only, which is where the sandbox runs). Gap: the idle-timeout path returns a normal
// error result and is covered by the completed-path assertion, not separately.

useIsolatedGlobalSettings();

function makeSession(artifactPath: string): ToolSession {
	return makeToolSession({
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async () => ({ path: artifactPath, id: "eval-full" }),
		settings: Settings.isolated(),
	});
}

describe("eval with an artifact that cannot be saved", () => {
	afterAll(async () => {
		await disposeAllVmContexts();
	});

	it("a cancelled cell stays a ToolAbortError and its message carries the capture warning", async () => {
		const tool = new EvalTool(makeSession("/dev/full"));
		const controller = new AbortController();
		const updated = Promise.withResolvers<void>();
		const running = tool.execute(
			"call-cancel-full",
			{ language: "js", code: "print('x'.repeat(120000)); await Bun.sleep(30000);", timeout: 0 },
			controller.signal,
			update => {
				// Abort only once the streamed output has reached the caller, so the sink holds bytes.
				if (update.content.some(block => block.type === "text" && block.text.includes("xxxx"))) updated.resolve();
			},
		);
		await updated.promise;
		controller.abort();

		const err = (await running.catch(e => e)) as Error;
		expect(err).toBeInstanceOf(ToolAbortError);
		expect(err.message).toContain("Eval cancelled");
		expect(err.message).toMatch(
			new RegExp(
				`${formatArtifactErrorNotice("write")
					.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
					.replace("write", "(open|write|flush|end)")}`,
			),
		);
	}, 30_000);

	it("a completed cell reports the same warning in its result meta", async () => {
		const tool = new EvalTool(makeSession("/dev/full"));
		const result = await tool.execute("call-complete-full", {
			language: "js",
			code: "print('x'.repeat(120000));",
			timeout: 30,
		});
		expect(result.details?.meta?.artifactError).toMatch(/^(open|write|flush|end)$/);
	}, 30_000);
});
