import { describe, expect, test } from "bun:test";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import { toExecutorBackendResult } from "@veyyon/coding-agent/eval/backend-helpers";
import { buildAsyncResultBatchMessage } from "@veyyon/coding-agent/session/factory-notices";
import type { OutputSummary } from "@veyyon/coding-agent/session/streaming-output";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import {
	formatArtifactErrorNotice,
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
			getNumber: (key: string) => (key === "tools.artifactMaxBytes" ? 32 : undefined),
		} as unknown as Settings;
		expect(resolveOutputSinkArtifactMaxBytes(fakeSettingsWithVal)).toBe(32 * 1024 * 1024);

		const fakeSettingsUnlimited = {
			getNumber: (key: string) => (key === "tools.artifactMaxBytes" ? 0 : undefined),
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
});
