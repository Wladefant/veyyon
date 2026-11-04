/** Image-mode shrink must preserve the bytes, including nested result and file-mention images. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, ImageContent } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { HistoryRewrites } from "@veyyon/coding-agent/session/runtime/history-rewrites";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { FileSessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";

const IMAGE: ImageContent = { type: "image", data: "ZXhhY3QtaW1hZ2UtZml4dHVyZQ==", mimeType: "image/png" };
const USAGE = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("image removal keeps recoverable originals", () => {
	let temp: TempDir;
	let manager: SessionManager;
	let storage: FileSessionStorage;
	let rewrites: HistoryRewrites;
	let agent: Agent;
	let ids: string[];
	let file: string;

	beforeEach(async () => {
		temp = TempDir.createSync("@veyyon-image-recovery-");
		storage = new FileSessionStorage();
		manager = SessionManager.create(temp.path(), temp.path(), storage);
		const user = manager.appendMessage({
			role: "user", content: [{ type: "text", text: "Compare the supplied images." }, IMAGE], timestamp: Date.now(),
		});
		const assistant: AssistantMessage = {
			role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
			content: [{ type: "text", text: "I will inspect the evidence." }], stopReason: "stop", usage: USAGE, timestamp: Date.now(),
		};
		manager.appendMessage(assistant);
		const tool = manager.appendMessage({
			role: "toolResult", toolCallId: "image-read", toolName: "read", isError: false,
			content: [{ type: "text", text: "tool caption" }, IMAGE],
			details: { images: [IMAGE, { type: "text", text: "non-image detail" }], source: "fixture" }, timestamp: Date.now(),
		});
		const custom = manager.appendCustomMessageEntry("image-evidence", [IMAGE], false, { source: "extension" });
		const mention = manager.appendMessage({
			role: "fileMention", files: [{ path: "image.png", content: "file caption", image: IMAGE }], timestamp: Date.now(),
		});
		ids = [user, tool, custom, mention];
		await manager.flush();
		file = manager.getSessionFile()!;
		agent = new Agent({ initialState: { tools: [], systemPrompt: ["Test"], messages: manager.buildSessionContext().messages } });
		rewrites = new HistoryRewrites({
			sessionStore: manager, agent, settings: Settings.isolated(), withPlanProtection: config => config,
			model: () => undefined, keepBoundaryId: () => undefined, rebuiltMessages: () => manager.buildSessionContext().messages,
			resetAdvisorRuntimes: () => {}, closeCodexSessions: () => {}, markHistoryRewritten: () => {}, syncTodos: () => {},
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.close();
		await temp.remove();
	});

	it("image shake archives all original entry shapes and leaves references across reload", async () => {
		const originals = ids.map(id => JSON.parse(JSON.stringify(manager.getEntry(id))));
		const result = await rewrites.shake("images");
		expect(result.imagesDropped).toBe(5);
		const reloaded = await SessionManager.open(file, temp.path(), undefined, { suppressBreadcrumb: true });
		try {
			let archiveId: string | undefined;
			for (const id of ids) {
				const encoded = JSON.stringify(reloaded.getEntry(id));
				expect(encoded).not.toContain(IMAGE.data);
				const reference = encoded.match(/artifact:\/\/([^\s)]+)/)?.[1];
				if (!reference) throw new Error(`Missing recovery pointer on ${id}`);
				if (archiveId) expect(reference).toBe(archiveId);
				archiveId = reference;
				expect(encoded).toContain(`entry ${id}`);
			}
			const path = await reloaded.getArtifactPath(archiveId!);
			if (!path) throw new Error("Expected durable image archive");
			const archive = JSON.parse(await fs.readFile(path, "utf8"));
			expect(archive.operation).toBe("drop-images");
			expect(archive.entries).toEqual(originals);
			const tool = reloaded.getEntry(ids[1]);
			if (tool?.type !== "message" || tool.message.role !== "toolResult") throw new Error("Expected tool result");
			expect(tool.message.details).toEqual({ images: [{ type: "text", text: "non-image detail" }], source: "fixture" });
			expect(JSON.stringify(agent.state.messages)).toContain("artifact://");
			expect(agent.state.messages).toEqual(manager.buildSessionContext().messages);
		} finally { await reloaded.close(); }
		const disk = await fs.readFile(file, "utf8");
		expect(await rewrites.dropImages()).toEqual({ removed: 0 });
		expect(await fs.readFile(file, "utf8")).toBe(disk);
	});

	for (const fault of ["archive-id", "archive-write", "transcript-write"] as const) {
		it(`keeps user, result, custom and file-mention bytes when ${fault} fails`, async () => {
			const branch = JSON.stringify(manager.getBranch());
			const live = JSON.stringify(agent.state.messages);
			const disk = await fs.readFile(file, "utf8");
			if (fault === "archive-id") vi.spyOn(manager, "saveArtifact").mockResolvedValue(undefined);
			if (fault === "archive-write") vi.spyOn(manager, "saveArtifact").mockRejectedValue(new Error("image archive failure"));
			if (fault === "transcript-write") {
				vi.spyOn(storage, "writeTextAtomic").mockRejectedValue(new Error("image transcript failure"));
				vi.spyOn(storage, "rewriteTailAtomic").mockRejectedValue(new Error("image transcript failure"));
			}
			await expect(rewrites.dropImages()).rejects.toThrow();
			expect(JSON.stringify(manager.getBranch())).toBe(branch);
			expect(JSON.stringify(agent.state.messages)).toBe(live);
			expect(await fs.readFile(file, "utf8")).toBe(disk);
		});
	}

	it("does not apply an old image selection after a user changes the branch", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const save = manager.saveArtifact.bind(manager);
		vi.spyOn(manager, "saveArtifact").mockImplementation(async (content, type) => {
			entered.resolve(); await release.promise; return save(content, type);
		});
		const originals = ids.map(id => JSON.stringify(manager.getEntry(id)));
		const operation = rewrites.dropImages().then(() => null, error => error);
		await entered.promise;
		manager.appendMessage({ role: "user", content: "Keep the images available.", timestamp: Date.now() });
		release.resolve();
		expect(await operation).toBeInstanceOf(Error);
		expect(ids.map(id => JSON.stringify(manager.getEntry(id)))).toEqual(originals);
	});
});
