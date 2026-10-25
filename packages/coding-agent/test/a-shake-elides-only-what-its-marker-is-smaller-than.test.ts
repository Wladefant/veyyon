/**
 * WHY: a shake region was admitted at any size and sized by its whole message.
 * Two defects followed. A tool result smaller than the marker that replaces it
 * (a write confirmation, an "OK") was swapped for a marker of 14-15 tokens, so
 * a manual `/shake` grew the context it reported shrinking and counted the
 * result as dropped. A captioned screenshot was charged ~1,200 tokens for an
 * image the rewrite keeps in place, so the reported total and the marker both
 * claimed room nothing freed.
 *
 * Class closed: through the session, every message a shake or a dedupe
 * rewrites gets smaller and the reported `tokensFreed` is the measured drop of
 * the context; across every exported `collect*Regions` collector, a region is
 * sized by the text its marker replaces and is larger than the widest marker
 * that can replace it. The sweep reads the collectors off the compaction module,
 * so a new one turns this suite red until it has a case below.
 *
 * Not caught: the truncation rescue applies its regions through a private path
 * of the compaction recovery, so its marker is not measured here; the sweep
 * checks its regions against a marker built to the same format instead. A
 * marker format that grows past the collectors' placeholder estimate is caught
 * for `shake` and `dedupe` only.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@veyyon/agent-core";
import { Agent, countTokens } from "@veyyon/agent-core";
import type { SessionEntry, ShakeConfig, ShakeRegion } from "@veyyon/agent-core/compaction";
import * as compaction from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, TextContent } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const PNG: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
/** A write confirmation: one token, an order of magnitude below any marker. */
const CONFIRMATION = "OK";
/** A screenshot caption smaller than a marker; the image beside it stays whatever happens. */
const SHORT_CAPTION = "Saved screenshot.";
/** A caption large enough to be worth eliding on its own. */
const LONG_CAPTION = "Screenshot of the settings page with the model list open.\n".repeat(10);
const BULK = "X".repeat(4000);

interface Measured {
	message: AgentMessage;
	tokens: number;
}

describe("a shake elides only what its marker is smaller than", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shake-room-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	/**
	 * Append a user → assistant(toolCall) → toolResult turn and return the tool
	 * result's entry id. Equal `toolName`, `args` and `content` make a byte-identical
	 * repeat, which is what the redundancy pass keys on.
	 */
	function seedToolResult(
		toolName: string,
		args: Record<string, unknown>,
		content: Array<TextContent | ImageContent>,
	): string {
		const toolCallId = `call_${toolName}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "do it" }], timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: args },
			],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now(),
		});
		return sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content,
			isError: false,
			timestamp: Date.now(),
		});
	}

	/** Every message on the branch, copied, with the estimate the compaction decision reads. */
	function measureBranch(): Map<string, Measured> {
		const out = new Map<string, Measured>();
		for (const entry of sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = structuredClone(entry.message);
			out.set(entry.id, { message, tokens: compaction.estimateTokens(message) });
		}
		return out;
	}

	function imageCount(messages: Iterable<Measured>): number {
		let count = 0;
		for (const { message } of messages) {
			if (!("content" in message) || !Array.isArray(message.content)) continue;
			for (const block of message.content) if (block.type === "image") count++;
		}
		return count;
	}

	/**
	 * The entries a rewrite changed, the ones among them that did not get
	 * smaller, and how far the whole context dropped.
	 */
	function compare(before: Map<string, Measured>, after: Map<string, Measured>) {
		const changed: string[] = [];
		const notSmaller: string[] = [];
		let drop = 0;
		for (const [id, was] of before) {
			const now = after.get(id);
			if (!now) throw new Error(`entry ${id} left the branch`);
			drop += was.tokens - now.tokens;
			if (isDeepStrictEqual(was.message, now.message)) continue;
			changed.push(id);
			if (now.tokens >= was.tokens) notSmaller.push(id);
		}
		return { changed, notSmaller, drop };
	}

	it("shake leaves results smaller than a marker alone and charges a kept screenshot only its caption", async () => {
		seedToolResult("write", { path: "a.txt" }, [{ type: "text", text: CONFIRMATION }]);
		seedToolResult("write", { path: "a.txt" }, [{ type: "text", text: CONFIRMATION }]);
		seedToolResult("browser", { action: "screenshot" }, [{ type: "text", text: SHORT_CAPTION }, PNG]);
		const longScreenshot = seedToolResult("browser", { action: "screenshot", full: true }, [
			{ type: "text", text: LONG_CAPTION },
			PNG,
		]);
		const bulk = seedToolResult("bash", { command: "cat log" }, [{ type: "text", text: BULK }]);

		const before = measureBranch();
		const result = await session.shake("elide");
		const after = measureBranch();
		const { changed, notSmaller, drop } = compare(before, after);

		expect(changed).toEqual([longScreenshot, bulk]);
		expect(notSmaller).toEqual([]);
		expect(result.toolResultsDropped).toBe(2);
		expect(result.tokensFreed).toBe(drop);
		expect(imageCount(after.values())).toBe(imageCount(before.values()));
	});

	it("dedupe leaves a repeated result smaller than a marker and charges a repeated screenshot only its caption", async () => {
		seedToolResult("write", { path: "a.txt" }, [{ type: "text", text: CONFIRMATION }]);
		seedToolResult("write", { path: "a.txt" }, [{ type: "text", text: CONFIRMATION }]);
		const screenshot = seedToolResult("browser", { action: "screenshot" }, [
			{ type: "text", text: LONG_CAPTION },
			PNG,
		]);
		seedToolResult("browser", { action: "screenshot" }, [{ type: "text", text: LONG_CAPTION }, PNG]);
		const bulk = seedToolResult("bash", { command: "cat log" }, [{ type: "text", text: BULK }]);
		seedToolResult("bash", { command: "cat log" }, [{ type: "text", text: BULK }]);

		const before = measureBranch();
		const result = await session.dedupeRedundantToolResults();
		const after = measureBranch();
		const { changed, notSmaller, drop } = compare(before, after);

		expect(changed).toEqual([screenshot, bulk]);
		expect(notSmaller).toEqual([]);
		expect(result.toolResultsDropped).toBe(2);
		expect(result.tokensFreed).toBe(drop);
		expect(imageCount(after.values())).toBe(imageCount(before.values()));
	});

	describe("every region collector", () => {
		/** Admits every region a size floor does not exclude: no recency window, no savings bar, no fence minimum. */
		const ADMIT_ALL: ShakeConfig = { protectTokens: 0, minSavings: 0, protectedTools: [], fenceMinTokens: 1 };

		/**
		 * One run per exported collector, with the entries each must return on
		 * the branch `seedSweepBranch` builds. A collector missing here fails the
		 * enumeration below.
		 */
		const CASES: Record<
			string,
			{ run: (entries: SessionEntry[]) => ShakeRegion[]; expected: (ids: SweepIds) => string[] }
		> = {
			collectShakeRegions: {
				run: entries => compaction.collectShakeRegions(entries, ADMIT_ALL),
				expected: ids => [ids.bulk, ids.repeatedBulk, ids.medium],
			},
			collectRedundantToolResultRegions: {
				run: entries => compaction.collectRedundantToolResultRegions(entries, ADMIT_ALL),
				expected: ids => [ids.bulk],
			},
			collectOversizedTextRegions: {
				run: entries =>
					compaction.collectOversizedTextRegions(entries, {
						excessTokens: Number.MAX_SAFE_INTEGER,
						keepEdgeTokens: 4,
						minTextTokens: 1,
						protectedTools: [],
					}),
				expected: ids => [ids.bulk, ids.repeatedBulk],
			},
		};

		interface SweepIds {
			bulk: string;
			repeatedBulk: string;
			medium: string;
		}

		/**
		 * A branch with a small candidate for every collector: repeated
		 * confirmations and captioned screenshots (whole results, and repeats),
		 * a fenced block of three tokens (a block region), and a 20-token result
		 * whose middle between 4-token edges is 12 tokens (a truncation region).
		 * The two bulk results and the medium one are the regions that do free room.
		 */
		function seedSweepBranch(): SweepIds {
			seedToolResult("write", { path: "a.txt" }, [{ type: "text", text: CONFIRMATION }]);
			seedToolResult("write", { path: "a.txt" }, [{ type: "text", text: CONFIRMATION }]);
			seedToolResult("browser", { action: "screenshot" }, [{ type: "text", text: SHORT_CAPTION }, PNG]);
			seedToolResult("browser", { action: "screenshot" }, [{ type: "text", text: SHORT_CAPTION }, PNG]);
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "see\n```\nx\n```" }],
				timestamp: Date.now(),
			});
			const medium = seedToolResult("bash", { command: "wc" }, [{ type: "text", text: "m".repeat(80) }]);
			const bulk = seedToolResult("bash", { command: "cat log" }, [{ type: "text", text: BULK }]);
			const repeatedBulk = seedToolResult("bash", { command: "cat log" }, [{ type: "text", text: BULK }]);
			return { bulk, repeatedBulk, medium };
		}

		/** The widest marker a rewrite of `count` regions writes for a region of `tokens`. */
		function widestMarker(tokens: number, count: number): string {
			return `\n[truncated ~${tokens} tokens; recover: artifact://99 (region ${count})]\n`;
		}

		it("covers every collector the compaction module exports", () => {
			const exported = Object.keys(compaction)
				.filter(name => /^collect\w*Regions$/.test(name))
				.sort();
			expect(exported).toEqual(Object.keys(CASES).sort());
		});

		for (const [name, { run, expected }] of Object.entries(CASES)) {
			it(`${name} sizes a region by the text it replaces and returns none its marker would not shrink`, () => {
				const ids = seedSweepBranch();
				const regions = run(sessionManager.getBranch());

				expect(regions.map(region => region.entry.id).sort()).toEqual(expected(ids).sort());
				for (const region of regions) {
					expect(region.tokens).toBe(countTokens(region.originalText));
					expect(region.tokens).toBeGreaterThan(countTokens(widestMarker(region.tokens, regions.length)));
				}
			});
		}
	});
});
