import { describe, expect, it } from "bun:test";
import path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { OutputSink } from "@veyyon/coding-agent/session/streaming-output";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { useIsolatedGlobalSettings } from "../helpers/isolated-global-settings";
import { makeToolSession } from "../helpers/tool-session";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// WHY: OutputSink.dump() rejects when the artifact file cannot be stored (the settled
// contract), and the bash tool must still return the streamed output with the failure
// recorded in the result meta, never advertising an artifact it could not keep. A capped
// artifact is a head/tail sample, so the result must record how much the cap elided. The
// class closed here: every storage failure and every cap reaches the model-facing result
// truthfully. /dev/full is the real platform writer's ENOSPC path (Linux only, which is
// where the sandbox runs), so no fake writer stands in for the file system. Gap: a
// failure of the artifact directory allocation itself is not exercised here.

useIsolatedGlobalSettings();

const makeSpillDir = useTrackedTempDirs("failed-artifact-capture-");

function makeBashSession(cwd: string, artifact: { path: string; id: string }): ToolSession {
	return makeToolSession({
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "test-session",
		allocateOutputArtifact: async () => artifact,
		settings: {
			get(key: string) {
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				return key === "async.enabled" || key === "bash.autoBackground.enabled" ? false : undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	});
}

describe("a failed or capped artifact capture", () => {
	for (const artifactMaxBytes of [0, 32]) {
		it(`dump() rejects but dumpWithArtifactStatus() keeps the output when the file is full (cap ${artifactMaxBytes})`, async () => {
			const rejecting = new OutputSink({ artifactPath: "/dev/full", artifactId: "full-1", artifactMaxBytes });
			rejecting.push("x".repeat(100_000));
			await expect(rejecting.dump()).rejects.toThrow(/ENOSPC|No space left/);

			const tolerant = new OutputSink({ artifactPath: "/dev/full", artifactId: "full-2", artifactMaxBytes });
			tolerant.push("x".repeat(100_000));
			const summary = await tolerant.dumpWithArtifactStatus();
			expect(summary.artifactError).toMatch(/^(open|write|flush|end)$/);
			expect(summary.artifactId).toBeUndefined();
			expect(summary.output.length).toBeGreaterThan(0);
		});
	}

	it("still rejects with the preview error when the final preview flush throws", async () => {
		let calls = 0;
		const sink = new OutputSink({
			chunkThrottleMs: 60_000,
			onChunk: () => {
				calls += 1;
				if (calls > 1) throw new Error("preview-failed");
			},
		});
		sink.push("first\n");
		sink.push("held back by the throttle\n");
		await expect(sink.dumpWithArtifactStatus()).rejects.toThrow("preview-failed");
	});

	it("returns the bash output with the artifact error in meta and no artifact link when the capture cannot be stored", async () => {
		const session = makeBashSession(makeSpillDir(), { path: "/dev/full", id: "bash-full" });
		const tool = new BashTool(session);

		const result = await tool.execute("call-full", {
			command: "printf 'HEAD_MARK\\n'; yes PADPADPADPADPADPAD | head -c 200000; printf '\\nTAIL_MARK\\n'",
			timeout: 30,
		});
		const message = result.content.find(c => c.type === "text")?.text ?? "";

		expect(result.isError).toBeUndefined();
		expect(message).toContain("HEAD_MARK");
		expect(message).toContain("TAIL_MARK");
		expect(message).not.toContain("artifact://");
		expect(result.details?.meta?.artifactError).toMatch(/^(open|write|flush|end)$/);
		expect(result.details?.meta?.truncation?.artifactId).toBeUndefined();
	}, 20_000);

	it("records the bytes a capped artifact elided instead of presenting it as complete", async () => {
		const dir = makeSpillDir();
		const artifactPath = path.join(dir, "bash-capped.txt");
		const tool = new BashTool(makeBashSession(dir, { path: artifactPath, id: "bash-capped" }));
		const settings = await Settings.init();
		const previousCap = settings.get("tools.artifactMaxBytes");
		settings.set("tools.artifactMaxBytes", 1);
		try {
			const result = await tool.execute("call-capped", {
				command: "printf 'HEAD_MARK\\n'; yes PADPADPADPADPADPAD | head -c 4194304; printf '\\nTAIL_MARK\\n'",
				timeout: 60,
			});

			expect(result.details?.meta?.artifactError).toBeUndefined();
			expect(result.details?.meta?.truncation?.artifactId).toBe("bash-capped");
			expect(result.details?.meta?.truncation?.artifactElidedBytes).toBeGreaterThan(1024 * 1024);
		} finally {
			settings.set("tools.artifactMaxBytes", previousCap);
		}
	}, 60_000);
});
