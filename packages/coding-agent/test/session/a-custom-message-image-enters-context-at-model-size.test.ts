/**
 * An image in a custom message enters the model context resized to the same bounds a prompt image
 * gets, each in its own place among the text parts.
 *
 * WHY. `sendCustomMessage` (and the extension, file-mention and mode-context paths beside it) runs
 * its content through `normalizeAgentMessageImages` before the message is queued or appended.
 * Nothing drove a session through it: the image helpers were covered alone, so skipping the
 * normalization, or writing every resized image into the first image's slot, passed every suite
 * while a 2000-pixel screenshot went to the provider at full size.
 *
 * WHAT IT DOES NOT CATCH. The streaming steer and follow-up branches share the normalized message
 * with the idle branch driven here; a branch that bypassed it would not be seen.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { ImageContent, TextContent } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** 1x1 red PNG, upscaled by the native encoder to the sizes under test. */
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** The longest edge a context image may have. */
const MAX_EDGE = 1568;

async function redPng(width: number, height: number): Promise<ImageContent> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const bytes = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return { type: "image", data: Buffer.from(bytes).toBase64(), mimeType: "image/png" };
}

async function size(image: ImageContent): Promise<{ width: number; height: number }> {
	const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
	return { width: metadata.width, height: metadata.height };
}

describe("a custom message image enters context at model size", () => {
	let session: AgentSession | undefined;
	let dir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		dir = TempDir.createSync("@custom-message-image-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		authStorage.close();
		await dir.remove();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("resizes each image in place and leaves the text parts as written", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected a bundled anthropic model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const wide = await redPng(3000, 1000);
		const tall = await redPng(1000, 3000);

		await session.sendCustomMessage({
			customType: "screenshot",
			content: [{ type: "text", text: "before" }, wide, { type: "text", text: "between" }, tall],
			display: true,
		});

		const last = session.agent.state.messages.at(-1);
		if (last?.role !== "custom" || typeof last.content === "string") throw new Error("Expected the custom message");
		const parts = last.content as (TextContent | ImageContent)[];
		expect(parts.map(part => (part.type === "text" ? part.text : part.type))).toEqual([
			"before",
			"image",
			"between",
			"image",
		]);
		const [first, second] = await Promise.all([size(parts[1] as ImageContent), size(parts[3] as ImageContent)]);
		expect(Math.max(first.width, first.height)).toBeLessThanOrEqual(MAX_EDGE);
		expect(Math.max(second.width, second.height)).toBeLessThanOrEqual(MAX_EDGE);
		expect(first.width).toBeGreaterThan(first.height);
		expect(second.height).toBeGreaterThan(second.width);
	});
});
