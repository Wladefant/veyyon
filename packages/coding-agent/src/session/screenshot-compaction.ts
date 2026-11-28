/**
 * Automatic outbound screenshot compaction.
 *
 * Replaces older eligible user-attached `ImageContent` blocks in outbound provider requests with
 * durably cached vision summaries once at least `N` later genuine user turns follow, while leaving
 * the recorded session transcript, live agent messages, non-image content, and recent screenshots
 * intact.
 *
 * Eligibility boundary (strictly typed on existing `Message` / `UserMessage` fields):
 *   - Eligible: `role === "user"`, not marked as derived in `convertToLlm` (`fileMention`,
 *     `custom`, `hookMessage`, `skill-prompt`), `attribution === "user"`, `synthetic !== true`,
 *     `demotedReasoningSource === undefined`, `historyRewriteAt === undefined`, and
 *     `providerPayload === undefined`.
 *   - Excluded (pixels preserved): `toolResult`, `developer`, `assistant`, derived `convertToLlm`
 *     user wrappers, `synthetic: true`, `attribution: "agent"`, `attribution: undefined` (uncertain
 *     provenance), and `providerPayload`-bearing messages.
 *
 * Vision policy & durability:
 *   - Enforces the current request model's vision policy (`images.blockImages` and
 *     `model.input.includes("image")`); never delegates to a second model client.
 *   - Replaces request pixels only after a summary succeeds and flushes durably via
 *     `SessionManager.appendCustomEntry` + `flush()`. Failures, missing credentials, non-vision
 *     models, or persistence faults preserve original image pixels.
 */

import { createHash } from "node:crypto";
import type { AgentTelemetryConfig } from "@veyyon/agent-core";
import type { ImageContent, Message, Model, SimpleStreamOptions, TextContent, UserMessage } from "@veyyon/ai";
import { isBlobRef } from "@veyyon/kernel/session/blob-store";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { errorMessage, logger } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { describeImageWithModel } from "../utils/image-vision-fallback";
import { isDerivedUserMessage } from "./messages";

export const SCREENSHOT_COMPACTION_ENTRY_TYPE = "screenshot-compaction-summary";
export const SCREENSHOT_COMPACTION_ENTRY_VERSION = 1;
export const DEFAULT_SCREENSHOT_COMPACT_AFTER_TURNS = 3;
export const MAX_SCREENSHOT_COMPACT_AFTER_TURNS = 100;
const SCREENSHOT_SUMMARY_MAX_TOKENS = 512;
const SCREENSHOT_SUMMARY_CONCURRENCY = 3;

export interface ScreenshotCompactionCacheEntryData {
	readonly version: typeof SCREENSHOT_COMPACTION_ENTRY_VERSION;
	readonly imageHash: string;
	readonly mimeType: string;
	readonly model: string;
	readonly summary: string;
	readonly createdAt: number;
}

export interface ScreenshotCompactionStore {
	getBranch(): SessionEntry[];
	appendCustomEntry(customType: string, data?: unknown): string;
	flush(): Promise<void>;
	getSessionId(): string;
}

export interface ScreenshotCompactorHost {
	readonly settings: Pick<Settings, "get">;
	readonly sessionStore: ScreenshotCompactionStore;
	readonly modelRegistry: Pick<ModelRegistry, "getApiKey" | "resolver">;
	readonly completeImpl?: SideCompleteImpl;
	readonly prepareOptions?: (options: SimpleStreamOptions, provider: string) => Promise<SimpleStreamOptions>;
	readonly telemetryConfig?: () => AgentTelemetryConfig | undefined;
	readonly sessionId: () => string;
	readonly isDisposed?: () => boolean;
}

interface CandidateMessage {
	readonly index: number;
	readonly message: UserMessage;
	readonly imageParts: ReadonlyArray<{ readonly partIndex: number; readonly image: ImageContent }>;
}

/** Clamp `images.compactAfterTurns` to `[0, MAX_SCREENSHOT_COMPACT_AFTER_TURNS]`, treating `<= 0` or invalid as `0` (off). */
export function clampScreenshotCompactAfterTurns(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
	return Math.min(MAX_SCREENSHOT_COMPACT_AFTER_TURNS, Math.max(1, Math.floor(raw)));
}

function isGenuineUserTurn(message: Message): message is UserMessage {
	return (
		message.role === "user" &&
		!isDerivedUserMessage(message) &&
		message.attribution === "user" &&
		message.synthetic !== true &&
		message.demotedReasoningSource === undefined &&
		message.historyRewriteAt === undefined
	);
}

function isValidImagePart(part: TextContent | ImageContent | { type: string }): part is ImageContent {
	return (
		part.type === "image" &&
		"data" in part &&
		typeof part.data === "string" &&
		part.data.length > 0 &&
		"mimeType" in part &&
		typeof part.mimeType === "string" &&
		part.mimeType.length > 0 &&
		!isBlobRef(part.data)
	);
}

function isCacheRecord(data: unknown): data is ScreenshotCompactionCacheEntryData {
	if (typeof data !== "object" || data === null) return false;
	const record = data as Partial<ScreenshotCompactionCacheEntryData>;
	return (
		record.version === SCREENSHOT_COMPACTION_ENTRY_VERSION &&
		typeof record.imageHash === "string" &&
		record.imageHash.length > 0 &&
		typeof record.summary === "string" &&
		record.summary.trim().length > 0
	);
}

function formatScreenshotSummary(mimeType: string, summary: string): string {
	return `<screenshot-summary mime="${mimeType}">\n${summary}\n</screenshot-summary>`;
}

export class ScreenshotCompactor {
	readonly #host: ScreenshotCompactorHost;
	readonly #hashCache = new WeakMap<ImageContent, string>();
	readonly #compactedMessageCache = new WeakMap<UserMessage, { cacheKey: string; compacted: UserMessage }>();
	readonly #cachedSummaries = new Map<string, string>();
	readonly #inFlightByHash = new Map<string, Promise<string | null>>();
	readonly #unpersistedEntryIds = new Set<string>();
	#indexedSessionId: string | undefined;
	#indexedBranchLength = 0;
	#indexedLeafId: string | undefined;

	constructor(host: ScreenshotCompactorHost) {
		this.#host = host;
	}

	/**
	 * Compact eligible older user-attached screenshots in `messages` for an outbound request
	 * targeting `model`. Returns synchronously whenever no uncached screenshots require a vision call.
	 */
	compactMessages(
		messages: Message[],
		model: Model,
		policy: { readonly blockImages: boolean },
	): Message[] | Promise<Message[]> {
		if (policy.blockImages || !model.input.includes("image")) return messages;
		const threshold = clampScreenshotCompactAfterTurns(this.#host.settings.get("images.compactAfterTurns"));
		if (threshold <= 0) return messages;

		const candidates: CandidateMessage[] = [];
		let laterUserTurns = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i]!;
			if (!isGenuineUserTurn(msg)) continue;
			if (laterUserTurns >= threshold && msg.providerPayload === undefined && Array.isArray(msg.content)) {
				const imageParts: Array<{ partIndex: number; image: ImageContent }> = [];
				for (let p = 0; p < msg.content.length; p++) {
					const part = msg.content[p]!;
					if (isValidImagePart(part)) imageParts.push({ partIndex: p, image: part });
				}
				if (imageParts.length > 0) {
					candidates.push({ index: i, message: msg, imageParts });
				}
			}
			laterUserTurns += 1;
		}
		if (candidates.length === 0) return messages;
		candidates.reverse();

		this.#syncBranchCache();
		const missingByHash = new Map<string, ImageContent>();
		for (const candidate of candidates) {
			for (const { image } of candidate.imageParts) {
				const hash = this.#imageHash(image);
				if (!this.#cachedSummaries.has(hash) && !missingByHash.has(hash)) {
					missingByHash.set(hash, image);
				}
			}
		}

		if (missingByHash.size === 0) {
			return this.#applyCachedReplacements(messages, candidates);
		}
		return this.#summarizeAndApply(messages, candidates, missingByHash, model);
	}

	#imageHash(image: ImageContent): string {
		const cached = this.#hashCache.get(image);
		if (cached !== undefined) return cached;
		const digest = createHash("sha256").update(image.mimeType).update("\0").update(image.data).digest("hex");
		this.#hashCache.set(image, digest);
		return digest;
	}

	#syncBranchCache(): void {
		const sessionId = this.#host.sessionStore.getSessionId();
		const branch = this.#host.sessionStore.getBranch();
		const leafId = branch.at(-1)?.id;
		if (
			sessionId === this.#indexedSessionId &&
			branch.length === this.#indexedBranchLength &&
			leafId === this.#indexedLeafId
		) {
			return;
		}

		const isMonotonicAppend =
			sessionId === this.#indexedSessionId &&
			branch.length > this.#indexedBranchLength &&
			(this.#indexedBranchLength === 0 || branch[this.#indexedBranchLength - 1]?.id === this.#indexedLeafId);

		const start = isMonotonicAppend ? this.#indexedBranchLength : 0;
		if (!isMonotonicAppend) {
			this.#cachedSummaries.clear();
		}
		for (let i = start; i < branch.length; i++) {
			const entry = branch[i]!;
			if (
				entry.type === "custom" &&
				entry.customType === SCREENSHOT_COMPACTION_ENTRY_TYPE &&
				!this.#unpersistedEntryIds.has(entry.id) &&
				isCacheRecord(entry.data)
			) {
				this.#cachedSummaries.set(entry.data.imageHash, entry.data.summary);
			}
		}
		this.#indexedSessionId = sessionId;
		this.#indexedBranchLength = branch.length;
		this.#indexedLeafId = leafId;
	}

	async #summarizeAndApply(
		messages: Message[],
		candidates: readonly CandidateMessage[],
		missingByHash: ReadonlyMap<string, ImageContent>,
		model: Model,
	): Promise<Message[]> {
		const sessionId = this.#host.sessionId();
		const storeSessionId = this.#host.sessionStore.getSessionId();
		const apiKey = await this.#host.modelRegistry.getApiKey(model, sessionId);
		if (!apiKey) {
			return this.#applyCachedReplacements(messages, candidates);
		}

		const queue = [...missingByHash.entries()];
		const workers = Array.from({ length: Math.min(SCREENSHOT_SUMMARY_CONCURRENCY, queue.length) }, async () => {
			while (queue.length > 0) {
				if (this.#host.isDisposed?.()) return;
				const next = queue.shift();
				if (!next) return;
				const [hash, image] = next;
				await this.#summarizeAndPersistOne(hash, image, model, sessionId, storeSessionId);
			}
		});
		await Promise.all(workers);

		return this.#applyCachedReplacements(messages, candidates);
	}

	#summarizeAndPersistOne(
		hash: string,
		image: ImageContent,
		model: Model,
		sessionId: string,
		storeSessionId: string,
	): Promise<string | null> {
		const existing = this.#inFlightByHash.get(hash);
		if (existing) return existing;

		const task = (async (): Promise<string | null> => {
			const hostCompleteImpl = this.#host.completeImpl;
			const summary = await describeImageWithModel(image, model, {
				modelRegistry: this.#host.modelRegistry,
				telemetryConfig: this.#host.telemetryConfig?.(),
				sessionId,
				completeImpl: hostCompleteImpl
					? (targetModel, context, options) => hostCompleteImpl(targetModel, context, options ?? {})
					: undefined,
				prepareOptions: this.#host.prepareOptions,
				oneshotKind: "screenshot_compaction",
				maxTokens: SCREENSHOT_SUMMARY_MAX_TOKENS,
			});
			if (!summary) return null;
			if (this.#host.isDisposed?.() || this.#host.sessionStore.getSessionId() !== storeSessionId) {
				return null;
			}
			const record: ScreenshotCompactionCacheEntryData = {
				version: SCREENSHOT_COMPACTION_ENTRY_VERSION,
				imageHash: hash,
				mimeType: image.mimeType,
				model: `${model.provider}/${model.id}`,
				summary,
				createdAt: Date.now(),
			};
			const entryId = this.#host.sessionStore.appendCustomEntry(SCREENSHOT_COMPACTION_ENTRY_TYPE, record);
			this.#unpersistedEntryIds.add(entryId);
			try {
				await this.#host.sessionStore.flush();
				this.#unpersistedEntryIds.delete(entryId);
				this.#cachedSummaries.set(hash, summary);
				return summary;
			} catch (err) {
				logger.warn("screenshot compaction durable cache write failed; preserving pixels", {
					error: errorMessage(err),
					imageHash: hash,
				});
				return null;
			}
		})();

		this.#inFlightByHash.set(hash, task);
		task.finally(() => {
			if (this.#inFlightByHash.get(hash) === task) {
				this.#inFlightByHash.delete(hash);
			}
		});
		return task;
	}

	#applyCachedReplacements(messages: Message[], candidates: readonly CandidateMessage[]): Message[] {
		let out: Message[] | undefined;
		for (const candidate of candidates) {
			const original = candidate.message;
			if (!Array.isArray(original.content)) continue;

			const partSummaries = new Map<number, string>();
			const keyParts: string[] = [];
			for (const { partIndex, image } of candidate.imageParts) {
				const hash = this.#imageHash(image);
				const summary = this.#cachedSummaries.get(hash);
				if (summary !== undefined) {
					partSummaries.set(partIndex, summary);
					keyParts.push(hash);
				} else {
					keyParts.push("-");
				}
			}
			if (partSummaries.size === 0) continue;

			const cacheKey = keyParts.join("|");
			const cachedMsg = this.#compactedMessageCache.get(original);
			let compacted: UserMessage;
			if (cachedMsg && cachedMsg.cacheKey === cacheKey) {
				compacted = cachedMsg.compacted;
			} else {
				const nextContent = original.content.map((part, partIndex) => {
					const summary = partSummaries.get(partIndex);
					if (summary === undefined || part.type !== "image") return part;
					return { type: "text", text: formatScreenshotSummary(part.mimeType, summary) } satisfies TextContent;
				});
				compacted = { ...original, content: nextContent };
				this.#compactedMessageCache.set(original, { cacheKey, compacted });
			}
			if (out === undefined) out = messages.slice();
			out[candidate.index] = compacted;
		}
		return out ?? messages;
	}
}
