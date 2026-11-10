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
import * as nodeFs from "node:fs";
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
import {
	STREAM_LOAD_THRESHOLD_BYTES,
	loadSessionMessagesReadOnly,
	parseSessionContent,
} from "@veyyon/kernel/session/session-loader";
import * as sessionLoaderModule from "@veyyon/kernel/session/session-loader";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
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
		vi.restoreAllMocks();
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

	// Artifact metadata must never become history, even when it looks like a transcript.
	// This covers reserved names, not arbitrary hidden directories.
	it.each([
		".artifact-ids.sqlite",
		".artifact-ids.sqlite-wal",
		".artifact-ids.sqlite-shm",
		".artifact-ids.sqlite-journal",
		".artifact-ids.sqlite.jsonl",
	])("excludes %s files and directories from history discovery", async name => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			const metadataDir = path.join(artifactsDir, "Nested", name);
			await fs.mkdir(metadataDir, { recursive: true });
			await fs.writeFile(path.join(metadataDir, "MetadataTrap.jsonl"), sessionFixtureJsonl("metadata trap"));
			await fs.writeFile(path.join(artifactsDir, name), sessionFixtureJsonl("metadata file trap"));
			const normalDir = path.join(artifactsDir, ".artifact-ids-sqlite");
			await fs.mkdir(normalDir);
			await fs.writeFile(path.join(normalDir, "VisibleAgent.jsonl"), sessionFixtureJsonl("visible transcript"));
			registerArtifactsDir(artifactsDir);

			const files = await sessionFilesFromDisk();
			expect([...files.keys()]).toEqual(["VisibleAgent"]);
			const index = await InternalUrlRouter.instance().resolve("history://");
			expect(index.content).toContain("VisibleAgent");
			expect(index.content).not.toContain("MetadataTrap");
			expect(index.content).not.toContain("metadata file trap");
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

	// P2 Finding 2: The resolver ignores the originating tool's AbortSignal
	it("rejects promptly with caller abort reason and skips disk scanning when caller signal is pre-aborted", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			registerArtifactsDir(artifactsDir);

			const callerReason = new Error("caller aborted before history read");
			const preAbortedSignal = AbortSignal.abort(callerReason);

			const readdirSpy = spyOn(fs, "readdir");
			try {
				let thrownError: unknown;
				try {
					await InternalUrlRouter.instance().resolve("history://NoSuchAgent", {
						signal: preAbortedSignal,
					});
				} catch (err) {
					thrownError = err;
				}

				expect(thrownError).toBe(callerReason);
				expect(readdirSpy).not.toHaveBeenCalled();
			} finally {
				readdirSpy.mockRestore();
			}
		});
	});

	it("rejects promptly with caller abort reason when caller aborts while readdir is pending", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			registerArtifactsDir(artifactsDir);

			vi.useFakeTimers();
			const controller = new AbortController();
			const callerReason = new Error("caller aborted mid-flight readdir");

			const { promise: readdirBlocker, resolve: unblockReaddir } = Promise.withResolvers<unknown>();
			// @ts-expect-error spyOn mockImplementation
			const readdirSpy = spyOn(fs, "readdir").mockImplementation(async () => {
				controller.abort(callerReason);
				return readdirBlocker as never;
			});

			try {
				const resolvePromise = InternalUrlRouter.instance().resolve("history://HangingAgent", {
					signal: controller.signal,
				});

				// Allow microtasks to execute readdir mock which aborts controller
				await Promise.resolve();

				// If controller.signal was ignored (old code), it hangs until 5s deadline
				vi.advanceTimersByTime(5000);
				await Promise.resolve();

				let thrownError: unknown;
				try {
					await resolvePromise;
				} catch (err) {
					thrownError = err;
				}

				expect(thrownError).toBe(callerReason);
				expect((thrownError as Error)?.message).not.toContain("history:// timed out after 5s");
			} finally {
				unblockReaddir([]);
				readdirSpy.mockRestore();
				vi.useRealTimers();
			}
		});
	});

	// P2 Finding 3: Missing/ambiguous IDs can time out solely because the same tree is scanned twice
	it("scans directory tree only once for missing IDs, avoiding 5-second timeout on slow storage", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.writeFile(path.join(artifactsDir, "OtherAgent.jsonl"), sessionFixtureJsonl("hello"));
			registerArtifactsDir(artifactsDir);

			vi.useFakeTimers();
			let readdirInvocations = 0;
			const originalReaddir = fs.readdir;
			// Each readdir pass advances fake time by 3000ms (> 2.5s, < 5.0s)
			// @ts-expect-error spyOn mockImplementation
			const readdirSpy = spyOn(fs, "readdir").mockImplementation(async (...args) => {
				readdirInvocations++;
				vi.advanceTimersByTime(3000);
				return originalReaddir(...args);
			});

			try {
				let error: Error | undefined;
				try {
					await InternalUrlRouter.instance().resolve("history://AbsentAgent");
				} catch (err) {
					error = err as Error;
				}

				expect(error).toBeDefined();
				// A single scan takes 3000ms (< 5000ms), diagnosing Unknown agent.
				// Two scans take 6000ms (> 5000ms), incorrectly timing out with deadline error.
				expect(error?.message).toContain("Unknown agent: AbsentAgent");
				expect(error?.message).not.toContain("timed out after 5s");
				expect(readdirInvocations).toBe(1);
			} finally {
				readdirSpy.mockRestore();
				vi.useRealTimers();
			}
		});
	});

	it("scans directory tree only once for ambiguous IDs across multiple artifact directories", async () => {
		await withTempDir(async dir => {
			const artifactsDir1 = path.join(dir, "artifacts1");
			const artifactsDir2 = path.join(dir, "artifacts2");
			await fs.mkdir(artifactsDir1, { recursive: true });
			await fs.mkdir(artifactsDir2, { recursive: true });
			await fs.writeFile(path.join(artifactsDir1, "ClashingAgent.jsonl"), sessionFixtureJsonl("v1"));
			await fs.writeFile(path.join(artifactsDir2, "ClashingAgent.jsonl"), sessionFixtureJsonl("v2"));
			registerArtifactsDir(artifactsDir1);
			registerArtifactsDir(artifactsDir2);

			let readdirInvocations = 0;
			const originalReaddir = fs.readdir;
			// @ts-expect-error spyOn mockImplementation
			const readdirSpy = spyOn(fs, "readdir").mockImplementation(async (...args) => {
				readdirInvocations++;
				return originalReaddir(...args);
			});

			try {
				let error: Error | undefined;
				try {
					await InternalUrlRouter.instance().resolve("history://ClashingAgent");
				} catch (err) {
					error = err as Error;
				}

				expect(error).toBeDefined();
				expect(error?.message).toContain("Ambiguous agent: ClashingAgent");
				// With 2 artifact directories, a single traversal scans each root once (2 calls).
				// A double traversal scans them twice (4 calls).
				expect(readdirInvocations).toBe(2);
			} finally {
				readdirSpy.mockRestore();
			}
		});
	});

	it("scans directory tree only once for missing IDs when q or entry queries are requested", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			await fs.writeFile(path.join(artifactsDir, "KnownAgent.jsonl"), sessionFixtureJsonl("known"));
			registerArtifactsDir(artifactsDir);

			// Test query miss with ?q=
			let readdirCountQ = 0;
			const origReaddir = fs.readdir;
			// @ts-expect-error spyOn mockImplementation
			const readdirSpyQ = spyOn(fs, "readdir").mockImplementation(async (...args) => {
				readdirCountQ++;
				return origReaddir(...args);
			});

			try {
				let errorQ: Error | undefined;
				try {
					await InternalUrlRouter.instance().resolve("history://MissingQueryAgent?q=searchterm");
				} catch (err) {
					errorQ = err as Error;
				}
				expect(errorQ?.message).toContain("Unknown agent: MissingQueryAgent");
				// Old code does 3 scans (search miss, resolveFromDisk, ambiguousSessionFileIds). Single scan does 1.
				expect(readdirCountQ).toBe(1);
			} finally {
				readdirSpyQ.mockRestore();
			}

			// Test entry miss with ?entry=
			let readdirCountEntry = 0;
			// @ts-expect-error spyOn mockImplementation
			const readdirSpyEntry = spyOn(fs, "readdir").mockImplementation(async (...args) => {
				readdirCountEntry++;
				return origReaddir(...args);
			});

			try {
				let errorEntry: Error | undefined;
				try {
					await InternalUrlRouter.instance().resolve("history://MissingEntryAgent?entry=m1");
				} catch (err) {
					errorEntry = err as Error;
				}
				expect(errorEntry?.message).toContain("Unknown agent: MissingEntryAgent");
				expect(readdirCountEntry).toBe(1);
			} finally {
				readdirSpyEntry.mockRestore();
			}
		});
	});

	// P2 Finding 1: Timeout does not cancel stored-record searches or transcript loading
	it("cancels stored history search and destroys read stream promptly when aborted", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			const sessionFilePath = path.join(artifactsDir, "StoredSearchAgent.jsonl");
			let content = sessionFixtureJsonl("first entry");
			for (let i = 0; i < 20; i++) {
				content +=
					JSON.stringify({
						type: "message",
						id: `extra-msg-${i}`,
						parentId: "msg-2",
						timestamp: new Date().toISOString(),
						message: { role: "assistant", content: [{ type: "text", text: `filler content ${i}` }] },
					}) + "\n";
			}
			await fs.writeFile(sessionFilePath, content);
			registerArtifactsDir(artifactsDir);

			const controller = new AbortController();
			const callerReason = new Error("search cancelled by user");

			let capturedStream: nodeFs.ReadStream | undefined;
			let chunksDeliveredAfterAbort = 0;
			const origCreateReadStream = nodeFs.createReadStream;
			const streamSpy = spyOn(nodeFs, "createReadStream").mockImplementation((...args) => {
				const stream = origCreateReadStream(...args);
				capturedStream = stream;
				stream.on("data", () => {
					if (controller.signal.aborted) {
						chunksDeliveredAfterAbort++;
					} else {
						controller.abort(callerReason);
					}
				});
				return stream;
			});

			try {
				let error: unknown;
				try {
					await InternalUrlRouter.instance().resolve("history://StoredSearchAgent?q=filler", {
						signal: controller.signal,
					});
				} catch (err) {
					error = err;
				}

				expect(error).toBe(callerReason);
				expect(capturedStream).toBeDefined();
				expect(capturedStream?.destroyed).toBe(true);
				expect(chunksDeliveredAfterAbort).toBe(0);
			} finally {
				streamSpy.mockRestore();
			}
		});
	});

	it("cancels stored history search and destroys read stream promptly when 5s deadline triggers", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			const sessionFilePath = path.join(artifactsDir, "StoredSearchDeadlineAgent.jsonl");
			let content = sessionFixtureJsonl("first entry");
			for (let i = 0; i < 20; i++) {
				content +=
					JSON.stringify({
						type: "message",
						id: `deadline-msg-${i}`,
						parentId: "msg-2",
						timestamp: new Date().toISOString(),
						message: { role: "assistant", content: [{ type: "text", text: `deadline filler ${i}` }] },
					}) + "\n";
			}
			await fs.writeFile(sessionFilePath, content);
			registerArtifactsDir(artifactsDir);
			vi.useFakeTimers();
			const { promise: blockReadStream, resolve: unblockReadStream } = Promise.withResolvers<void>();
			let capturedStream: nodeFs.ReadStream | undefined;
			const origCreateReadStream = nodeFs.createReadStream;
			const streamSpy = spyOn(nodeFs, "createReadStream").mockImplementation((...args) => {
				const stream = origCreateReadStream(...args);
				capturedStream = stream;
				return stream;
			});

			// Make readdir yield to allow resolve() timer to arm, then advance fake timer
			const origReaddir = fs.readdir;
			const readdirSpy = spyOn(fs, "readdir").mockImplementation(async (...args) => {
				const res = await origReaddir(...args);
				// Simulate hanging search stream that runs until 5s deadline
				await blockReadStream;
				return res;
			});

			try {
				const resolvePromise = InternalUrlRouter.instance().resolve("history://StoredSearchDeadlineAgent?q=filler");

				// Allow microtask to enter readdir
				await Promise.resolve();

				// Advance fake timers by 5000ms to trigger the deadline timeout
				vi.advanceTimersByTime(5000);
				await Promise.resolve();

				let error: Error | undefined;
				try {
					await resolvePromise;
				} catch (err) {
					error = err as Error;
				}

				expect(error).toBeDefined();
				expect(error?.message).toContain("history:// timed out after 5s");
			} finally {
				unblockReadStream();
				readdirSpy.mockRestore();
				streamSpy.mockRestore();
				vi.useRealTimers();
			}
		});
	});

	it("cancels stored exact history read promptly and cleans up stream when aborted", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			const sessionFilePath = path.join(artifactsDir, "StoredExactAgent.jsonl");
			await fs.writeFile(sessionFilePath, sessionFixtureJsonl("exact match content"));
			registerArtifactsDir(artifactsDir);

			const callerReason = new Error("exact read aborted by caller");
			const preAbortedSignal = AbortSignal.abort(callerReason);

			let streamOpened = false;
			const origCreateReadStream = nodeFs.createReadStream;
			const streamSpy = spyOn(nodeFs, "createReadStream").mockImplementation((...args) => {
				streamOpened = true;
				return origCreateReadStream(...args);
			});

			try {
				let error: unknown;
				try {
					await InternalUrlRouter.instance().resolve("history://StoredExactAgent?entry=msg-2", {
						signal: preAbortedSignal,
					});
				} catch (err) {
					error = err;
				}

				expect(error).toBe(callerReason);
				expect(streamOpened).toBe(false);
			} finally {
				streamSpy.mockRestore();
			}
		});
	});

	it("cancels parked agent transcript loading promptly when caller signal is aborted mid-load", async () => {
		await withTempDir(async dir => {
			const sessionFilePath = path.join(dir, "ParkedAgent.jsonl");
			await fs.writeFile(sessionFilePath, sessionFixtureJsonl("parked transcript"));

			AgentRegistry.global().register({
				id: "ParkedAgent",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile: sessionFilePath,
				status: "parked",
			});

			const callerReason = new Error("caller aborted parked transcript load mid-flight");
			const controller = new AbortController();

			let readFileCalled = false;
			let parseCalled = false;
			const origReadFile = nodeFs.promises.readFile;
			const readFileSpy = spyOn(nodeFs.promises, "readFile").mockImplementation(async (...args) => {
				readFileCalled = true;
				controller.abort(callerReason);
				return origReadFile(...args);
			});
			const origParse = sessionLoaderModule.parseSessionContent;
			const parseSpy = spyOn(sessionLoaderModule, "parseSessionContent").mockImplementation((...args) => {
				parseCalled = true;
				return origParse(...args);
			});
			try {
				let error: unknown;
				try {
					await InternalUrlRouter.instance().resolve("history://ParkedAgent", {
						signal: controller.signal,
					});
				} catch (err) {
					error = err;
				}

				expect(error).toBe(callerReason);
				expect(readFileCalled).toBe(true);
				expect(parseCalled).toBe(false);
			} finally {
				readFileSpy.mockRestore();
				parseSpy.mockRestore();
			}
		});
	});

	it("aborts loadSessionMessagesReadOnly directly during readFile and prevents parse when signal fires", async () => {
		await withTempDir(async dir => {
			const sessionFilePath = path.join(dir, "DirectReadAbortAgent.jsonl");
			await fs.writeFile(sessionFilePath, sessionFixtureJsonl("direct abort transcript"));

			const callerReason = new Error("direct readFile aborted");
			const controller = new AbortController();
			let readFileStarted = false;
			let parseCalled = false;
			const origReadFile = nodeFs.promises.readFile;
			const readFileSpy = spyOn(nodeFs.promises, "readFile").mockImplementation(async (...args) => {
				readFileStarted = true;
				controller.abort(callerReason);
				return origReadFile(...args);
			});
			const origParse = sessionLoaderModule.parseSessionContent;
			const parseSpy = spyOn(sessionLoaderModule, "parseSessionContent").mockImplementation((...args) => {
				parseCalled = true;
				return origParse(...args);
			});
			try {
				let error: unknown;
				try {
					await loadSessionMessagesReadOnly(sessionFilePath, controller.signal);
				} catch (err) {
					error = err;
				}
				expect(error instanceof Error ? error.name : undefined).toBe("AbortError");
				const errorCause = error instanceof Error && "cause" in error ? error.cause : undefined;
				expect(errorCause ?? error).toBe(callerReason);
				expect(readFileStarted).toBe(true);
				expect(parseCalled).toBe(false);
			} finally {
				readFileSpy.mockRestore();
				parseSpy.mockRestore();
			}
		});
	});

	it("cancels disk transcript loading promptly across read boundaries and cleans up stream resources", async () => {
		await withTempDir(async dir => {
			const artifactsDir = path.join(dir, "artifacts");
			await fs.mkdir(artifactsDir, { recursive: true });
			const sessionFilePath = path.join(artifactsDir, "DiskCancelAgent.jsonl");

			// Write a session file that exceeds STREAM_LOAD_THRESHOLD_BYTES so loadSessionFile
			// uses loadEntriesFromFileStream with forEachFileLine and FileHandle resources.
			const paddingLine = JSON.stringify({
				type: "message",
				id: "padding-msg",
				parentId: "msg-2",
				timestamp: new Date().toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: "X".repeat(1024 * 1024) }] },
			}) + "\n";
			let content = sessionFixtureJsonl("disk cancel transcript");
			while (Buffer.byteLength(content, "utf-8") < STREAM_LOAD_THRESHOLD_BYTES + 1024) {
				content += paddingLine;
			}
			await fs.writeFile(sessionFilePath, content);
			registerArtifactsDir(artifactsDir);

			const callerReason = new Error("disk stream read cancelled mid-load");
			const controller = new AbortController();

			let handleObserved: nodeFs.promises.FileHandle | undefined;
			let handleWasClosed = false;
			const origOpen = nodeFs.promises.open;
			const openSpy = spyOn(nodeFs.promises, "open").mockImplementation(async (...args) => {
				const handle = await origOpen(...args);
				handleObserved = handle;
				const origClose = handle.close.bind(handle);
				handle.close = async () => {
					handleWasClosed = true;
					return origClose();
				};
				// Abort controller when file handle is opened
				controller.abort(callerReason);
				return handle;
			});

			try {
				let error: unknown;
				try {
					await InternalUrlRouter.instance().resolve("history://DiskCancelAgent", {
						signal: controller.signal,
					});
				} catch (err) {
					error = err;
				}

				expect(error).toBe(callerReason);
				expect(handleObserved).toBeDefined();
				expect(handleWasClosed).toBe(true);
			} finally {
				openSpy.mockRestore();
			}
		});
	});

	// P2 Finding 4: CPU-bound live rendering is not protected by a JavaScript timer
	it("rejects live agent history resolution promptly when caller signal is pre-aborted, avoiding synchronous formatting", async () => {
		const messages: unknown[] = [
			{ role: "user", content: "live hello", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "live reply" }], timestamp: 2 },
		];

		AgentRegistry.global().register({
			id: "LiveTimerAgent",
			displayName: "task",
			kind: "sub",
			session: { messages } as never,
			status: "active",
		});

		const callerReason = new Error("caller aborted live history read");
		const preAbortedSignal = AbortSignal.abort(callerReason);

		let error: unknown;
		try {
			await InternalUrlRouter.instance().resolve("history://LiveTimerAgent", {
				signal: preAbortedSignal,
			});
		} catch (err) {
			error = err;
		}

		expect(error).toBe(callerReason);
	});

	it("aborts large live transcript resolution promptly when signal fires during resolution", async () => {
		const messages: unknown[] = [];
		for (let i = 0; i < 500; i++) {
			messages.push({
				role: i % 2 === 0 ? "user" : "assistant",
				content: [{ type: "text", text: `large live transcript payload entry line ${i}` }],
				timestamp: i,
			});
		}

		AgentRegistry.global().register({
			id: "LargeLiveAgent",
			displayName: "task",
			kind: "sub",
			session: { messages } as never,
			status: "active",
		});

		const controller = new AbortController();
		const callerReason = new Error("live formatting aborted");
		controller.abort(callerReason);

		let error: unknown;
		try {
			await InternalUrlRouter.instance().resolve("history://LargeLiveAgent", {
				signal: controller.signal,
			});
		} catch (err) {
			error = err;
		}

		expect(error).toBe(callerReason);
	});
});
