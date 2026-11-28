/**
 * Older user-attached screenshots in outbound requests compact into durable cached vision
 * summaries once N later genuine user turns follow, while keeping recent screenshots, original
 * transcripts, non-image text, and non-eligible / failed / no-vision images intact.
 *
 * WHY THIS SUITE EXISTS. Long sessions carrying pasted screenshots quickly accumulate image
 * blocks across turns, hitting provider per-request caps or wasting prompt context even after
 * the conversation has moved several turns past the screenshot. Replacing only older user-attached
 * request pixels with a durably cached summary — generated through the session's own side-request
 * transport and governed by the current request model's vision policy — cuts outbound image bloat
 * without altering the recorded transcript or touching tool/synthetic/uncertain images.
 *
 * ELIGIBILITY BOUNDARY PINNED HERE:
 *   - Eligible: `UserMessage` (`role === "user"`) with `attribution === "user"`, `synthetic !== true`,
 *     no `demotedReasoningSource`, no `historyRewriteAt`, no `providerPayload`, and not derived from
 *     `fileMention`, `custom`, `hookMessage`, or `skill-prompt` in `convertToLlm`.
 *   - Excluded (pixels preserved): `toolResult`, `developer`, `assistant`, `fileMention`, `custom`,
 *     `hookMessage`, `synthetic: true`, `attribution: "agent"`, `attribution: undefined` (uncertain
 *     provenance), and `providerPayload`-bearing messages. Only eligible genuine user turns count
 *     toward `N`.
 *
 * SYNTHETIC VERIFICATION NOTE: all provider and side-summary calls in this suite use local
 * `streamFn` / `sideStreamFn` stubs and `1x1` synthetic PNG fixtures; no live provider traffic or
 * production token-savings numbers are measured or claimed.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, Context, ImageContent, Message, Model, TextContent, UserMessage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { canonicalizeImageContent, resizeImage } from "@veyyon/coding-agent/utils/image-resize";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";
import { createAssistantMessage } from "../helpers/agent-session-setup";

const RED_1X1_PNG: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

const BLUE_1X1_PNG: ImageContent = {
	type: "image",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
	mimeType: "image/png",
};

const BLOCKED_TEXT = "Image reading is disabled.";
const NO_VISION_TEXT = "[image omitted: the model serving this request does not support image input]";

interface RecordedRequest {
	readonly model: Model;
	readonly context: Context;
}

function visionModel(overrides: Partial<Model> = {}): Model {
	const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
	return { ...model, input: ["text", "image"], ...overrides };
}

function textOnlyModel(): Model {
	const found = requireBundledModel("anthropic", "claude-sonnet-4-5");
	return { ...found, id: "mock-text-only", input: ["text"] };
}

function makeStream(reply: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			...createAssistantMessage(reply),
			stopReason,
			...(stopReason === "error" ? { errorMessage: "summary failed" } : {}),
		};
		if (reply.length > 0) {
			stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
		}
		if (stopReason === "error") {
			stream.push({ type: "error", reason: "error", error: message });
		} else {
			stream.push({ type: "done", reason: stopReason === "aborted" ? "aborted" : "stop", message });
		}
	});
	return stream;
}

function imageBlocks(message: Message | { content?: unknown }): ImageContent[] {
	if (!("content" in message) || !Array.isArray(message.content)) return [];
	return message.content.filter((part): part is ImageContent => part.type === "image");
}

function textBlocks(message: Message | { content?: unknown }): string[] {
	if (!("content" in message)) return [];
	if (typeof message.content === "string") return [message.content];
	if (!Array.isArray(message.content)) return [];
	return message.content.filter((part): part is TextContent => part.type === "text").map(part => part.text);
}

describe("automatic user screenshot compaction", () => {
	let tempDir: TempDir;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-screenshot-compaction-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		tempDir.removeSync();
	});

	async function createHarness(
		options: {
			model?: Model;
			settings?: Record<string, unknown>;
			fileBacked?: boolean;
			sessionManager?: SessionManager;
			authStorage?: AuthStorage;
			withApiKey?: boolean;
			sideHandler?: (request: RecordedRequest) => AssistantMessageEventStream;
		} = {},
	) {
		const root = tempDir.path();
		const authStorage =
			options.authStorage ?? (await AuthStorage.create(path.join(root, `auth-${cleanups.length}.db`)));
		const model = options.model ?? visionModel();
		if (options.withApiKey !== false) {
			authStorage.setRuntimeApiKey(model.provider, "test-key");
		}
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, `models-${cleanups.length}.yml`));
		const sessionManager =
			options.sessionManager ??
			(options.fileBacked
				? SessionManager.create(root, path.join(root, "sessions"))
				: SessionManager.inMemory(root));

		const mainRequests: RecordedRequest[] = [];
		const sideRequests: RecordedRequest[] = [];

		const mainStreamFn: StreamFn = (requestModel, context) => {
			mainRequests.push({ model: requestModel, context });
			return makeStream(`reply-${mainRequests.length}`);
		};

		const blueVariants = new Set<string>([BLUE_1X1_PNG.data]);
		const blueCanonical = await canonicalizeImageContent(BLUE_1X1_PNG);
		blueVariants.add(blueCanonical.data);
		const blueResized = await resizeImage(BLUE_1X1_PNG);
		blueVariants.add(blueResized.data);
		blueVariants.add(
			(await canonicalizeImageContent({ type: "image", data: blueResized.data, mimeType: blueResized.mimeType }))
				.data,
		);

		const sideStreamFn: StreamFn = (requestModel, context) => {
			const recorded = { model: requestModel, context };
			sideRequests.push(recorded);
			if (options.sideHandler) return options.sideHandler(recorded);
			const img = context.messages
				.flatMap(m => (Array.isArray(m.content) ? m.content : []))
				.find((part): part is ImageContent => part.type === "image");
			const tag = img && blueVariants.has(img.data) ? "Blue 1x1 pixel panel." : "Red 1x1 pixel dialog.";
			return makeStream(tag);
		};

		let transformHook: ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
		const initialMessages = options.sessionManager ? options.sessionManager.buildSessionContext().messages : [];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: initialMessages },
			streamFn: mainStreamFn,
		});
		const installTransform = agent.setTransformProviderContext.bind(agent);
		agent.setTransformProviderContext = fn => {
			transformHook = fn ?? undefined;
			installTransform(fn);
		};
		const settings = Settings.isolated({
			"compaction.enabled": false,
			...(options.settings as Partial<Record<SettingPath, unknown>>),
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			sideStreamFn,
		});

		cleanups.push(
			() => session.dispose(),
			() => {
				if (!options.authStorage) authStorage.close();
			},
		);

		return {
			session,
			sessionManager,
			settings,
			authStorage,
			modelRegistry,
			mainRequests,
			sideRequests,
			transformHook,
			blueVariants,
		};
	}

	it("keeps original pixels by default when a later turn asks for a visual detail", async () => {
		const { session, mainRequests, sideRequests } = await createHarness({ fileBacked: true });
		await session.prompt("Review this report", { images: [RED_1X1_PNG] });
		const original = imageBlocks(mainRequests[0]!.context.messages.find(m => m.role === "user")!);

		await session.prompt("Summarize the overall result");
		await session.prompt("List the unresolved items");
		await session.prompt("What exact number is in the lower-right corner?");

		const firstUser = mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!;
		expect(imageBlocks(firstUser)).toEqual(original);
		expect(sideRequests).toHaveLength(0);
	});

	it("keeps original pixels in an in-memory session even when compaction is enabled", async () => {
		const { session, sessionManager, mainRequests, sideRequests } = await createHarness({
			settings: { "images.compactAfterTurns": 1 },
		});
		await session.prompt("Review this report", { images: [RED_1X1_PNG] });
		const original = imageBlocks(mainRequests[0]!.context.messages.find(m => m.role === "user")!);
		await session.prompt("Prepare the next report");

		const firstUser = mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!;
		expect(imageBlocks(firstUser)).toEqual(original);
		expect(sideRequests).toHaveLength(0);
		expect(
			sessionManager
				.getBranch()
				.some(entry => entry.type === "custom" && entry.customType === "screenshot-compaction-summary"),
		).toBe(false);
	});

	it("restores cached screenshot pixels for an explicit visual follow-up in an opted-in session", async () => {
		const { session, mainRequests } = await createHarness({
			fileBacked: true,
			settings: { "images.compactAfterTurns": 1 },
		});
		await session.prompt("Review this report", { images: [RED_1X1_PNG] });
		const original = imageBlocks(mainRequests[0]!.context.messages.find(m => m.role === "user")!);

		await session.prompt("Prepare the next report");
		expect(imageBlocks(mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toEqual([]);

		for (const prompt of ["What exact number was shown in my first screenshot?", "Use that number in the answer"]) {
			await session.prompt(prompt);
			expect(imageBlocks(mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toEqual(original);
		}
	});

	it("keeps recent screenshots intact and compacts older user screenshots after default N=3 later user turns", async () => {
		const { session, sessionManager, mainRequests, sideRequests } = await createHarness();

		await session.prompt("check this bug", { images: [RED_1X1_PNG] });
		const attachedTurn0 = imageBlocks(mainRequests[0]!.context.messages.find(m => m.role === "user")!);
		expect(attachedTurn0).toHaveLength(1);
		expect(sideRequests).toHaveLength(0);

		await session.prompt("follow-up 1");
		await session.prompt("follow-up 2");
		// Still only 2 later user turns (< default 3): pixels must remain intact.
		const reqBeforeThreshold = mainRequests.at(-1)!.context.messages;
		expect(imageBlocks(reqBeforeThreshold.find(m => m.role === "user")!)).toHaveLength(1);
		expect(sideRequests).toHaveLength(0);

		// 3rd later user turn crosses default threshold (N=3).
		await session.prompt("follow-up 3");
		expect(sideRequests).toHaveLength(1);

		const reqAtThreshold = mainRequests.at(-1)!.context.messages;
		const firstOutboundUser = reqAtThreshold.find(m => m.role === "user")!;
		expect(imageBlocks(firstOutboundUser)).toEqual([]);
		const texts = textBlocks(firstOutboundUser);
		expect(texts[0]).toBe("check this bug");
		expect(texts.some(t => t.includes("Red 1x1 pixel dialog."))).toBe(true);

		// Original transcript & live agent messages remain completely untouched.
		const firstLiveUser = session.messages.find(m => m.role === "user")!;
		expect(imageBlocks(firstLiveUser)).toHaveLength(1);
		expect(imageBlocks(firstLiveUser)[0]!.data).toBe(attachedTurn0[0]!.data);

		const branchCustomTypes = sessionManager
			.getBranch()
			.filter(entry => entry.type === "custom")
			.map(entry => entry.customType);
		expect(branchCustomTypes).toContain("screenshot-compaction-summary");

		// Turn 4 reuses cached summary with zero additional side-summary calls and identical bytes.
		await session.prompt("follow-up 4");
		expect(sideRequests).toHaveLength(1);
		const firstOutboundOnTurn4 = mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!;
		expect(textBlocks(firstOutboundOnTurn4)).toEqual(texts);
	});

	it("respects configurable N, disables at 0, and bounds extreme values", async () => {
		// N=1 compacts as soon as 1 later user turn arrives, keeping the new turn's screenshot live.
		const oneTurn = await createHarness({ settings: { "images.compactAfterTurns": 1 } });
		await oneTurn.session.prompt("shot one", { images: [RED_1X1_PNG] });
		await oneTurn.session.prompt("shot two", { images: [BLUE_1X1_PNG] });
		const attachedSecondTurn = imageBlocks(oneTurn.session.messages.filter(m => m.role === "user")[1]!);
		expect(attachedSecondTurn).toHaveLength(1);

		const users = oneTurn.mainRequests.at(-1)!.context.messages.filter(m => m.role === "user");
		expect(imageBlocks(users[0]!)).toEqual([]);
		expect(textBlocks(users[0]!).some(t => t.includes("Red 1x1 pixel dialog."))).toBe(true);
		expect(imageBlocks(users[1]!)).toHaveLength(1);
		expect(imageBlocks(users[1]!)[0]!.data).toBe(attachedSecondTurn[0]!.data);

		// N=0 disables screenshot compaction completely.
		const disabled = await createHarness({ settings: { "images.compactAfterTurns": 0 } });
		await disabled.session.prompt("shot off", { images: [RED_1X1_PNG] });
		await disabled.session.prompt("t1");
		await disabled.session.prompt("t2");
		await disabled.session.prompt("t3");
		await disabled.session.prompt("t4");
		expect(disabled.sideRequests).toHaveLength(0);
		expect(imageBlocks(disabled.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toHaveLength(1);

		// Oversized configured value is clamped to the upper bound (100), not rejected or overflowing.
		const clamped = await createHarness({ settings: { "images.compactAfterTurns": 999 } });
		await clamped.session.prompt("shot clamped", { images: [RED_1X1_PNG] });
		await clamped.session.prompt("t1");
		await clamped.session.prompt("t2");
		expect(clamped.sideRequests).toHaveLength(0);
		expect(imageBlocks(clamped.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toHaveLength(1);
	});

	it("deduplicates identical image hashes and reuses persisted summaries across session reload", async () => {
		const first = await createHarness({
			fileBacked: true,
			settings: { "images.compactAfterTurns": 1 },
		});

		// Same image bytes attached twice in one prompt -> only 1 vision summary call.
		await first.session.prompt("dup shots", { images: [RED_1X1_PNG, RED_1X1_PNG] });
		await first.session.prompt("next turn");
		expect(first.sideRequests).toHaveLength(1);
		const firstOutbound = first.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!;
		expect(imageBlocks(firstOutbound)).toEqual([]);
		expect(textBlocks(firstOutbound).filter(t => t.includes("Red 1x1 pixel dialog."))).toHaveLength(2);

		await first.sessionManager.flush();
		const sessionFile = first.sessionManager.getSessionFile()!;
		await first.session.dispose();
		// Reopen persisted session on disk and run another turn -> zero new side summary calls.
		const reopenedManager = await SessionManager.open(sessionFile);
		const second = await createHarness({
			sessionManager: reopenedManager,
			settings: { "images.compactAfterTurns": 1 },
		});
		// Reloaded session transcript still keeps original pixels intact.
		const reloadedLiveUser = second.session.messages.find(m => m.role === "user")!;
		expect(imageBlocks(reloadedLiveUser)).toHaveLength(2);

		await second.session.prompt("after resume");
		expect(second.sideRequests).toHaveLength(0);
		const resumedOutbound = second.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!;
		expect(imageBlocks(resumedOutbound)).toEqual([]);
		expect(textBlocks(resumedOutbound).some(t => t.includes("Red 1x1 pixel dialog."))).toBe(true);
	});

	it("restricts eligibility to reliable user attachments and excludes toolResult, developer, synthetic, agent, uncertain, and derived messages", async () => {
		const { session, mainRequests, sideRequests } = await createHarness({
			settings: { "images.compactAfterTurns": 1 },
		});

		const syntheticUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "synthetic" }, RED_1X1_PNG],
			synthetic: true,
			attribution: "user",
			timestamp: 1,
		};
		const agentUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "agent-user" }, RED_1X1_PNG],
			attribution: "agent",
			timestamp: 2,
		};
		const uncertainUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "uncertain" }, RED_1X1_PNG],
			timestamp: 3,
		};
		const responsesPayloadUser: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "responses-payload" }, RED_1X1_PNG],
			attribution: "user",
			providerPayload: { provider: "openai", items: [] },
			timestamp: 4,
		};
		const derivedFromCustomAndMention = convertToLlm([
			{
				role: "fileMention",
				files: [{ path: "shot.png", content: "", image: RED_1X1_PNG }],
				timestamp: 5,
			},
			{
				role: "custom",
				customType: "ext-shot",
				content: [{ type: "text", text: "ext" }, RED_1X1_PNG],
				display: true,
				attribution: "user",
				timestamp: 6,
			},
		]);
		expect(derivedFromCustomAndMention.filter(m => m.role === "user")).toHaveLength(2);

		session.agent.replaceMessages([
			{
				role: "user",
				content: [{ type: "text", text: "eligible user shot" }, BLUE_1X1_PNG],
				attribution: "user",
				timestamp: 0,
			},
			syntheticUser,
			agentUser,
			uncertainUser,
			responsesPayloadUser,
			{ role: "developer", content: [{ type: "text", text: "dev" }, RED_1X1_PNG], timestamp: 7 },
			{
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "read",
				content: [{ type: "text", text: "tool" }, RED_1X1_PNG],
				isError: false,
				timestamp: 8,
			},
			{
				role: "fileMention",
				files: [{ path: "shot.png", content: "", image: RED_1X1_PNG }],
				timestamp: 9,
			},
			{
				role: "custom",
				customType: "ext-shot",
				content: [{ type: "text", text: "ext" }, RED_1X1_PNG],
				display: true,
				attribution: "user",
				timestamp: 10,
			},
		]);

		// Send 1 genuine user turn; only the 1 eligible user attachment should compact.
		// Non-eligible messages must keep their pixels and NOT inflate turn count before this prompt.
		await session.prompt("check remaining");

		expect(sideRequests).toHaveLength(1);
		const sent = mainRequests.at(-1)!.context.messages;
		const eligibleOut = sent.find(m => m.role === "user")!;
		expect(imageBlocks(eligibleOut)).toEqual([]);
		expect(textBlocks(eligibleOut).some(t => t.includes("Blue 1x1 pixel panel."))).toBe(true);

		// Every ineligible message retains its image block.
		const eligibleIndex = sent.indexOf(eligibleOut);
		for (let i = eligibleIndex + 1; i < sent.length - 1; i++) {
			const msg = sent[i]!;
			if (msg.role === "assistant") continue;
			if (msg.role === "developer" && textBlocks(msg).every(t => t.includes("<session_state"))) continue;
			if (msg.role === "developer" && textBlocks(msg).some(t => t === "ext")) continue;
			expect(imageBlocks(msg)).toHaveLength(1);
		}
	});

	it("honors current model no-vision and images.blockImages policies without a second model client", async () => {
		const noVision = await createHarness({
			model: textOnlyModel(),
			settings: { "images.compactAfterTurns": 1, "images.describeForTextModels": false },
		});
		await noVision.session.prompt("shot", { images: [RED_1X1_PNG] });
		await noVision.session.prompt("later");
		expect(noVision.sideRequests).toHaveLength(0);
		expect(textBlocks(noVision.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toContain(
			NO_VISION_TEXT,
		);

		const blocked = await createHarness({
			settings: { "images.compactAfterTurns": 1, "images.blockImages": true },
		});
		await blocked.session.prompt("shot", { images: [RED_1X1_PNG] });
		await blocked.session.prompt("later");
		expect(blocked.sideRequests).toHaveLength(0);
		expect(textBlocks(blocked.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toContain(
			BLOCKED_TEXT,
		);
	});

	it("preserves pixels on summarization failure, missing API key, or durable persistence failure, and handles partial multi-image failure", async () => {
		// 1. Vision summary error preserves pixels.
		const errorRun = await createHarness({
			settings: { "images.compactAfterTurns": 1 },
			sideHandler: () => makeStream("", "error"),
		});
		await errorRun.session.prompt("keep on error", { images: [RED_1X1_PNG] });
		await errorRun.session.prompt("later");
		expect(imageBlocks(errorRun.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toHaveLength(1);

		// 2. Missing API key preserves pixels and skips vision call.
		const noKey = await createHarness({
			settings: { "images.compactAfterTurns": 1 },
			withApiKey: false,
		});
		const shaped = await noKey.transformHook?.(
			{
				systemPrompt: ["Test"],
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "no key" }, RED_1X1_PNG],
						attribution: "user",
						timestamp: 1,
					},
					{ role: "user", content: [{ type: "text", text: "later" }], attribution: "user", timestamp: 2 },
				],
				tools: [],
			},
			visionModel(),
		);
		expect(noKey.sideRequests).toHaveLength(0);
		expect(imageBlocks(shaped!.messages[0]!)).toHaveLength(1);

		// 3. Durable persistence failure preserves pixels.
		const persistFail = await createHarness({
			settings: { "images.compactAfterTurns": 1 },
		});
		spyOn(persistFail.sessionManager, "flush").mockRejectedValue(new Error("disk full"));
		await persistFail.session.prompt("keep on flush fail", { images: [RED_1X1_PNG] });
		await persistFail.session.prompt("later");
		expect(persistFail.sideRequests).toHaveLength(1);
		expect(imageBlocks(persistFail.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!)).toHaveLength(
			1,
		);

		// 4. Partial multi-image failure: RED succeeds & compacts, BLUE fails & keeps pixels.
		const partialBlueVariants = new Set<string>([BLUE_1X1_PNG.data]);
		partialBlueVariants.add((await canonicalizeImageContent(BLUE_1X1_PNG)).data);
		const partialBlueResized = await resizeImage(BLUE_1X1_PNG);
		partialBlueVariants.add(partialBlueResized.data);
		partialBlueVariants.add(
			(
				await canonicalizeImageContent({
					type: "image",
					data: partialBlueResized.data,
					mimeType: partialBlueResized.mimeType,
				})
			).data,
		);
		const partial = await createHarness({
			settings: { "images.compactAfterTurns": 1 },
			sideHandler: ({ context }) => {
				const img = context.messages
					.flatMap(m => (Array.isArray(m.content) ? m.content : []))
					.find((part): part is ImageContent => part.type === "image");
				if (img && partialBlueVariants.has(img.data)) return makeStream("", "error");
				return makeStream("Red succeeded.");
			},
		});
		await partial.session.prompt("two shots", { images: [RED_1X1_PNG, BLUE_1X1_PNG] });
		await partial.session.prompt("later");
		const partialFirst = partial.mainRequests.at(-1)!.context.messages.find(m => m.role === "user")!;
		expect(textBlocks(partialFirst)[0]).toBe("two shots");
		expect(textBlocks(partialFirst).some(t => t.includes("Red succeeded."))).toBe(true);
		expect(imageBlocks(partialFirst)).toHaveLength(1);
		expect(partialBlueVariants.has(imageBlocks(partialFirst)[0]!.data)).toBe(true);
	});

	it("coalesces concurrent vision summaries for the same image hash and preserves compacted message identity across turns", async () => {
		const { sideRequests, transformHook } = await createHarness({
			settings: { "images.compactAfterTurns": 1 },
		});
		const sharedUserMsg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "concurrent shot" }, RED_1X1_PNG],
			attribution: "user",
			timestamp: 1,
		};
		const messages: Message[] = [
			sharedUserMsg,
			{ role: "user", content: [{ type: "text", text: "later" }], attribution: "user", timestamp: 2 },
		];
		const [firstOut, secondOut] = await Promise.all([
			transformHook!({ systemPrompt: ["Test"], messages, tools: [] }, visionModel()),
			transformHook!({ systemPrompt: ["Test"], messages, tools: [] }, visionModel()),
		]);
		expect(sideRequests).toHaveLength(1);
		expect(imageBlocks(firstOut.messages[0]!)).toEqual([]);
		expect(imageBlocks(secondOut.messages[0]!)).toEqual([]);

		const thirdOut = await transformHook!(
			{
				systemPrompt: ["Test"],
				messages: [
					...messages,
					{ role: "user", content: [{ type: "text", text: "even later" }], attribution: "user", timestamp: 3 },
				],
				tools: [],
			},
			visionModel(),
		);
		expect(sideRequests).toHaveLength(1);
		expect(thirdOut.messages[0]).toBe(firstOut.messages[0]);
	});
});
