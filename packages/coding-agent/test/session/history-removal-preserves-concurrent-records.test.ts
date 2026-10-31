/**
 * WHY: the producer suites cover ordinary recovery, while removal still needs coverage for valid
 * role variants, details-only images, native provider history, cold no-op reads, and concurrent
 * writes across archive and disk awaits. This suite closes those removal gaps; it does not test
 * rewriting provider-native history, which must be refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@veyyon/agent-core";
import type { ShakeRegion } from "@veyyon/agent-core/compaction";
import { USELESS_NOTICE } from "@veyyon/agent-core/compaction/pruning";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";
import { getBundledModel } from "@veyyon/catalog/models";
import { coldFieldsOf } from "@veyyon/kernel/session/session-cold-payloads";
import type { AssistantMessage, ImageContent } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { HistoryRewrites } from "@veyyon/coding-agent/session/runtime/history-rewrites";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";

const IMAGE: ImageContent = { type: "image", data: "c2Vzc2lvbi1pbWFnZS1maXh0dXJl", mimeType: "image/png" };
const USAGE = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const UPDATED_ENTRY_TIME = "2040-01-01T00:00:00.000Z";

describe("history removals preserve concurrent records", () => {
	let temp: TempDir;
	let manager: SessionManager;
	let storage: FileSessionStorage;
	let agent: Agent;
	let rewrites: HistoryRewrites;
	let file: string;

	beforeEach(async () => {
		temp = TempDir.createSync("@veyyon-history-removal-races-");
		storage = new FileSessionStorage();
		manager = SessionManager.create(temp.path(), temp.path(), storage);
		manager.appendMessage({ role: "user", content: "Keep this session recoverable.", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "Initial assistant response." }],
			stopReason: "stop",
			usage: USAGE,
			timestamp: Date.now(),
		});
		await manager.flush();
		file = manager.getSessionFile()!;
		agent = new Agent({ initialState: { tools: [], systemPrompt: ["Test"], messages: manager.buildSessionContext().messages } });
		rewrites = new HistoryRewrites({
			sessionStore: manager,
			agent,
			settings: Settings.isolated({ "compaction.supersedeReads": false, "compaction.dropUseless": true }),
			withPlanProtection: config => config,
			model: () => undefined,
			keepBoundaryId: () => undefined,
			rebuiltMessages: () => manager.buildSessionContext().messages,
			resetAdvisorRuntimes: () => {},
			closeCodexSessions: () => {},
			markHistoryRewritten: () => {},
			syncTodos: () => {},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.close();
		await temp.remove();
	});

	async function syncLiveMessages(): Promise<void> {
		await manager.flush();
		agent.replaceMessages(manager.buildSessionContext().messages);
	}

	function appendImageResult(callId: string, details: unknown = { source: "fixture" }): string {
		return manager.appendMessage({
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: "tool output" }, IMAGE],
			isError: false,
			details,
			timestamp: Date.now(),
		});
	}

	it.each(["user", "developer"] as const)(
		"refuses to remove canonical %s images when native OpenAI Responses history is present",
		async role => {
			const model = getBundledModel("openai", "gpt-4o-mini");
			if (!model) throw new Error("Expected bundled OpenAI vision model");
			const payload = createOpenAIResponsesHistoryPayload(model.provider, [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "Inspect the attached image." },
						{
							type: "input_image",
							image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT2sAAAAASUVORK5CYII=",
							detail: "auto",
						},
					],
				},
				{ type: "compaction", encrypted_content: "opaque-native-history" },
			]);
			const ordinaryId = manager.appendMessage({
				role: "user",
				content: [IMAGE],
				timestamp: Date.now(),
			});
			const candidateId = role === "user"
				? manager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "Inspect this image." }, IMAGE],
					providerPayload: payload,
					timestamp: Date.now(),
				})
				: manager.appendMessage({
					role: "developer",
					content: [IMAGE],
					providerPayload: payload,
					timestamp: Date.now(),
				});
			await syncLiveMessages();
			const originals = structuredClone(manager.getBranch());
			const liveMessages = structuredClone(agent.state.messages);
			const disk = await fs.readFile(file, "utf8");
			const artifacts = manager.getArtifactManager();
			if (!artifacts) throw new Error("Expected session artifact manager");
			const artifactFiles = await artifacts.listFiles();

			const refusal = await rewrites.dropImages().then(
				() => undefined,
				error => error,
			);

			expect(refusal).toBeInstanceOf(Error);
			expect(refusal instanceof Error ? refusal.message : undefined).toBe(
				"Cannot remove images: native OpenAI Responses history cannot be rewritten safely",
			);
			expect(manager.getEntry(ordinaryId)).toEqual(originals.find(entry => entry.id === ordinaryId));
			expect(manager.getEntry(candidateId)).toEqual(originals.find(entry => entry.id === candidateId));
			expect(manager.getBranch()).toEqual(originals);
			expect(agent.state.messages).toEqual(liveMessages);
			expect(await fs.readFile(file, "utf8")).toBe(disk);
			expect(await artifacts.listFiles()).toEqual(artifactFiles);
		},
	);

	it("leaves a cold assistant payload cold when no image needs removal", async () => {
		let coldAssistantId: string | undefined;
		let keptId = "";
		for (let turn = 0; turn < 40; turn++) {
			const userId = manager.appendMessage({
				role: "user",
				content: `session turn ${turn}`,
				timestamp: turn,
			});
			if (turn === 35) keptId = userId;
			const assistantId = manager.appendMessage({
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				content: [{ type: "text", text: turn === 0 ? `long assistant ${"x".repeat(4096)}` : `answer ${turn}` }],
				stopReason: "stop",
				usage: USAGE,
				timestamp: turn,
			});
			if (turn === 0) coldAssistantId = assistantId;
		}
		if (!coldAssistantId || !keptId) throw new Error("Expected a compacted assistant turn");
		manager.appendCompaction("summary", undefined, keptId, 1000);
		await manager.flush();
		manager.coolCompactedHistory();
		agent.replaceMessages(manager.buildSessionContext().messages);
		const entry = manager.getEntry(coldAssistantId);
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			throw new Error("Expected compacted assistant entry");
		}
		expect(coldFieldsOf(entry.message)).toBeDefined();
		const liveMessages = structuredClone(agent.state.messages);
		const disk = await fs.readFile(file, "utf8");

		expect(await rewrites.dropImages()).toEqual({ removed: 0 });

		const after = manager.getEntry(coldAssistantId);
		if (after?.type !== "message" || after.message.role !== "assistant") {
			throw new Error("Expected compacted assistant entry after no-op removal");
		}
		expect(coldFieldsOf(after.message)).toBeDefined();
		expect(agent.state.messages).toEqual(liveMessages);
		expect(await fs.readFile(file, "utf8")).toBe(disk);
	});

	it("archives images in developer, custom, hook, and details-only result records", async () => {
		const records = [
			{
				role: "developer" as const,
				id: manager.appendMessage({ role: "developer", content: [IMAGE], timestamp: Date.now() }),
			},
			{
				role: "custom" as const,
				id: manager.appendMessage({
					role: "custom", customType: "image-fixture", content: [IMAGE], display: false, timestamp: Date.now(),
				}),
			},
			{
				role: "hookMessage" as const,
				id: manager.appendMessage({
					role: "hookMessage", customType: "image-hook-fixture", content: [IMAGE], display: false, timestamp: Date.now(),
				}),
			},
			{
				role: "toolResult" as const,
				id: manager.appendMessage({
					role: "toolResult",
					toolCallId: "details-only-image",
					toolName: "read",
					content: [{ type: "text", text: "no inline image" }],
					details: { images: [IMAGE], source: "details-only" },
					isError: false,
					timestamp: Date.now(),
				}),
			},
		] as const;
		await syncLiveMessages();
		const originals = records.map(({ id }) => {
			const entry = manager.getEntry(id);
			if (!entry) throw new Error(`Missing seeded record ${id}`);
			return structuredClone(entry);
		});

		expect(await rewrites.dropImages()).toEqual({ removed: 4 });

		const reloaded = await SessionManager.open(file, temp.path(), undefined, { suppressBreadcrumb: true });
		try {
			let archiveId: string | undefined;
			for (const { id, role } of records) {
				const entry = reloaded.getEntry(id);
				if (entry?.type !== "message") throw new Error(`Expected persisted message ${id}`);
				expect(entry.message.role).toBe(role);
				expect(JSON.stringify(entry)).not.toContain(IMAGE.data);
				const reference = JSON.stringify(entry).match(/artifact:\/\/([^\s)]+)/)?.[1];
				if (!reference) throw new Error(`Missing recovery pointer on ${id}`);
				if (archiveId) expect(reference).toBe(archiveId);
				archiveId = reference;
			}
			const archivePath = await reloaded.getArtifactPath(archiveId!);
			if (!archivePath) throw new Error("Expected durable archive for message-role variants");
			const archive = JSON.parse(await fs.readFile(archivePath, "utf8"));
			expect(archive.operation).toBe("drop-images");
			expect(archive.entries).toEqual(originals);
			const detailsEntry = reloaded.getEntry(records[3]!.id);
			if (detailsEntry?.type !== "message" || detailsEntry.message.role !== "toolResult") {
				throw new Error("Expected details-only tool result");
			}
			expect(detailsEntry.message.details).toEqual({ images: [], source: "details-only" });
			expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
		} finally {
			await reloaded.close();
		}
	});

	it("does not apply a selected rewrite after resetLeaf during archive save", async () => {
		const id = appendImageResult("reset-leaf");
		await syncLiveMessages();
		const selected = manager.getEntry(id);
		if (!selected) throw new Error("Expected selected image record");
		const original = structuredClone(selected);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const save = manager.saveArtifact.bind(manager);
		vi.spyOn(manager, "saveArtifact").mockImplementation(async (content, type) => {
			entered.resolve();
			await release.promise;
			return save(content, type);
		});
		const operation = rewrites.dropImages().then(() => null, error => error);
		await entered.promise;
		manager.resetLeaf();
		release.resolve();

		expect(await operation).toBeInstanceOf(Error);
		expect(manager.getBranch()).toEqual([]);
		expect(manager.getEntry(id)).toEqual(original);
	});


	it("refuses a stale shake archive selection and preserves the newer persisted tool result", async () => {
		const oldText = "original synthetic tool result";
		const newerText = "newer synthetic tool result that must stay recoverable";
		const id = manager.appendMessage({
			role: "toolResult",
			toolCallId: "shake-race",
			toolName: "read",
			content: [{ type: "text", text: oldText }],
			isError: false,
			timestamp: Date.now(),
		});
		await syncLiveMessages();
		const selected = manager.getEntry(id);
		if (selected?.type !== "message" || selected.message.role !== "toolResult") {
			throw new Error("Expected selected tool result");
		}
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const save = manager.saveArtifact.bind(manager);
		vi.spyOn(manager, "saveArtifact").mockImplementation(async (content, type) => {
			entered.resolve();
			await release.promise;
			return save(content, type);
		});
		const region: ShakeRegion = {
			kind: "toolResult",
			entry: selected,
			label: "read",
			tokens: 250,
			originalText: oldText,
		};
		const pending = rewrites.offloadAndApply([region]).then(() => null, error => error);
		await entered.promise;
		selected.message.content = [{ type: "text", text: newerText }];
		await manager.rewriteEntries([selected]);
		agent.replaceMessages(manager.buildSessionContext().messages);
		const authoritativeEntry = structuredClone(selected);
		const authoritativeDisk = await fs.readFile(file, "utf8");
		const authoritativeAgent = structuredClone(agent.state.messages);
		release.resolve();

		const failure = await pending;
		expect(failure instanceof Error ? failure.message : failure).toBe(
			"History changed while saving shake artifact; retry the rewrite",
		);
		expect(manager.getEntry(id)).toEqual(authoritativeEntry);
		expect(await fs.readFile(file, "utf8")).toBe(authoritativeDisk);
		expect(agent.state.messages).toEqual(authoritativeAgent);

		// An updated selection can still save the exact new bytes before replacing them.
		const outcome = await rewrites.offloadAndApply([{ ...region, originalText: newerText }]);
		expect(outcome.toolResultsDropped).toBe(1);
		if (!outcome.artifactId) throw new Error("Expected recovery artifact for the new selection");
		const artifactPath = await manager.getArtifactPath(outcome.artifactId);
		if (!artifactPath) throw new Error("Expected retained recovery artifact");
		expect(await fs.readFile(artifactPath, "utf8")).toContain(newerText);
		const rewritten = manager.getEntry(id);
		if (rewritten?.type !== "message" || rewritten.message.role !== "toolResult") {
			throw new Error("Expected persisted elided tool result");
		}
		expect(JSON.stringify(rewritten.message.content)).toContain(`artifact://${outcome.artifactId}`);
		expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
	});

	it("restores shake originals after a transcript failure while retaining the recovery artifact", async () => {
		const originalText = "Shake output must remain intact after a rejected transcript write.";
		const id = manager.appendMessage({
			role: "toolResult", toolCallId: "failed-shake", toolName: "read",
			content: [{ type: "text", text: originalText }], isError: false, timestamp: Date.now(),
		});
		await syncLiveMessages();
		const selected = manager.getEntry(id);
		if (selected?.type !== "message" || selected.message.role !== "toolResult") {
			throw new Error("Expected selected tool result");
		}
		const original = structuredClone(selected);
		const diskBefore = await fs.readFile(file, "utf8");
		const promptBefore = structuredClone(agent.state.messages);
		let savedArtifact: string | undefined;
		const save = manager.saveArtifact.bind(manager);
		vi.spyOn(manager, "saveArtifact").mockImplementation(async (content, toolType) => {
			savedArtifact = await save(content, toolType);
			return savedArtifact;
		});
		vi.spyOn(storage, "writeTextAtomic").mockRejectedValue(new Error("shake transcript rejected"));
		vi.spyOn(storage, "rewriteTailAtomic").mockRejectedValue(new Error("shake transcript rejected"));
		const region: ShakeRegion = {
			kind: "toolResult", entry: selected, label: "read", tokens: 200, originalText,
		};
		await expect(rewrites.offloadAndApply([region])).rejects.toThrow("shake transcript rejected");
		expect(manager.getEntry(id)).toEqual(original);
		expect(await fs.readFile(file, "utf8")).toBe(diskBefore);
		expect(agent.state.messages).toEqual(promptBefore);
		if (!savedArtifact) throw new Error("Expected archive saved before failed transcript");
		const savedPath = await manager.getArtifactPath(savedArtifact);
		if (!savedPath) throw new Error("Expected recovery artifact path");
		expect(await fs.readFile(savedPath, "utf8")).toContain(originalText);

		vi.restoreAllMocks();
		const retried = await rewrites.offloadAndApply([region]);
		expect(retried.toolResultsDropped).toBe(1);
		if (!retried.artifactId) throw new Error("Expected successful retry archive");
		const retryPath = await manager.getArtifactPath(retried.artifactId);
		if (!retryPath) throw new Error("Expected retry recovery artifact");
		expect(await fs.readFile(retryPath, "utf8")).toContain(originalText);
		expect(JSON.stringify(manager.getEntry(id))).toContain(`artifact://${retried.artifactId}`);
		expect(await fs.readFile(file, "utf8")).not.toBe(diskBefore);
		expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
	});

	it("does not overwrite a concurrent live shake edit during failed transcript persistence", async () => {
		const originalText = "Original shaken synthetic output.";
		const id = manager.appendMessage({
			role: "toolResult", toolCallId: "concurrent-shake", toolName: "read",
			content: [{ type: "text", text: originalText }], isError: false, timestamp: Date.now(),
		});
		await syncLiveMessages();
		const selected = manager.getEntry(id);
		if (selected?.type !== "message" || selected.message.role !== "toolResult") {
			throw new Error("Expected selected tool result");
		}
		const diskBefore = await fs.readFile(file, "utf8");
		const promptBefore = structuredClone(agent.state.messages);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const rejectPersist = async (): Promise<void> => {
			entered.resolve();
			await release.promise;
			throw new Error("shake transcript rejected");
		};
		vi.spyOn(storage, "writeTextAtomic").mockImplementation(rejectPersist);
		vi.spyOn(storage, "rewriteTailAtomic").mockImplementation(rejectPersist);
		const region: ShakeRegion = {
			kind: "toolResult", entry: selected, label: "read", tokens: 200, originalText,
		};
		const pending = rewrites.offloadAndApply([region]).then(() => null, error => error);
		await entered.promise;
		selected.timestamp = UPDATED_ENTRY_TIME;
		selected.message.content.push({ type: "text", text: "Concurrent retained note." });
		release.resolve();
		const failure = await pending;
		expect(failure instanceof Error ? failure.message : failure).toBe("shake transcript rejected");
		expect(manager.getEntry(id)).toBe(selected);
		expect(selected.timestamp).toBe(UPDATED_ENTRY_TIME);
		expect(JSON.stringify(selected.message.content)).toContain("Concurrent retained note.");
		expect(JSON.stringify(selected.message.content)).toContain("artifact://");
		expect(await fs.readFile(file, "utf8")).toBe(diskBefore);
		expect(agent.state.messages).toEqual(promptBefore);
	});

	it("preserves a concurrent content update while an image archive is pending", async () => {
		const id = appendImageResult("concurrent-content");
		await syncLiveMessages();
		const selected = manager.getEntry(id);
		if (selected?.type !== "message" || selected.message.role !== "toolResult") {
			throw new Error("Expected selected tool result");
		}
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const save = manager.saveArtifact.bind(manager);
		vi.spyOn(manager, "saveArtifact").mockImplementation(async (content, type) => {
			entered.resolve();
			await release.promise;
			return save(content, type);
		});
		const operation = rewrites.dropImages().then(() => null, error => error);
		await entered.promise;
		selected.message.content.push({ type: "text", text: "concurrent content update" });
		const concurrent = structuredClone(selected);
		await manager.rewriteEntries([selected]);
		const concurrentDisk = await fs.readFile(file, "utf8");
		release.resolve();

		expect(await operation).toBeInstanceOf(Error);
		expect(manager.getEntry(id)).toEqual(concurrent);
		expect(await fs.readFile(file, "utf8")).toBe(concurrentDisk);
	});

	it("preserves concurrent tool content and metadata when transcript persistence fails", async () => {
		const id = appendImageResult("concurrent-metadata", { source: "original" });
		await syncLiveMessages();
		const original = manager.getEntry(id);
		if (!original) throw new Error("Expected original image result before rewrite");
		const originalSnapshot = structuredClone(original);
		const liveMessages = structuredClone(agent.state.messages);
		const disk = await fs.readFile(file, "utf8");
		const artifacts = manager.getArtifactManager();
		if (!artifacts) throw new Error("Expected session artifact manager");
		const artifactFiles = await artifacts.listFiles();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failDuringPersist = async (): Promise<void> => {
			entered.resolve();
			await release.promise;
			throw new Error("transcript failure");
		};
		vi.spyOn(storage, "writeTextAtomic").mockImplementation(failDuringPersist);
		vi.spyOn(storage, "rewriteTailAtomic").mockImplementation(failDuringPersist);
		const operation = rewrites.dropImages().then(() => null, error => error);
		await entered.promise;
		const current = manager.getEntry(id);
		if (current?.type !== "message" || current.message.role !== "toolResult") {
			throw new Error("Expected selected tool result during persistence");
		}
		current.timestamp = UPDATED_ENTRY_TIME;
		current.message.details = { source: "concurrent" };
		current.message.content.push({ type: "text", text: "Concurrent content update." });
		release.resolve();

		expect(await operation).toBeInstanceOf(Error);
		const after = manager.getEntry(id);
		if (after?.type !== "message" || after.message.role !== "toolResult") {
			throw new Error("Expected original tool result after rollback");
		}
		expect(after.timestamp).toBe(UPDATED_ENTRY_TIME);
		expect(after.message.details).toEqual({ source: "concurrent" });
		expect(after.message.content).toEqual(
			expect.arrayContaining([{ type: "text", text: "Concurrent content update." }]),
		);
		expect(after.message.content.some(part => part.type === "image")).toBe(false);
		const reference = after.message.content.find(
			part => part.type === "text" && part.text.includes("[recover: artifact://"),
		);
		if (!reference || reference.type !== "text") throw new Error("Expected live recovery reference");
		const artifactId = reference.text.match(/artifact:\/\/([^\s)]+)/)?.[1];
		if (!artifactId) throw new Error("Expected recovery artifact id");
		expect(reference.text).toBe(`\n[recover: artifact://${artifactId} (entry ${id})]`);
		const artifactPath = await manager.getArtifactPath(artifactId);
		if (!artifactPath) throw new Error("Expected full original archive after failed publish");
		const archive = JSON.parse(await fs.readFile(artifactPath, "utf8"));
		expect(archive.operation).toBe("drop-images");
		expect(archive.entries).toEqual([originalSnapshot]);
		expect(await artifacts.listFiles()).toHaveLength(artifactFiles.length + 1);
		expect(agent.state.messages).toEqual(liveMessages);
		expect(await fs.readFile(file, "utf8")).toBe(disk);
	});

	it("preserves concurrent custom-message content and metadata when transcript persistence fails", async () => {
		const id = manager.appendCustomMessageEntry("image-evidence", [IMAGE], false, { source: "original" });
		await syncLiveMessages();
		const original = manager.getEntry(id);
		if (!original || original.type !== "custom_message") {
			throw new Error("Expected original custom message before rewrite");
		}
		const originalSnapshot = structuredClone(original);
		const liveMessages = structuredClone(agent.state.messages);
		const disk = await fs.readFile(file, "utf8");
		const artifacts = manager.getArtifactManager();
		if (!artifacts) throw new Error("Expected session artifact manager");
		const artifactFiles = await artifacts.listFiles();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const failDuringPersist = async (): Promise<void> => {
			entered.resolve();
			await release.promise;
			throw new Error("transcript failure");
		};
		vi.spyOn(storage, "writeTextAtomic").mockImplementation(failDuringPersist);
		vi.spyOn(storage, "rewriteTailAtomic").mockImplementation(failDuringPersist);
		const operation = rewrites.dropImages().then(() => null, error => error);
		await entered.promise;
		const current = manager.getEntry(id);
		if (current?.type !== "custom_message") {
			throw new Error("Expected selected custom message during persistence");
		}
		current.timestamp = UPDATED_ENTRY_TIME;
		current.details = { source: "concurrent" };
		if (typeof current.content === "string") throw new Error("Expected custom image content blocks");
		current.content.push({ type: "text", text: "Concurrent custom content update." });
		release.resolve();

		expect(await operation).toBeInstanceOf(Error);
		const after = manager.getEntry(id);
		if (after?.type !== "custom_message") {
			throw new Error("Expected original custom message after rollback");
		}
		expect(after.timestamp).toBe(UPDATED_ENTRY_TIME);
		expect(after.details).toEqual({ source: "concurrent" });
		if (typeof after.content === "string") throw new Error("Expected custom content blocks after failure");
		expect(after.content).toEqual(
			expect.arrayContaining([{ type: "text", text: "Concurrent custom content update." }]),
		);
		expect(after.content.some(part => part.type === "image")).toBe(false);
		const reference = after.content.find(
			part => part.type === "text" && part.text.includes("[recover: artifact://"),
		);
		if (!reference || reference.type !== "text") throw new Error("Expected live recovery reference");
		const artifactId = reference.text.match(/artifact:\/\/([^\s)]+)/)?.[1];
		if (!artifactId) throw new Error("Expected recovery artifact id");
		expect(reference.text).toBe(`\n[recover: artifact://${artifactId} (entry ${id})]`);
		const artifactPath = await manager.getArtifactPath(artifactId);
		if (!artifactPath) throw new Error("Expected full original archive after failed publish");
		const archive = JSON.parse(await fs.readFile(artifactPath, "utf8"));
		expect(archive.operation).toBe("drop-images");
		expect(archive.entries).toEqual([originalSnapshot]);
		expect(await artifacts.listFiles()).toHaveLength(artifactFiles.length + 1);
		expect(agent.state.messages).toEqual(liveMessages);
		expect(await fs.readFile(file, "utf8")).toBe(disk);
	});

	it("archives an otherwise useless tool result through the stale-prune path", async () => {
		const callId = "useless-stale-result";
		const call: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "src/unused.ts" } }],
			stopReason: "toolUse",
			usage: USAGE,
			timestamp: Date.now(),
		};
		manager.appendMessage(call);
		const id = manager.appendMessage({
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [
				{
					type: "text",
					text: Array.from({ length: 80 }, (_, index) => `No matches in section ${index + 1}.`).join("\n"),
				},
			],
			details: { path: "src/unused.ts", marker: "original" },
			isError: false,
			useless: true,
			timestamp: Date.now(),
		});
		await syncLiveMessages();
		const original = manager.getEntry(id);
		if (!original) throw new Error("Expected useless result before pruning");
		const originalSnapshot = structuredClone(original);

		const outcome = await rewrites.pruneStale();
		expect(outcome?.prunedCount).toBe(1);
		const reloaded = await SessionManager.open(file, temp.path(), undefined, { suppressBreadcrumb: true });
		try {
			const pruned = reloaded.getEntry(id);
			if (pruned?.type !== "message" || pruned.message.role !== "toolResult") {
				throw new Error("Expected useless result on disk after pruning");
			}
			expect(pruned.message.content[0]).toEqual({ type: "text", text: USELESS_NOTICE });
			const artifactId = JSON.stringify(pruned.message.content).match(/artifact:\/\/([^\s)]+)/)?.[1];
			if (!artifactId) throw new Error("Expected recovery pointer for useless result");
			const artifactPath = await reloaded.getArtifactPath(artifactId);
			if (!artifactPath) throw new Error("Expected useless-result archive on disk");
			const archive = JSON.parse(await fs.readFile(artifactPath, "utf8"));
			expect(archive.operation).toBe("prune-stale");
			expect(archive.entries).toEqual([originalSnapshot]);
			expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
		} finally {
			await reloaded.close();
		}
	});
});
