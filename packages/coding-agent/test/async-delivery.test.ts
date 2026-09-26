import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	ASYNC_PREVIEW_MAX_CHARS,
	ASYNC_PREVIEW_TAIL_CHARS,
	formatAsyncResultForFollowUp,
} from "@veyyon/coding-agent/async/async-delivery";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import type { OutputMeta } from "@veyyon/coding-agent/tools/core/output-meta";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import { useIsolatedGlobalSettings } from "./helpers/isolated-global-settings";
import { makeToolSession } from "./helpers/tool-session";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

useIsolatedGlobalSettings();
const makeTempDir = useTrackedTempDirs("async-delivery-test-");

describe("formatAsyncResultForFollowUp", () => {
	it("returns short results unchanged", async () => {
		const text = "Short result well within inline bounds";
		const formatted = await formatAsyncResultForFollowUp(text);
		expect(formatted).toBe(text);
	});

	it("allocates a new artifact when text is large and no raw capture artifactId exists", async () => {
		const largeText = "x".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 500);
		let allocated = false;
		const tempDir = makeTempDir();
		const artifactPath = path.join(tempDir, "async-fallback.txt");
		const allocator = {
			allocateArtifactPath: async (toolType: string) => {
				allocated = true;
				expect(toolType).toBe("async");
				return { path: artifactPath, id: "async-alloc-1" };
			},
		};

		const formatted = await formatAsyncResultForFollowUp(largeText, undefined, allocator);
		expect(allocated).toBe(true);
		expect(formatted).toContain("Full output: artifact://async-alloc-1");
		expect(formatted).toContain(`[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`);

		const written = await readFile(artifactPath, "utf-8");
		expect(written).toBe(largeText);
	});

	it("links directly to raw capture artifact when meta.truncation.artifactId exists", async () => {
		const largeText = "y".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 500);
		let allocated = false;
		const allocator = {
			allocateArtifactPath: async () => {
				allocated = true;
				return { path: "/tmp/not-used", id: "unused" };
			},
		};

		const meta: OutputMeta = {
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 100,
				totalBytes: largeText.length,
				outputLines: 20,
				outputBytes: ASYNC_PREVIEW_MAX_CHARS,
				artifactId: "raw-bash-capture-42",
			},
		};

		const formatted = await formatAsyncResultForFollowUp(largeText, meta, allocator);
		expect(allocated).toBe(false);
		expect(formatted).toContain("Full output: artifact://raw-bash-capture-42");
		expect(formatted).not.toContain("artifact://unused");
	});

	it("links directly to raw capture artifact when meta.limits.columnTruncated.artifactId exists", async () => {
		const largeText = "z".repeat(ASYNC_INLINE_RESULT_MAX_CHARS + 500);
		let allocated = false;
		const allocator = {
			allocateArtifactPath: async () => {
				allocated = true;
				return { path: "/tmp/not-used", id: "unused" };
			},
		};

		const meta: OutputMeta = {
			limits: {
				columnTruncated: {
					maxColumn: 512,
					artifactId: "raw-column-capture-99",
				},
			},
		};

		const formatted = await formatAsyncResultForFollowUp(largeText, meta, allocator);
		expect(allocated).toBe(false);
		expect(formatted).toContain("Full output: artifact://raw-column-capture-99");
	});

	it("preserves trailing exit notices in preview when linking raw capture", async () => {
		const prefix = "line\n".repeat(3_000); // ~15,000 chars
		const exitNotice = "Command exited with code 3";
		const largeText = `${prefix}\n${exitNotice}`;

		const meta: OutputMeta = {
			truncation: {
				direction: "middle",
				truncatedBy: "middle",
				totalLines: 3001,
				totalBytes: largeText.length,
				outputLines: 50,
				outputBytes: ASYNC_PREVIEW_MAX_CHARS,
				artifactId: "raw-exit-capture-7",
			},
		};

		const formatted = await formatAsyncResultForFollowUp(largeText, meta);
		expect(formatted).toContain("Full output: artifact://raw-exit-capture-7");
		expect(formatted).toContain(exitNotice);
	});
});

describe("BashTool background job raw artifact linking", () => {
	it("records raw artifact in job latestDetails and links follow-up to raw capture", async () => {
		const tempDir = makeTempDir();
		const idToPath = new Map<string, string>();
		let counter = 0;

		const manager = new AsyncJobManager({
			onJobComplete: () => {},
		});

		const session = makeToolSession({
			cwd: tempDir,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "test-session",
			allocateOutputArtifact: async (kind: string) => {
				counter += 1;
				const id = `${kind}-${counter}`;
				const filePath = path.join(tempDir, `${id}.txt`);
				idToPath.set(id, filePath);
				return { path: filePath, id };
			},
			asyncJobManager: manager,
			settings: {
				get(key: string) {
					if (key === "async.enabled") return true;
					if (key === "bash.autoBackground.enabled") return false;
					return undefined;
				},
			},
		});

		const tool = new BashTool(session);
		// Generate ~100KB of output past the inline budget and exit non-zero
		const result = await tool.execute(
			"call-1",
			{
				command: "seq 1 20000; exit 3",
				async: true,
			},
			undefined,
			() => {},
			{ toolCall: { id: "call-1", name: "bash", arguments: {} } },
		);

		const jobId = result.details?.async?.jobId;
		expect(jobId).toBeDefined();

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 5_000 });

		const job = manager.getJob(jobId!);
		expect(job).toBeDefined();
		expect(job?.status).toBe("failed");
		let rawArtifactId: string | undefined;
		let jobMeta: OutputMeta | undefined;
		const details = job?.latestDetails;
		if (details && typeof details === "object" && "meta" in details) {
			const candidate = details.meta;
			if (candidate && typeof candidate === "object") {
				jobMeta = candidate as OutputMeta;
				rawArtifactId = jobMeta.truncation?.artifactId;
			}
		}
		expect(rawArtifactId).toBeDefined();
		expect(idToPath.has(rawArtifactId!)).toBe(true);
		// Raw artifact file on disk contains full, un-elided output
		const rawCaptureOnDisk = await readFile(idToPath.get(rawArtifactId!)!, "utf-8");
		expect(rawCaptureOnDisk).toContain("1\n");
		expect(rawCaptureOnDisk).toContain("20000\n");
		expect(rawCaptureOnDisk).not.toContain("elided");

		// Format for follow-up
		const formatted = await formatAsyncResultForFollowUp(
			job?.errorText ?? "",
			jobMeta,
		);

		expect(formatted).toContain(`Full output: artifact://${rawArtifactId}`);
		expect(formatted).toContain("Command exited with code 3");
	});
});
