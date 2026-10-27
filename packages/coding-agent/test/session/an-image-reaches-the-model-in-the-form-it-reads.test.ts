/**
 * An image reaches the model in the form it reads: the images a tool addresses are the newest
 * message's, every image a prompt or a custom message carries is encoded for the active model, and a
 * text-only model reads a hidden description in the image's place, produced under the session's own
 * identity and saved where the session's `local://` resolves.
 *
 * WHY: the image normalization, the text-only description and the latest-attachment lookup moved out
 * of `AgentSession` into the `ImageAttachments` collaborator (`session/runtime/image-attachments.ts`).
 * A mutation sweep of that move found most of it unpinned: reading the oldest message's images,
 * skipping developer messages, stopping at a newer message with no image, normalizing for no model
 * (so WebP reaches a model that cannot decode it), handing `before_agent_start` the raw images,
 * ignoring `images.blockImages` or `images.describeForTextModels`, letting a failed vision call fail
 * the prompt, sending an empty description, showing it, attributing it to the agent, and dropping the
 * session's telemetry, id, model string or `local://` root from the vision call all left every suite
 * green. Each case below fails on one of them.
 *
 * Driven through a real `AgentSession`. The stand-ins are the agent's `prompt`, which records what
 * the session hands it instead of calling a provider, the vision call's `completeImpl`, and, where the
 * description's text is not the subject, the description itself.
 *
 * NOT CAUGHT: an @-mentioned image. Its message holds the image in `files`, not `content`, so
 * normalizing that message changes nothing and no case here can tell it from skipping it. What the
 * description says is owned by `image-vision-fallback.test.ts`; its order against the message by
 * `an-image-sent-to-a-text-only-model-arrives-with-its-description.test.ts`; the resize bounds by
 * `a-custom-message-image-enters-context-at-model-size.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions";
import type { ExtensionRuntime } from "@veyyon/coding-agent/extensibility/extensions/types";
import { resolveLocalUrlToPath } from "@veyyon/coding-agent/internal-urls/local-protocol";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import * as imageVisionFallback from "@veyyon/coding-agent/utils/image-vision-fallback";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const RED_1X1_PNG: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

const DESCRIPTION = '<image path="local://red.png">a red square</image>';
const DESCRIPTION_TYPE = "image-attachment-description";

/** A 200x200 red WebP, encoded at test time so no binary fixture is checked in. */
async function redWebp(): Promise<ImageContent> {
	const bytes = await new Bun.Image(Buffer.from(RED_1X1_PNG.data, "base64"))
		.resize(200, 200, { filter: "nearest" })
		.webp({ quality: 90 })
		.bytes();
	return { type: "image", data: Buffer.from(bytes).toBase64(), mimeType: "image/webp" };
}

/** An image block whose bytes are never decoded, told apart by `data`. */
function marker(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function sonnet(overrides: Partial<Model> = {}): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic/claude-sonnet-4-5 model");
	return { ...model, ...overrides };
}

/** The image parts of every message the session handed the agent, in order. */
function sentImages(sent: readonly AgentMessage[]): ImageContent[] {
	return sent.flatMap(message => {
		const content = "content" in message ? message.content : undefined;
		return Array.isArray(content) ? content.filter((part): part is ImageContent => part.type === "image") : [];
	});
}

function descriptions(sent: readonly AgentMessage[]): AgentMessage[] {
	return sent.filter(message => message.role === "custom" && message.customType === DESCRIPTION_TYPE);
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	/** Every message the session handed the agent to start a turn with, in order. */
	sent: AgentMessage[];
	/** The images each `before_agent_start` was emitted with. */
	extensionImages: (ImageContent[] | undefined)[];
}

interface HarnessOptions {
	model: Model;
	settings?: Partial<Record<SettingPath, unknown>>;
	/** A session with a file, so it has an artifacts directory for `local://`. */
	fileBacked?: boolean;
}

describe("an image reaches the model in the form it reads", () => {
	let tempDir: TempDir;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-image-attachments-");
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	async function createHarness(options: HarnessOptions): Promise<Harness> {
		const root = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(root, `auth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, `models-${cleanups.length}.yml`));
		const sessionManager = options.fileBacked
			? SessionManager.create(root, path.join(root, "sessions"))
			: SessionManager.inMemory(root);
		const extensionImages: (ImageContent[] | undefined)[] = [];
		const extensionRunner = new ExtensionRunner([], {} as ExtensionRuntime, root, sessionManager, modelRegistry);
		spyOn(extensionRunner, "emitBeforeAgentStart").mockImplementation(async (_prompt, images) => {
			extensionImages.push(images);
			return undefined;
		});
		const agent = new Agent({
			initialState: { model: options.model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		const sent: AgentMessage[] = [];
		spyOn(agent, "prompt").mockImplementation(async (input: string | AgentMessage | AgentMessage[]) => {
			if (typeof input !== "string") sent.push(...(Array.isArray(input) ? input : [input]));
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, ...options.settings }),
			modelRegistry,
			extensionRunner,
		});
		cleanups.push(
			() => authStorage.close(),
			() => session.dispose(),
		);
		return { session, sessionManager, sent, extensionImages };
	}

	describe("the images a tool addresses", () => {
		it("are the newest message's, numbered from 1", async () => {
			const { session } = await createHarness({ model: sonnet() });
			const [older, first, second] = [marker("older"), marker("first"), marker("second")];
			session.agent.replaceMessages([
				{ role: "user", content: [{ type: "text", text: "one" }, older], timestamp: 1 },
				{ role: "user", content: [{ type: "text", text: "two" }, first, second], timestamp: 2 },
				createAssistantMessage("seen"),
			]);

			expect(session.getImageAttachments()).toEqual([
				{ label: "Image #1", uri: "attachment://1", image: first },
				{ label: "Image #2", uri: "attachment://2", image: second },
			]);
		});

		it("include a developer message's", async () => {
			const { session } = await createHarness({ model: sonnet() });
			const [older, synthetic] = [marker("older"), marker("synthetic")];
			session.agent.replaceMessages([
				{ role: "user", content: [{ type: "text", text: "one" }, older], timestamp: 1 },
				{ role: "developer", content: [{ type: "text", text: "two" }, synthetic], timestamp: 2 },
			]);

			expect(session.getImageAttachments().map(attachment => attachment.image)).toEqual([synthetic]);
		});

		it("pass over a newer message that carries none", async () => {
			const { session } = await createHarness({ model: sonnet() });
			const older = marker("older");
			session.agent.replaceMessages([
				{ role: "user", content: [{ type: "text", text: "one" }, older], timestamp: 1 },
				{ role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 },
			]);

			expect(session.getImageAttachments().map(attachment => attachment.image)).toEqual([older]);
		});
	});

	describe("an image is encoded for the model that reads it", () => {
		// `resizeImage` reads VEYYON_NO_WEBP itself; with it set, every model loses WebP and the
		// cases below could not tell a model-aware encoder from a blanket one.
		let noWebp: string | undefined;
		beforeEach(() => {
			noWebp = process.env.VEYYON_NO_WEBP;
			delete process.env.VEYYON_NO_WEBP;
		});
		afterEach(() => {
			if (noWebp === undefined) delete process.env.VEYYON_NO_WEBP;
			else process.env.VEYYON_NO_WEBP = noWebp;
		});

		/** A vision model whose decoder cannot read WebP. */
		const stbModel = () => sonnet({ input: ["text", "image"], imageInputDecoder: "stb" });

		it("keeps WebP for a model that decodes it", async () => {
			const { session, sent } = await createHarness({ model: sonnet({ input: ["text", "image"] }) });

			await session.prompt("what is this", { images: [await redWebp()] });

			expect(sentImages(sent).map(image => image.mimeType)).toEqual(["image/webp"]);
		});

		it("re-encodes a prompt image out of WebP for a model that cannot decode it", async () => {
			const { session, sent } = await createHarness({ model: stbModel() });

			await session.prompt("what is this", { images: [await redWebp()] });

			const mimeTypes = sentImages(sent).map(image => image.mimeType);
			expect(mimeTypes).toHaveLength(1);
			expect(["image/png", "image/jpeg"]).toContain(mimeTypes[0]);
		});

		it("hands before_agent_start the images the model receives", async () => {
			const { session, sent, extensionImages } = await createHarness({ model: stbModel() });

			await session.prompt("what is this", { images: [await redWebp()] });

			expect(extensionImages).toEqual([sentImages(sent)]);
		});

		it("re-encodes a custom message image out of WebP for a model that cannot decode it", async () => {
			const { session } = await createHarness({ model: stbModel() });

			await session.sendCustomMessage({
				customType: "screenshot",
				content: [{ type: "text", text: "shot" }, await redWebp()],
				display: true,
			});

			const last = session.agent.state.messages.at(-1);
			if (last?.role !== "custom") throw new Error("Expected the custom message last");
			const mimeTypes = sentImages([last]).map(image => image.mimeType);
			expect(mimeTypes).toHaveLength(1);
			expect(["image/png", "image/jpeg"]).toContain(mimeTypes[0]);
		});
	});

	describe("a text-only model reads a description in the image's place", () => {
		const textOnly = () => sonnet({ input: ["text"] });

		async function promptWithDescriber(
			describer: () => Promise<{ type: "text"; text: string }[]>,
			settings: Partial<Record<SettingPath, unknown>> = { "images.describeForTextModels": true },
		): Promise<AgentMessage[]> {
			spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementation(describer);
			const { session, sent } = await createHarness({ model: textOnly(), settings });
			await session.prompt("what is this", { images: [RED_1X1_PNG] });
			return sent;
		}

		it("is hidden from the transcript and attributed to the user", async () => {
			const sent = await promptWithDescriber(async () => [{ type: "text", text: DESCRIPTION }]);

			expect(
				descriptions(sent).map(message =>
					message.role === "custom"
						? { display: message.display, attribution: message.attribution, content: message.content }
						: message.role,
				),
			).toEqual([{ display: false, attribution: "user", content: [{ type: "text", text: DESCRIPTION }] }]);
		});

		it("is not produced while images are blocked", async () => {
			const sent = await promptWithDescriber(async () => [{ type: "text", text: DESCRIPTION }], {
				"images.describeForTextModels": true,
				"images.blockImages": true,
			});

			expect(descriptions(sent)).toEqual([]);
		});

		it("is not produced while describing is off", async () => {
			const sent = await promptWithDescriber(async () => [{ type: "text", text: DESCRIPTION }], {
				"images.describeForTextModels": false,
			});

			expect(descriptions(sent)).toEqual([]);
		});

		it("is left out when the vision call fails, and the prompt still goes", async () => {
			const sent = await promptWithDescriber(async () => {
				throw new Error("vision provider down");
			});

			expect(descriptions(sent)).toEqual([]);
			expect(sentImages(sent)).toHaveLength(1);
		});

		it("is left out when the vision call describes nothing", async () => {
			const sent = await promptWithDescriber(async () => []);

			expect(descriptions(sent)).toEqual([]);
			expect(sentImages(sent)).toHaveLength(1);
		});

		it("is requested under the session's identity, from the model the session names", async () => {
			const describe = imageVisionFallback.describeAttachedImagesForTextModel;
			const asked: string[] = [];
			spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementation((images, deps) =>
				describe(images, {
					...deps,
					completeImpl: async model => {
						asked.push(`${model.provider}/${model.id}`);
						return createAssistantMessage("a red square");
					},
				}),
			);
			const spans: { model: string | undefined; conversationId: string | undefined }[] = [];
			const { session, sent } = await createHarness({
				model: textOnly(),
				settings: { "images.describeForTextModels": true },
			});
			session.agent.setTelemetry({
				onSpanStart: ctx => spans.push({ model: ctx.model?.id, conversationId: ctx.conversationId }),
			});

			await session.prompt("what is this", { images: [RED_1X1_PNG] });

			// No vision helper and no default model are configured, so the session's own model string is
			// the candidate, resolved to the catalog entry that reads images.
			expect(asked).toEqual(["anthropic/claude-sonnet-4-5"]);
			expect(spans).toEqual([{ model: "claude-sonnet-4-5", conversationId: session.sessionId }]);
			expect(descriptions(sent)).toHaveLength(1);
		});

		it("names a local:// file the session resolves to the saved image", async () => {
			const describe = imageVisionFallback.describeAttachedImagesForTextModel;
			spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementation((images, deps) =>
				describe(images, { ...deps, completeImpl: async () => createAssistantMessage("a red square") }),
			);
			const { session, sessionManager, sent } = await createHarness({
				model: textOnly(),
				settings: { "images.describeForTextModels": true },
				fileBacked: true,
			});

			await session.prompt("what is this", { images: [RED_1X1_PNG] });

			const [description] = descriptions(sent);
			const text =
				description?.role === "custom" && Array.isArray(description.content)
					? description.content.map(part => (part.type === "text" ? part.text : "")).join("")
					: "";
			const url = /<image path="(local:\/\/[^"]+)">/.exec(text)?.[1];
			if (!url) throw new Error(`Expected a local:// image path in ${JSON.stringify(text)}`);
			const saved = resolveLocalUrlToPath(url, {
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			});
			const artifactsDir = sessionManager.getArtifactsDir();
			if (!artifactsDir) throw new Error("Expected a file-backed session to have an artifacts directory");
			expect(saved.startsWith(artifactsDir + path.sep)).toBe(true);
			expect((await fs.readFile(saved)).toBase64()).toBe(sentImages(sent)[0]?.data);
		});
	});
});
