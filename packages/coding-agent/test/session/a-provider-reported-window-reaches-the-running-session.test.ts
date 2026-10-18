/**
 * WHY: a provider can state the model's real context window on the wire
 * (`AssistantMessage.providerContextWindow`), and that value outranks the
 * catalogued guess for the context gauge and the compaction threshold. The
 * session holds its model by reference, so the correction must reach both the
 * live model the next turn reads and the registry a later reload rebuilds from;
 * either half alone leaves the gauge wrong now or reverts it later.
 *
 * The suite drives a real turn whose final message reports a window and reads
 * `session.model` and the registry afterwards. It also reports values that are
 * not a window (zero, negative, NaN, infinite) and checks neither half moves:
 * a zero denominator would read every context as full.
 *
 * Not covered: the registry's own persistence across reloads, which
 * `model-registry-provider-reported-window.test.ts` proves.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake, TempDir } from "@veyyon/utils";

function replyReportingWindow(model: Model<Api>, providerContextWindow: number): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const text: TextContent = { type: "text", text: "done" };
		const partial: AssistantMessage = {
			role: "assistant",
			content: [text],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial });
		stream.push({ type: "done", reason: "stop", message: { ...partial, providerContextWindow } });
	});
	return stream;
}

describe("a provider-reported context window", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-reported-window-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			authStorage = undefined;
			await tempDir.remove();
		}
	});

	async function runTurnReporting(
		window: number,
	): Promise<{ session: AgentSession; registry: ModelRegistry; catalogued: number | null }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: requestedModel => replyReportingWindow(requestedModel, window),
		});
		authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const registry = new ModelRegistry(authStorage, tempDir.join(`models-${Snowflake.next()}.yml`));
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: registry,
		});
		session = created;
		await created.prompt("go");
		await created.waitForIdle();
		return { session: created, registry, catalogued: model.contextWindow };
	}

	it("replaces the window of the live model and of the registry entry", async () => {
		const catalogued = getBundledModel("anthropic", "claude-sonnet-4-5")?.contextWindow ?? 0;
		const reported = catalogued + 777_000;
		const { session: ran, registry } = await runTurnReporting(reported);
		expect(ran.model?.contextWindow).toBe(reported);
		expect(registry.find("anthropic", "claude-sonnet-4-5")?.contextWindow).toBe(reported);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("ignores a reported window of %p", async bad => {
		const { session: ran, registry, catalogued } = await runTurnReporting(bad);
		expect(ran.model?.contextWindow).toBe(catalogued);
		expect(registry.find("anthropic", "claude-sonnet-4-5")?.contextWindow).toBe(catalogued);
	});
});
