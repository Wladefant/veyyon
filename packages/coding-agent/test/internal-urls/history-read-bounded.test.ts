/**
 * Regression suite: history:// bounded reading, scanner descent filtering,
 * and resolution deadline.
 *
 * Requirements covered:
 * 1. Artifact reservation directory skipping (.artifact-id-<digits>) vs normal nested directories.
 * 2. Unreadable or malformed files nested inside .artifact-id-* markers are never traversed.
 * 3. Fresh discovery: newly added files and normal nested dirs are still discovered.
 * 4. Nested dotted IDs (e.g. Parent.Child) and missing IDs with actionable diagnostic.
 * 5. Selector suffix and multi-target skill/history via real ReadTool.
 * 6. Hard 5-second deadline wrapping HistoryProtocolHandler.resolve with actionable error.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resetActiveSkillsForTests, setActiveSkills } from "@veyyon/coding-agent/extensibility/active-skills";
import { InternalUrlRouter, parseInternalUrl } from "@veyyon/coding-agent/internal-urls";
import { HistoryProtocolHandler } from "@veyyon/coding-agent/internal-urls/history-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
	sessionFilesFromDisk,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { CURRENT_SESSION_VERSION } from "@veyyon/kernel/session/session-entries";
import { removeWithRetries } from "@veyyon/utils";
import { toolResultText } from "../helpers/tool-result-text";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-read-bounded-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function sessionFixtureJsonl(message = "sample transcript"): string {
	const timestamp = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "sess-1",
		timestamp,
		cwd: "/tmp",
	};
	const userEntry = {
		type: "message",
		id: "msg-1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "question" },
	};
	const assistantEntry = {
		type: "message",
		id: "msg-2",
		parentId: "msg-1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: message }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

describe("history read bounded regressions", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
		resetActiveSkillsForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetActiveSkillsForTests();
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("does not traverse reserved .artifact-id-<digits> directories containing malformed or unreadable files, but discovers normal nested dirs and fresh files", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			registerArtifactsDir(artifactsDir);

			// 1. Reserved marker directory with malformed transcript that would cause parsing/read issues if traversed
			const reservedMarker1 = path.join(artifactsDir, ".artifact-id-0");
			const reservedMarker2 = path.join(artifactsDir, ".artifact-id-42");
			await fs.mkdir(reservedMarker1, { recursive: true });
			await fs.mkdir(reservedMarker2, { recursive: true });
			await fs.writeFile(path.join(reservedMarker1, "Corrupt.jsonl"), "NOT VALID JSONL DATA {{{");
			await fs.writeFile(path.join(reservedMarker2, "TrapAgent.jsonl"), "TRAP CONTENT");

			// 2. Normal nested directory
			const normalNestedDir = path.join(artifactsDir, "ParentAgent");
			await fs.mkdir(normalNestedDir, { recursive: true });
			await fs.writeFile(path.join(normalNestedDir, "ParentAgent.Child.jsonl"), sessionFixtureJsonl("hello from child"));

			// 3. Normal root transcript
			await fs.writeFile(path.join(artifactsDir, "TopAgent.jsonl"), sessionFixtureJsonl("hello from top"));

			// Scan disk
			const files = await sessionFilesFromDisk();

			// Assert reserved dirs are NOT traversed
			expect(files.has("Corrupt")).toBe(false);
			expect(files.has("TrapAgent")).toBe(false);

			// Assert normal nested and top-level dirs ARE discovered
			expect(files.has("TopAgent")).toBe(true);
			expect(files.has("ParentAgent.Child")).toBe(true);

			// Index should not contain TrapAgent or Corrupt
			const index = await InternalUrlRouter.instance().resolve("history://");
			expect(index.content).toContain("TopAgent");
			expect(index.content).toContain("ParentAgent.Child");
			expect(index.content).not.toContain("TrapAgent");
			expect(index.content).not.toContain("Corrupt");

			// 4. Fresh discovery: writing a new file dynamically remains visible immediately
			await fs.writeFile(path.join(artifactsDir, "FreshAgent.jsonl"), sessionFixtureJsonl("hello from fresh"));
			const updatedFiles = await sessionFilesFromDisk();
			expect(updatedFiles.has("FreshAgent")).toBe(true);
		});
	});

	it("resolves nested dotted IDs and reports missing IDs with actionable diagnostic", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			const nestedDir = path.join(artifactsDir, "Parent");
			await fs.mkdir(nestedDir, { recursive: true });
			await fs.writeFile(path.join(nestedDir, "Parent.Sub.Worker.jsonl"), sessionFixtureJsonl("deep nested worker"));
			registerArtifactsDir(artifactsDir);

			// Nested dotted ID resolves
			const resource = await InternalUrlRouter.instance().resolve("history://Parent.Sub.Worker");
			expect(resource.content).toContain("# Parent.Sub.Worker (on disk)");
			expect(resource.content).toContain("deep nested worker");

			// Missing ID throws actionable error listing known agents
			let error: Error | undefined;
			try {
				await InternalUrlRouter.instance().resolve("history://NoSuchAgent");
			} catch (e) {
				error = e as Error;
			}
			expect(error).toBeDefined();
			expect(error?.message).toContain("Unknown agent: NoSuchAgent");
			expect(error?.message).toContain("Known agents:");
		});
	});

	it("supports selector suffixes and multi-target skill/history via real ReadTool", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.writeFile(path.join(artifactsDir, "AgentAlpha.jsonl"), sessionFixtureJsonl("Alpha line content"));
			registerArtifactsDir(artifactsDir);

			const skillDir = path.join(dir, "skills", "demo");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Skill Title\nSkill instructions here\n");
			setActiveSkills([
				{
					name: "demo",
					description: "demo skill",
					filePath: path.join(skillDir, "SKILL.md"),
					baseDir: skillDir,
					source: "test",
				},
			]);

			const session: ToolSession = {
				cwd: dir,
				hasUI: false,
				getSessionFile: () => path.join(dir, "session.jsonl"),
				getSessionSpawns: () => "*",
				getArtifactsDir: () => artifactsDir,
				localProtocolOptions: {
					getArtifactsDir: () => artifactsDir,
					getSessionId: () => "test-sess",
				},
				settings: Settings.isolated({}),
			};
			const tool = new ReadTool(session);

			// 1. Selector suffix: history://AgentAlpha:1-2
			const selResult = await tool.execute("read-sel", { path: "history://AgentAlpha:1-2" });
			const selText = toolResultText(selResult);
			expect(selText).toContain("# AgentAlpha (on disk)");

			// 2. Multi-target skill and history: history://AgentAlpha:raw; skill://demo:raw
			const multiResult = await tool.execute("read-multi", { path: "history://AgentAlpha:raw; skill://demo:raw" });
			const multiText = toolResultText(multiResult);
			expect(multiText).toContain("# AgentAlpha (on disk)");
			expect(multiText).toContain("# Skill Title");
		});
	});

	it("aborts and throws actionable 5-second deadline error when resolution is blocked or slow", async () => {
		vi.useFakeTimers();

		const handler = new HistoryProtocolHandler();
		const url = parseInternalUrl("history://HangingAgent");

		const { promise: neverResolving, resolve: cleanupNeverResolving } = Promise.withResolvers<unknown>();
		// @ts-expect-error spyOn mockImplementation
		const readdirSpy = spyOn(fs, "readdir").mockImplementation(async () => neverResolving as never);

		try {
			const resolvePromise = handler.resolve(url);

			// Advance fake timer past 5000ms
			vi.advanceTimersByTime(5000);
			await Promise.resolve();

			let error: Error | undefined;
			try {
				await resolvePromise;
			} catch (e) {
				error = e as Error;
			}

			expect(error).toBeDefined();
			expect(error?.message).toContain("history:// timed out after 5s resolving 'history://HangingAgent'");
		} finally {
			cleanupNeverResolving([]);
			readdirSpy.mockRestore();
			vi.useRealTimers();
		}
	});
});
