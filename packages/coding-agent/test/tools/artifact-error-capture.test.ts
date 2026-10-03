import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { PtySession } from "@veyyon/natives";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionTerminalCapability } from "@veyyon/coding-agent/extensibility/terminal-capability";
import { runInteractiveBashPty } from "@veyyon/coding-agent/tools/shell/bash-interactive";
import { formatAsyncResultForFollowUp } from "@veyyon/coding-agent/async/async-delivery";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { describeSettingTypeMismatch } from "@veyyon/coding-agent/config/settings-schema";
import { toExecutorBackendResult } from "@veyyon/coding-agent/eval/backend-helpers";
import { buildAsyncResultBatchMessage } from "@veyyon/coding-agent/session/factory-notices";
import type { OutputSummary } from "@veyyon/coding-agent/session/streaming-output";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import {
	formatArtifactErrorNotice,
	formatArtifactReference,
	formatColumnTruncatedNotice,
	formatOutputNotice,
	formatStyledTruncationWarning,
	formatTruncationMetaNotice,
	type OutputMeta,
	outputMeta,
	resolveOutputSinkArtifactMaxBytes,
	stripOutputNotice,
	type TruncationMeta,
} from "@veyyon/coding-agent/tools/core/output-meta";
import { JobTool } from "@veyyon/coding-agent/tools/shell/job";
import { jobToolView } from "@veyyon/coding-agent/tools/shell/job-view";
import { makeToolSession } from "../helpers/tool-session";


const mockTerminal: ExtensionTerminalCapability = {
	custom: async (factory) => {
		const tui = {
			terminal: { rows: 24, columns: 80 },
			pinnedFooterRows: 0,
			requestRender: () => {},
		};
		const { promise, resolve } = Promise.withResolvers<never>();
		factory(tui as never, {} as never, {} as never, resolve);
		return promise;
	},
	setEditorComponent: () => () => {},
	setWidgetComponent: () => () => {},
};

describe("artifact error capture mechanics", () => {
	test("formatArtifactErrorNotice formats every error variant", () => {
		expect(formatArtifactErrorNotice("open")).toBe("Full output was not saved completely (artifact open failed)");
		expect(formatArtifactErrorNotice("write")).toBe("Full output was not saved completely (artifact write failed)");
		expect(formatArtifactErrorNotice("flush")).toBe("Full output was not saved completely (artifact flush failed)");
		expect(formatArtifactErrorNotice("end")).toBe("Full output was not saved completely (artifact end failed)");
	});

	test("formatOutputNotice appends artifact error notice", () => {
		const meta: OutputMeta = {
			artifactError: "write",
		};
		const notice = formatOutputNotice(meta);
		expect(notice).toContain("Full output was not saved completely (artifact write failed)");
	});

	test("stripOutputNotice strips artifact error notice", () => {
		const meta: OutputMeta = {
			artifactError: "open",
		};
		const raw = "command output\n\n[Full output was not saved completely (artifact open failed)]";
		const stripped = stripOutputNotice(raw, meta);
		expect(stripped).toBe("command output");
	});

	test("formatTruncationMetaNotice formats report reference when source is report", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			truncatedBy: "lines",
			totalLines: 100,
			totalBytes: 5000,
			outputLines: 20,
			outputBytes: 1000,
			shownRange: { start: 81, end: 100 },
			artifactId: "art-123",
		};
		const notice = formatTruncationMetaNotice(truncation, {
			type: "report",
			value: "background job delivery",
		});
		expect(notice).toContain("Read artifact://art-123 for full report (background job delivery)");
	});

	test("formatColumnTruncatedNotice formats report reference when source is report", () => {
		const meta: OutputMeta = {
			limits: {
				columnTruncated: {
					maxColumn: 80,
					unit: "chars",
					artifactId: "art-col",
				},
			},
			source: {
				type: "report",
				value: "background jobs snapshot",
			},
		};
		const notice = formatColumnTruncatedNotice(meta);
		expect(notice).toContain("Read artifact://art-col for full report (background jobs snapshot)");
	});

	test("truncationFromSummary captures artifactError and suppresses artifactId", () => {
		const summary: OutputSummary = {
			output: "some tail output",
			truncated: true,
			totalLines: 50,
			totalBytes: 2000,
			outputLines: 10,
			outputBytes: 400,
			artifactId: "should-be-suppressed",
			artifactError: "write",
		};

		const meta = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get()!;

		expect(meta.artifactError).toBe("write");
		expect(meta.truncation?.artifactId).toBeUndefined();
	});

	test("formatStyledTruncationWarning includes artifact error notice", () => {
		const fakeTheme = {
			fg: (_color: string, text: string) => text,
			format: { bracketLeft: "[", bracketRight: "]" },
		} as unknown as Theme;

		const meta: OutputMeta = {
			artifactError: "flush",
		};

		const warning = formatStyledTruncationWarning(meta, fakeTheme);
		expect(warning).toContain("Full output was not saved completely (artifact flush failed)");
	});

	test("resolveOutputSinkArtifactMaxBytes resolves MB to bytes or 0", () => {
		const fakeSettingsWithVal = {
			get: (key: string) => (key === "tools.artifactMaxBytes" ? 32 : undefined),
		} as unknown as Settings;
		expect(resolveOutputSinkArtifactMaxBytes(fakeSettingsWithVal)).toBe(32 * 1024 * 1024);

		const fakeSettingsUnlimited = {
			get: (key: string) => (key === "tools.artifactMaxBytes" ? 0 : undefined),
		} as unknown as Settings;
		expect(resolveOutputSinkArtifactMaxBytes(fakeSettingsUnlimited)).toBe(0);

		// Default setting
		expect(resolveOutputSinkArtifactMaxBytes(undefined)).toBe(16 * 1024 * 1024);
	});

	test("toExecutorBackendResult forwards artifactError and artifactElidedBytes", () => {
		const backendRes = toExecutorBackendResult({
			output: "out",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			artifactId: undefined,
			artifactElidedBytes: 12345,
			artifactError: "end",
			totalLines: 10,
			totalBytes: 500,
			outputLines: 5,
			outputBytes: 250,
			displayOutputs: [],
		});

		expect(backendRes.artifactError).toBe("end");
		expect(backendRes.artifactElidedBytes).toBe(12345);
	});

	test("buildAsyncResultBatchMessage propagates job meta and attaches report source", () => {
		const msg = buildAsyncResultBatchMessage([
			{
				jobId: "job-1",
				result: "hello job",
				durationMs: 150,
				job: {
					type: "bash",
					label: "test bash job",
					latestDetails: {
						meta: {
							artifactError: "open",
						},
					},
				} as any,
			},
		]);

		expect(msg).not.toBeNull();
		expect(msg!.details.jobs[0].meta?.artifactError).toBe("open");
		expect(msg!.details.meta?.source).toEqual({
			type: "report",
			value: "background job delivery",
		});
	});

	test("formatArtifactReference returns reference without full output when capped", () => {
		expect(formatArtifactReference("art-1", false)).toBe("Read artifact://art-1 for full output");
		expect(formatArtifactReference("art-1", true)).toBe("Read artifact://art-1");
	});

	test("formatTruncationMetaNotice renders no full-output claim when artifactElidedBytes > 0", () => {
		const truncation: TruncationMeta = {
			direction: "tail",
			truncatedBy: "lines",
			totalLines: 100,
			totalBytes: 5000,
			outputLines: 20,
			outputBytes: 1000,
			shownRange: { start: 81, end: 100 },
			artifactId: "art-capped",
			artifactElidedBytes: 500,
		};
		const notice = formatTruncationMetaNotice(truncation);
		expect(notice).toContain("Read artifact://art-capped");
		expect(notice).not.toContain("full output");
	});

	test("formatTruncationMetaNotice renders report reference without full when artifactElidedBytes > 0", () => {
		const truncation: TruncationMeta = {
			direction: "middle",
			truncatedBy: "middle",
			totalLines: 100,
			totalBytes: 5000,
			outputLines: 20,
			outputBytes: 1000,
			artifactId: "art-capped-rep",
			artifactElidedBytes: 200,
		};
		const notice = formatTruncationMetaNotice(truncation, {
			type: "report",
			value: "test report",
		});
		expect(notice).toContain("Read artifact://art-capped-rep for report (test report)");
		expect(notice).not.toContain("full report");
	});

	test("formatColumnTruncatedNotice renders no full-output claim when artifactElidedBytes > 0", () => {
		const meta: OutputMeta = {
			artifactElidedBytes: 1000,
			limits: {
				columnTruncated: {
					maxColumn: 80,
					unit: "bytes",
					artifactId: "art-col-capped",
				},
			},
		};
		const notice = formatColumnTruncatedNotice(meta);
		expect(notice).toContain("Read artifact://art-col-capped");
		expect(notice).not.toContain("full output");
	});

	test("truncationFromSummary captures artifactElidedBytes even when summary is not window-truncated", () => {
		const summary: OutputSummary = {
			output: "short output",
			truncated: false,
			totalLines: 5,
			totalBytes: 100,
			outputLines: 5,
			outputBytes: 100,
			columnMax: 50,
			columnTruncatedLines: 2,
			artifactId: "art-col-only",
			artifactElidedBytes: 250,
		};

		const meta = outputMeta().truncationFromSummary(summary, { direction: "head" }).get()!;
		expect(meta.artifactElidedBytes).toBe(250);
		expect(meta.limits?.columnTruncated?.artifactId).toBe("art-col-only");

		const notice = formatColumnTruncatedNotice(meta);
		expect(notice).toContain("Read artifact://art-col-only");
		expect(notice).not.toContain("full output");
	});

	test("formatAsyncResultForFollowUp renders Output instead of Full output when artifact is capped", async () => {
		const meta: OutputMeta = {
			artifactElidedBytes: 5000,
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 100,
				totalBytes: 20_000,
				outputLines: 10,
				outputBytes: 2000,
				artifactId: "art-async-capped",
				artifactElidedBytes: 5000,
			},
		};
		const text = "x".repeat(15_000);
		const formatted = await formatAsyncResultForFollowUp(text, meta);
		expect(formatted).toContain("Output: artifact://art-async-capped");
		expect(formatted).not.toContain("Full output:");
	});

	test("formatAsyncResultForFollowUp preserves artifact error notice even on short results", async () => {
		const meta: OutputMeta = {
			artifactError: "open",
		};
		const shortText = "Short output 123";
		const formatted = await formatAsyncResultForFollowUp(shortText, meta);
		expect(formatted).toContain("Short output 123");
		expect(formatted).toContain("[Full output was not saved completely (artifact open failed)]");
	});

	test("formatAsyncResultForFollowUp preserves once-only warning without duplicate when short result has notice", async () => {
		const meta: OutputMeta = {
			artifactError: "write",
		};
		const shortText = "Command output\n\n[Full output was not saved completely (artifact write failed)]";
		const formatted = await formatAsyncResultForFollowUp(shortText, meta);
		const matches = formatted.match(/artifact write failed/g);
		expect(matches?.length).toBe(1);
	});

	test("resolveOutputSinkArtifactMaxBytes rejects negative cap with RangeError", () => {
		const fakeSettingsNegative = {
			get: (key: string) => (key === "tools.artifactMaxBytes" ? -5 : undefined),
		} as unknown as Settings;
		expect(() => resolveOutputSinkArtifactMaxBytes(fakeSettingsNegative)).toThrow(RangeError);
	});

	test("describeSettingTypeMismatch rejects negative tools.artifactMaxBytes and accepts 0", () => {
		expect(describeSettingTypeMismatch("tools.artifactMaxBytes", -1)).toContain("expected a number >= 0");
		expect(describeSettingTypeMismatch("tools.artifactMaxBytes", 0)).toBeUndefined();
		expect(describeSettingTypeMismatch("tools.artifactMaxBytes", 16)).toBeUndefined();
	});

	test("describeSettingTypeMismatch preserves UNSET_NUMBER on isUnsetNumberPath", () => {
		expect(describeSettingTypeMismatch("temperature", -1)).toBeUndefined();
		expect(describeSettingTypeMismatch("compaction.modelContextWindow", -1)).toBeUndefined();
		expect(describeSettingTypeMismatch("tools.artifactMaxBytes", -1)).toContain("expected a number >= 0");
	});

	test("jobToolView renders warning line when completed job has artifactError", () => {
		const view = jobToolView.renderResult(
			{
				content: [{ type: "text", text: "## Completed (1)\n\n### j-1 [bash] — completed\nLabel: my job\n" }],
				details: {
					jobs: [
						{
							id: "j-1",
							type: "bash",
							status: "completed",
							label: "my job",
							durationMs: 1000,
							meta: { artifactError: "flush" },
						},
					],
				},
			},
			{ expanded: false },
		);

		expect(view.kind).toBe("headedBlock");
		if (view.kind === "headedBlock") {
			const warningRow = view.lines.find(row =>
				row.some(span => span.text.includes("artifact flush failed")),
			);
			expect(warningRow).toBeDefined();
			expect(warningRow?.some(span => span.tone === "warning")).toBe(true);
		}
	});

	test("JobTool list renders artifact error notice for completed jobs with artifactError", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const session = makeToolSession({
			cwd: process.cwd(),
			hasUI: false,
			settings: { get: () => undefined },
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			asyncJobManager: manager,
		});
		const tool = new JobTool(session);

		const { promise: neverResolves } = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"artifact error bash job",
			() => neverResolves,
			{ id: "job-art-err" },
		);
		const job = manager.getJob("job-art-err")!;
		job.status = "completed";
		job.resultText = "finished work";
		job.latestDetails = {
			meta: {
				artifactError: "end",
			},
		};

		const res = await tool.execute("call-1", { list: true });
		const text = res.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("[Full output was not saved completely (artifact end failed)]");
	});

	test("JobTool list avoids duplicating artifact error notice when already in resultText", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const session = makeToolSession({
			cwd: process.cwd(),
			hasUI: false,
			settings: { get: () => undefined },
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			asyncJobManager: manager,
		});
		const tool = new JobTool(session);

		const alreadyNoticed = "finished work\n\n[Full output was not saved completely (artifact open failed)]";
		const { promise: neverResolves } = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"dedup bash job",
			() => neverResolves,
			{ id: "job-art-dedup" },
		);
		const job = manager.getJob("job-art-dedup")!;
		job.status = "completed";
		job.resultText = alreadyNoticed;
		job.latestDetails = {
			meta: {
				artifactError: "open",
			},
		};

		const res = await tool.execute("call-2", { list: true });
		const text = res.content.find(part => part.type === "text")?.text ?? "";
		const matches = text.match(/artifact open failed/g);
		expect(matches?.length).toBe(1);
	});

	test("JobTool poll renders artifact error notice for completed jobs with artifactError", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const session = makeToolSession({
			cwd: process.cwd(),
			hasUI: false,
			settings: { get: () => undefined },
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			asyncJobManager: manager,
		});
		const tool = new JobTool(session);

		const { promise: neverResolves } = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"poll artifact error job",
			() => neverResolves,
			{ id: "job-poll-art-err" },
		);
		const job = manager.getJob("job-poll-art-err")!;
		job.status = "completed";
		job.resultText = "poll finished work";
		job.latestDetails = {
			meta: {
				artifactError: "write",
			},
		};

		const res = await tool.execute("call-poll-1", { poll: ["job-poll-art-err"] });
		const text = res.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain("[Full output was not saved completely (artifact write failed)]");
	});

	test("runInteractiveBashPty enforces small nondefault artifactMaxBytes cap", async () => {
		const settings = await Settings.init();
		settings.set("tools.artifactMaxBytes", 1); // 1 MB cap

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-cap-"));
		const artifactPath = path.join(tmpDir, "sample.artifact");

		// Emit 1.2 MB (20 chunks of 60 KB)
		const chunk = "B".repeat(60_000) + "\n";
		const ptySpy = spyOn(PtySession.prototype, "start").mockImplementation(
			async (_opts, onChunk) => {
				if (onChunk) {
					for (let i = 0; i < 20; i++) {
						onChunk(null, chunk);
					}
				}
				return {
					exitCode: 0,
					cancelled: false,
					timedOut: false,
				};
			},
		);

		try {
			const res = await runInteractiveBashPty(mockTerminal, {
				command: "echo test",
				cwd: tmpDir,
				artifactPath,
				artifactId: "art-pty-1",
			});

			expect(res.artifactElidedBytes).toBeGreaterThan(0);
			expect(fs.existsSync(artifactPath)).toBe(true);
			const content = fs.readFileSync(artifactPath, "utf-8");
			expect(content).toContain("[ARTIFACT TRUNCATED");
			expect(fs.statSync(artifactPath).size).toBeLessThan(1_200_000);
		} finally {
			ptySpy.mockRestore();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("runInteractiveBashPty respects 0 artifactMaxBytes as unlimited", async () => {
		const settings = await Settings.init();
		settings.set("tools.artifactMaxBytes", 0); // 0 = unlimited

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-unlimited-"));
		const artifactPath = path.join(tmpDir, "unlimited.artifact");

		// Emit 1.2 MB
		const chunk = "C".repeat(60_000) + "\n";
		const ptySpy = spyOn(PtySession.prototype, "start").mockImplementation(
			async (_opts, onChunk) => {
				if (onChunk) {
					for (let i = 0; i < 20; i++) {
						onChunk(null, chunk);
					}
				}
				return {
					exitCode: 0,
					cancelled: false,
					timedOut: false,
				};
			},
		);

		try {
			const res = await runInteractiveBashPty(mockTerminal, {
				command: "echo test",
				cwd: tmpDir,
				artifactPath,
				artifactId: "art-pty-0",
			});

			expect(res.artifactElidedBytes).toBeUndefined();
			expect(fs.existsSync(artifactPath)).toBe(true);
			const content = fs.readFileSync(artifactPath, "utf-8");
			expect(content).not.toContain("[ARTIFACT TRUNCATED");
			expect(fs.statSync(artifactPath).size).toBeGreaterThanOrEqual(1_200_000);
		} finally {
			ptySpy.mockRestore();
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
