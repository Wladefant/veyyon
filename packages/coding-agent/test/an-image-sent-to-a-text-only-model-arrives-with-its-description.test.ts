/**
 * An image attached to a message for a text-only model keeps the image in the message and gains a
 * hidden description companion ahead of it, on every path a text message with images enters the
 * session: a prompt, a queued steer, a queued follow-up and a synthetic follow-up.
 *
 * The class: one of those paths building its content by hand and dropping the image, the companion,
 * or the order between them. Each path is driven through the public session method; the vision call
 * is the only stand-in, since it reaches a provider.
 *
 * What it does not catch: what the description says, which `image-vision-fallback.test.ts` owns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { Effort } from "@veyyon/catalog/effort";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import * as imageVisionFallback from "@veyyon/coding-agent/utils/image-vision-fallback";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeWithRetries } from "@veyyon/utils";
import { requireBundledModel } from "../../agent/test/helpers";

const RED_1X1_PNG: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

const DESCRIPTION = '<image path="local://red.png">a red square</image>';

/** Role, custom type and content part types of a message, which is what the order and shape rest on. */
function shape(message: AgentMessage): string {
	const kind = message.role === "custom" ? `custom:${message.customType}` : message.role;
	const content = "content" in message ? message.content : undefined;
	const parts = Array.isArray(content) ? content.map(part => part.type).join("+") : typeof content;
	return `${kind}[${parts}]`;
}

describe("an image sent to a text-only model", () => {
	let root: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	async function createSession(input: Model["input"]): Promise<AgentSession> {
		const bundled = requireBundledModel("anthropic", "claude-sonnet-4-5");
		const model: Model = { ...bundled, input };
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [], thinkingLevel: Effort.High },
		});
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const settings = Settings.isolated({ "images.describeForTextModels": true });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(root, "models.yml")),
		});
		return session;
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-image-description-"));
		vi.spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockResolvedValue([
			{ type: "text", text: DESCRIPTION },
		]);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		await removeWithRetries(root).catch(() => undefined);
		session = undefined;
		authStorage = undefined;
	});

	it("is prompted with the description ahead of the message that keeps the image", async () => {
		const created = await createSession(["text"]);
		const promptSpy = vi.spyOn(created.agent, "prompt").mockResolvedValue(undefined);

		await created.prompt("what is this", { images: [RED_1X1_PNG] });

		const sent = (promptSpy.mock.calls[0]![0] as unknown as AgentMessage[]).filter(
			message => message.role !== "custom" || message.customType !== "session-state",
		);
		expect(sent.map(shape)).toEqual(["custom:image-attachment-description[text]", "user[text+image]"]);
	});

	it("queues a steer and a follow-up with the description ahead of each", async () => {
		const created = await createSession(["text"]);
		const queued: AgentMessage[] = [];
		vi.spyOn(created.agent, "steer").mockImplementation(message => {
			queued.push(message);
		});
		vi.spyOn(created.agent, "followUp").mockImplementation(message => {
			queued.push(message);
		});

		await created.steer("look at this", [RED_1X1_PNG]);
		await created.followUp("and this", [RED_1X1_PNG]);
		await created.followUp("and once more", [RED_1X1_PNG], { synthetic: true });

		expect(queued.map(shape)).toEqual([
			"custom:image-attachment-description[text]",
			"user[text+image]",
			"custom:image-attachment-description[text]",
			"user[text+image]",
			"custom:image-attachment-description[text]",
			"developer[text+image]",
		]);
	});

	it("gains no description when the model reads images", async () => {
		const created = await createSession(["text", "image"]);
		const queued: AgentMessage[] = [];
		vi.spyOn(created.agent, "followUp").mockImplementation(message => {
			queued.push(message);
		});

		await created.followUp("what is this", [RED_1X1_PNG]);

		expect(queued.map(shape)).toEqual(["user[text+image]"]);
	});

	it("gains no description and no image part when no image is attached", async () => {
		const created = await createSession(["text"]);
		const queued: AgentMessage[] = [];
		vi.spyOn(created.agent, "steer").mockImplementation(message => {
			queued.push(message);
		});

		await created.steer("plain text");

		expect(queued.map(shape)).toEqual(["user[text]"]);
	});
});
