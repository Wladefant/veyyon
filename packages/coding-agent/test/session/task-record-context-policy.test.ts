/**
 * The pilot must archive exact evidence before replacing context, reject stale state, and use
 * the existing compaction/session machinery. These cases use a real file-backed SessionManager
 * and the real extension loader/runner. Storage faults are injected at the artifact boundary.
 * They do not prove live-model task quality, native-provider behavior or performance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { AssistantMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { ExtensionRuntime, loadBuiltinExtension } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import taskRecordContext, {
	captureContinuityTaskRecord,
	MAX_TASK_ARCHIVE_BYTES,
	parseContinuityTaskRecord,
	prepareTaskRecordCompaction,
	TASK_RECORD_FLAG,
	TASK_RECORD_TYPE,
} from "@veyyon/coding-agent/extensibility/extensions/task-record-context";
import type { LoadedExtension } from "@veyyon/coding-agent/extensibility/extensions/types";
import type { SessionBeforeCompactEvent } from "@veyyon/coding-agent/extensibility/shared-events";
import { sessionWorkerAccess } from "@veyyon/coding-agent/native-control/telegram-control-bridge";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const USAGE = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("the opt-in task record policy preserves execution and evidence", () => {
	let temp: TempDir;
	let manager: SessionManager;
	let auth: AuthStorage;
	let runtime: ExtensionRuntime;
	let runner: ExtensionRunner;
	let extension: LoadedExtension;
	let resultId: string;
	let recordId: string;
	let tailId: string;
	let recordText: string;
	let originalFile: string;
	let abortCalls: number;

	function assistant(text: string): string {
		const message: AssistantMessage = {
			role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
			content: [{ type: "text", text }], stopReason: "stop", usage: USAGE, timestamp: Date.now(),
		};
		return manager.appendMessage(message);
	}

	function event(signal = new AbortController().signal): SessionBeforeCompactEvent {
		return {
			type: "session_before_compact", branchEntries: manager.getBranch(), signal,
			preparation: {
				firstKeptEntryId: tailId, tokensBefore: 4000, isSplitTurn: false,
				messagesToSummarize: [], turnPrefixMessages: [], recentMessages: [], tailElisions: [],
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, strategy: "summary", keepRecentTokens: 1000 },
			},
		};
	}

	beforeEach(async () => {
		temp = TempDir.createSync("@veyyon-task-record-");
		manager = SessionManager.create(temp.path(), temp.path());
		manager.appendMessage({ role: "user", content: "Keep the running job and verify its final result.", timestamp: Date.now() });
		assistant("The job has been started once.");
		resultId = manager.appendMessage({
			role: "toolResult", toolName: "job", toolCallId: "job-start-1", isError: false,
			content: [{ type: "text", text: "  exact result\tΩ 😀\r\nSECRET-fixture" }],
			details: { jobId: "job-1", status: "running" }, timestamp: Date.now(),
		});
		recordText = JSON.stringify({
			version: 1, objective: "Verify the running job result.", constraints: ["Do not start the job again."],
			facts: ["SECRET-fixture"], completed: [{ id: "job-start-1", summary: "Job started.", evidence: [resultId] }],
			pending: [{ id: "job-1", kind: "job", ownerSessionId: manager.getSessionId() }],
			nextActions: ["Poll job-1 and verify its final result."],
		});
		recordId = manager.appendCustomEntry(TASK_RECORD_TYPE, captureContinuityTaskRecord(manager, recordText));
		tailId = assistant("I will poll the existing job.");
		await manager.flush();
		originalFile = manager.getSessionFile()!;
		auth = await AuthStorage.create(temp.join("auth.db"));
		runtime = new ExtensionRuntime();
		extension = await loadBuiltinExtension(taskRecordContext, temp.path(), new EventBus(), runtime, "task-record-context");
		runner = new ExtensionRunner([extension], runtime, temp.path(), manager, new ModelRegistry(auth));
		abortCalls = 0;
		runner.initialize({
			sendMessage: () => {}, sendUserMessage: () => {},
			appendEntry: (type, data) => { manager.appendCustomEntry(type, data); }, setLabel: () => {},
			getActiveTools: () => [], getAllTools: () => [], setActiveTools: async () => {}, getCommands: () => [],
			setModel: async () => false, getThinkingLevel: () => undefined, setThinkingLevel: () => {},
			getSessionName: () => undefined, setSessionName: async () => {}, ...sessionWorkerAccess(() => undefined),
		}, {
			getModel: () => getBundledModel("anthropic", "claude-sonnet-4-5"), isIdle: () => true,
			abort: () => { abortCalls++; }, hasPendingMessages: () => true, shutdown: () => {},
			getContextUsage: () => undefined, compact: async () => {}, getSystemPrompt: () => [],
			obfuscateProviderText: text => text.replaceAll("SECRET-fixture", "#REDACTED#"),
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.close();
		auth.close();
		await temp.remove();
	});

	it("does nothing until enabled, then persists exact evidence and rebuilds in the same session", async () => {
		const before = JSON.parse(JSON.stringify(manager.getBranch()));
		const sessionId = manager.getSessionId();
		const leaf = manager.getLeafId();
		expect(await runner.emit(event())).toBeUndefined();
		runtime.flagValues.set(TASK_RECORD_FLAG, true);
		const outcome = await runner.emit(event());
		const result = outcome?.compaction;
		if (!result) throw new Error("Expected the enabled policy's compaction result");
		const summary = JSON.parse(result.summary);
		expect(summary.task.constraints).toEqual(["Do not start the job again."]);
		expect(summary.task.pending).toEqual([{ id: "job-1", kind: "job", ownerSessionId: sessionId }]);
		expect(summary.task.facts).toEqual(["#REDACTED#"]);
		expect(summary.taskRecordEntryId).toBe(recordId);
		expect(summary.recovery.sessionId).toBe(sessionId);
		expect(summary.recovery.branchLeafId).toBe(leaf);
		const path = await manager.getArtifactPath(summary.recovery.artifact.slice("artifact://".length));
		if (!path) throw new Error("Expected an on-disk recovery artifact");
		const bytes = await fs.readFile(path, "utf8");
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(summary.recovery.sha256);
		expect(JSON.parse(bytes).entries).toEqual(before);
		manager.appendCompaction(result.summary, undefined, result.firstKeptEntryId, result.tokensBefore, result.details, true);
		await manager.flush();
		const reloaded = await SessionManager.open(originalFile, temp.path(), undefined, { suppressBreadcrumb: true });
		try {
			expect(reloaded.getSessionId()).toBe(sessionId);
			expect(reloaded.getEntry(resultId)).toEqual(before.find((item: { id: string }) => item.id === resultId));
			const context = JSON.stringify(reloaded.buildSessionContext().messages);
			expect(context).toContain("task-record-retrieval");
			expect(context).toContain("I will poll the existing job.");
			expect(context).not.toContain("exact result");
		} finally { await reloaded.close(); }
		expect(manager.getSessionFile()).toBe(originalFile);
		expect(abortCalls).toBe(0);
	});

	it("keeps the existing summary path for explicit instructions or opaque provider state", async () => {
		runtime.flagValues.set(TASK_RECORD_FLAG, true);
		const instructed = event();
		instructed.customInstructions = "Use the existing detailed summary.";
		expect(await runner.emit(instructed)).toBeUndefined();
		const opaque = event();
		opaque.preparation.previousPreserveData = { providerWindow: { opaque: "fixture" } };
		expect(await runner.emit(opaque)).toBeUndefined();
	});

	it("the real command captures the current branch and can disable this session", async () => {
		runtime.flagValues.set(TASK_RECORD_FLAG, true);
		const command = extension.commands.get("context-record");
		if (!command) throw new Error("Expected the registered command");
		await command.handler(recordText, runner.createCommandContext());
		const record = manager.getLeafEntry();
		if (record?.type !== "custom") throw new Error("Expected persistent task state");
		expect(record.customType).toBe(TASK_RECORD_TYPE);
		expect(record.parentId).toBe(tailId);
		await command.handler("off", runner.createCommandContext());
		expect(await runner.emit(event())).toBeUndefined();
	});

	for (const fault of ["missing-id", "archive-write", "missing-path"] as const) {
		it(`cancels when ${fault} prevents a durable recovery pointer`, async () => {
			runtime.flagValues.set(TASK_RECORD_FLAG, true);
			const before = JSON.stringify(manager.getBranch());
			const file = await fs.readFile(originalFile, "utf8");
			if (fault === "missing-id") vi.spyOn(manager, "saveArtifact").mockResolvedValue(undefined);
			if (fault === "archive-write") vi.spyOn(manager, "saveArtifact").mockRejectedValue(new Error("fixture write failure"));
			if (fault === "missing-path") vi.spyOn(manager, "getArtifactPath").mockResolvedValue(null);
			expect(await runner.emit(event())).toEqual({ cancel: true });
			expect(JSON.stringify(manager.getBranch())).toBe(before);
			expect(await fs.readFile(originalFile, "utf8")).toBe(file);
			expect(abortCalls).toBe(0);
		});
	}

	it("rejects a new user correction and work outside the task record's coverage", async () => {
		manager.appendMessage({ role: "user", content: "The acceptance condition changed.", timestamp: Date.now() });
		await expect(prepareTaskRecordCompaction(event(), manager)).rejects.toThrow("newer user");
		manager.branch(tailId);
		const extra = assistant("Unrecorded work completed.");
		const uncovered = event();
		uncovered.preparation.firstKeptEntryId = extra;
		await expect(prepareTaskRecordCompaction(uncovered, manager)).rejects.toThrow("Newly discarded work");
	});

	it("does not borrow a sibling record or accept an ephemeral execution session", async () => {
		manager.branch(resultId);
		await expect(prepareTaskRecordCompaction(event(), manager)).rejects.toThrow("Capture a task record");
		const ephemeral = SessionManager.inMemory();
		try {
			ephemeral.appendMessage({ role: "user", content: "A temporary task", timestamp: Date.now() });
			expect(() => captureContinuityTaskRecord(ephemeral, recordText)).toThrow("persisted session");
		} finally { await ephemeral.close(); }
	});

	it("rejects branch and same-leaf content changes during archival", async () => {
		for (const change of ["branch", "content"] as const) {
			manager.branch(tailId);
			const pending = Promise.withResolvers<string | undefined>();
			const entered = Promise.withResolvers<void>();
			const save = vi.spyOn(manager, "saveArtifact").mockImplementation(async () => { entered.resolve(); return pending.promise; });
			const path = vi.spyOn(manager, "getArtifactPath").mockResolvedValue("fixture-persisted-path");
			const work = prepareTaskRecordCompaction(event(), manager);
			await entered.promise;
			if (change === "branch") manager.branch(resultId);
			else {
				const tail = manager.getEntry(tailId);
				if (tail?.type !== "message" || tail.message.role !== "assistant") throw new Error("Expected assistant tail entry");
				tail.message.content = [{ type: "text", text: "changed during archive" }];
			}
			pending.resolve("fixture-archive");
			await expect(work).rejects.toThrow("branch changed");
			save.mockRestore(); path.mockRestore();
		}
	});

	it("archives the original multimodal result when preparation already elided a tail result", async () => {
		const current = manager.getEntry(resultId);
		if (current?.type !== "message" || current.message.role !== "toolResult") throw new Error("Expected result");
		const original = current.message;
		original.content.push({ type: "image", data: "Zml4dHVyZQ==", mimeType: "image/png" });
		const replacement = { ...original, content: [{ type: "text" as const, text: "elided" }] };
		current.message = replacement;
		const prepared = event();
		prepared.preparation.tailElisions = [{
			entryId: resultId, toolName: "job", tokens: 1000, originalText: "exact text",
			originalMessage: original, message: replacement,
		}];
		const result = (await prepareTaskRecordCompaction(prepared, manager)).compaction!;
		const summary = JSON.parse(result.summary);
		const path = await manager.getArtifactPath(summary.recovery.artifact.slice(11));
		if (!path) throw new Error("Expected archive");
		const archive = JSON.parse(await fs.readFile(path, "utf8"));
		expect(archive.entries.find((item: { id: string }) => item.id === resultId).message).toEqual(original);
		expect(current.message).toEqual(replacement);
	});

	it("bounds task records, action identities, ownership and serialized archive size", async () => {
		expect(() => parseContinuityTaskRecord(JSON.stringify({ ...JSON.parse(recordText), unexpected: true })))
			.toThrow("schema 1");
		const duplicate = JSON.parse(recordText);
		duplicate.pending[0].id = duplicate.completed[0].id;
		expect(() => parseContinuityTaskRecord(JSON.stringify(duplicate))).toThrow("unique");
		const wrongOwner = JSON.parse(recordText);
		wrongOwner.pending[0].ownerSessionId = "another-session";
		expect(() => captureContinuityTaskRecord(manager, JSON.stringify(wrongOwner))).toThrow("owner");
		expect(() => parseContinuityTaskRecord("x".repeat(12 * 1024 + 1))).toThrow("12 KiB");
		const result = manager.getEntry(resultId);
		if (result?.type !== "message" || result.message.role !== "toolResult") throw new Error("Expected tool result");
		result.message.content = [{ type: "text", text: "x".repeat(MAX_TASK_ARCHIVE_BYTES + 1) }];
		await expect(prepareTaskRecordCompaction(event(), manager)).rejects.toThrow("8 MiB");
	});

	it("an abort while saving cannot return a context replacement", async () => {
		const control = new AbortController();
		const saving = Promise.withResolvers<string | undefined>();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(manager, "saveArtifact").mockImplementation(async () => { entered.resolve(); return saving.promise; });
		const work = prepareTaskRecordCompaction(event(control.signal), manager);
		await entered.promise;
		control.abort();
		await expect(work).rejects.toThrow("cancelled");
		saving.resolve("late-artifact");
		expect(manager.getLeafId()).toBe(tailId);
	});

	for (const secret of ['fixture"quote', "fixture\\slash", "fixture\nnewline"]) {
		it(`redacts escaped task strings without rewriting archived evidence: ${JSON.stringify(secret)}`, async () => {
			const input = JSON.stringify({ ...JSON.parse(recordText), facts: [secret] });
			const id = manager.appendCustomEntry(TASK_RECORD_TYPE, captureContinuityTaskRecord(manager, input));
			const prepared = event();
			prepared.preparation.firstKeptEntryId = id;
			const result = (await prepareTaskRecordCompaction(prepared, manager, text => text.replaceAll(secret, "#REDACTED#")))
				.compaction!;
			const summary = JSON.parse(result.summary);
			expect(summary.task.facts).toEqual(["#REDACTED#"]);
			expect(summary.task.pending).toEqual(JSON.parse(recordText).pending);
			expect(result.firstKeptEntryId).toBe(id);
			expect(result.tokensBefore).toBe(prepared.preparation.tokensBefore);
			const path = await manager.getArtifactPath(summary.recovery.artifact.slice(11));
			if (!path) throw new Error("Expected exact recovery archive");
			expect(await fs.readFile(path, "utf8")).toContain(JSON.stringify(secret));
		});
	}

	it("accepts a fully covered keep-nothing boundary but rejects newly discarded work", async () => {
		manager.branch(recordId);
		const prepared = event();
		prepared.preparation.firstKeptEntryId = "compaction:keep-nothing";
		const before = JSON.stringify(manager.getBranch());
		const result = (await prepareTaskRecordCompaction(prepared, manager)).compaction!;
		expect(result.firstKeptEntryId).toBe(prepared.preparation.firstKeptEntryId);
		expect(result.tokensBefore).toBe(prepared.preparation.tokensBefore);
		expect(JSON.stringify(manager.getBranch())).toBe(before);
		assistant("New work not covered by the record.");
		const stale = event();
		stale.preparation.firstKeptEntryId = "compaction:keep-nothing";
		await expect(prepareTaskRecordCompaction(stale, manager)).rejects.toThrow("Newly discarded work");
	});
});
