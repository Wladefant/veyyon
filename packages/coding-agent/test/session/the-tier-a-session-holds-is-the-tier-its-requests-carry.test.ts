/**
 * The service tier a session holds is the tier its requests carry, and every way the session changes
 * it (`/fast`, the `tier.*` settings, a provider that drops priority, a session switch that fails)
 * leaves the map, the wire tier and the transcript agreeing.
 *
 * WHY: the tier map moved out of `AgentSession` into the `ServiceTiers` collaborator
 * (`session/runtime/service-tiers.ts`). A mutation sweep of that move found most of its branches
 * unpinned: the request resolver, the Fireworks setting and its `-fast` exclusion, the configured
 * baseline `/fast off` returns to, the Anthropic rejection drop and its warning, the fast-mode
 * re-arm, the no-op guard, the rollback of a failed switch and the request dump could each be
 * removed with every suite green. Each case below fails on one of them.
 *
 * Driven through a real `AgentSession` and `Agent`. Only the provider stream is faked, and it plays
 * the provider's part: it records the tier each request asked for, and on a rejection it sets the
 * Anthropic fast-mode fallback flag in the session's provider state and reports
 * `disabledFeatures: ["priority"]`, as `providers/anthropic.ts` does.
 *
 * NOT CAUGHT, each indistinguishable from outside the file bytes or unreachable:
 * - Whether clearing the last family records `serviceTier: null` or `{}`, or leaves the cleared key
 *   holding `undefined`. Every reader coerces all three to no tier (`coerceServiceTierByFamily`).
 * - Re-arming clears the fast-mode fallback only when Anthropic moves TO priority. Clearing it on
 *   any change while Anthropic stays priority goes unseen, because a rejection that sets the flag
 *   also turns Anthropic priority off, so the flag and the tier are never both on.
 *
 * Reload and new-session persistence are pinned by
 * `a-service-tier-survives-a-reload-and-carries-into-a-new-session.test.ts`, and the family `/fast`
 * targets by `fast-mode-scope.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Api, Model, ProviderSessionState, ServiceTier, ServiceTierByFamily } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ANTHROPIC_PROVIDER_SESSION_STATE_KEY } from "@veyyon/ai/providers/anthropic-session-state";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { MemoryContext } from "@veyyon/coding-agent/session/runtime/memory-context";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../../agent/test/helpers";
import { createAssistantMessage } from "../helpers/agent-session-setup";

interface Notice {
	level: "info" | "warning" | "error";
	message: string;
	source?: string;
}

/** The Anthropic provider state entry the fake provider keeps, in the shape the provider writes. */
interface FastModeFallback extends ProviderSessionState {
	fastModeDisabled: boolean;
}

/** The fake provider: what each request asked for, and the rejection it plays next. */
interface FakeProvider {
	/** The tier each request asked for, in request order. */
	requestTiers: (ServiceTier | undefined)[];
	/** Whether the fast-mode fallback flag was set when each request started. */
	fallbackAtRequest: boolean[];
	/** The provider state entry a rejection sets; `undefined` until the first request. */
	fallback: FastModeFallback | undefined;
	/** When true, the next response plays an Anthropic fast-mode rejection. */
	rejectPriority: boolean;
}

interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	provider: FakeProvider;
	/** The session's `priority` notices, in emission order. */
	notices: Notice[];
}

interface HarnessOptions {
	model?: Model<Api>;
	settings?: Record<string, unknown>;
	/** The tier map the session starts with, as `createAgentSession` resolves it from the transcript or settings. */
	startingTiers?: ServiceTierByFamily;
	sessionManager?: SessionManager;
}

function fireworksModel(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 64_000,
	});
}

describe("the tier a session holds is the tier its requests carry", () => {
	let tempDir: TempDir;
	const cleanups: (() => Promise<void> | void)[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-service-tiers-");
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		tempDir.removeSync();
	});

	async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
		const model = options.model ?? requireBundledModel("anthropic", "claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const sessionManager = options.sessionManager ?? SessionManager.inMemory(tempDir.path());
		const provider: FakeProvider = {
			requestTiers: [],
			fallbackAtRequest: [],
			fallback: undefined,
			rejectPriority: false,
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (requestModel, _context, streamOptions) => {
				provider.requestTiers.push(streamOptions?.serviceTier);
				const states = streamOptions?.providerSessionState;
				if (states && !provider.fallback) {
					provider.fallback = { close() {}, fastModeDisabled: false };
					states.set(
						`${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:${requestModel.baseUrl}\u0000${requestModel.id}`,
						provider.fallback,
					);
				}
				provider.fallbackAtRequest.push(provider.fallback?.fastModeDisabled ?? false);
				const response = createAssistantMessage("done");
				if (provider.rejectPriority) {
					provider.rejectPriority = false;
					if (provider.fallback) provider.fallback.fastModeDisabled = true;
					response.disabledFeatures = ["priority"];
				}
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false, ...options.settings }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`)),
			serviceTierByFamily: options.startingTiers,
		});
		const notices: Notice[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "priority") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});
		cleanups.push(
			() => authStorage.close(),
			() => session.dispose(),
		);
		return { session, sessionManager, provider, notices };
	}

	async function send(harness: Harness): Promise<void> {
		await harness.session.prompt("go");
		await harness.session.waitForIdle();
	}

	function tierChanges(harness: Harness): unknown[] {
		return harness.sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "service_tier_change" ? [entry.serviceTier] : []));
	}

	describe("the request", () => {
		it("carries the tier /fast set, and none once /fast is off", async () => {
			const h = await createHarness();
			await send(h);
			h.session.setFastMode(true);
			await send(h);
			h.session.setFastMode(false);
			await send(h);
			expect(h.provider.requestTiers).toEqual([undefined, "priority", undefined]);
		});

		it("to a Fireworks model takes priority from the Fireworks tier setting", async () => {
			const h = await createHarness({
				model: fireworksModel("gpt-oss-120b"),
				settings: { "providers.fireworksTier": "priority" },
			});
			expect(h.session.isFastModeActive()).toBe(true);
			await send(h);
			expect(h.provider.requestTiers).toEqual(["priority"]);
		});

		it("to a Fireworks -fast model never takes priority, whose serving path excludes it", async () => {
			const h = await createHarness({
				model: fireworksModel("gpt-oss-120b-fast"),
				settings: { "providers.fireworksTier": "priority" },
			});
			expect(h.session.isFastModeActive()).toBe(false);
			await send(h);
			expect(h.provider.requestTiers).toEqual([undefined]);
		});

		it("is recorded in the request dump", async () => {
			const h = await createHarness();
			await send(h);
			h.session.setServiceTierFamily("anthropic", "priority");
			const dumped = await h.session.dumpLlmRequestToTmpDir();
			if (!dumped) throw new Error("expected a dump for a session with messages");
			cleanups.push(() => fs.rmSync(dumped, { force: true }));
			const payload = JSON.parse(fs.readFileSync(dumped, "utf8")) as { serviceTier: unknown };
			expect(payload.serviceTier).toEqual({ anthropic: "priority" });
		});
	});

	describe("/fast", () => {
		it("on a model with no tier family changes nothing and reports why", async () => {
			const h = await createHarness({ model: fireworksModel("gpt-oss-120b") });
			expect(h.session.setFastMode(true)).toBe(false);
			expect(h.session.serviceTierByFamily).toEqual({});
			expect(h.notices).toEqual([
				expect.objectContaining({ level: "info", message: expect.stringContaining("/fast") }),
			]);
		});

		it("off returns the family to the tier the settings configure", async () => {
			const h = await createHarness({
				model: requireBundledModel("openai", "gpt-5.2"),
				settings: { "tier.openai": "flex" },
				startingTiers: { openai: "flex" },
			});
			h.session.setFastMode(true);
			expect(h.session.serviceTierByFamily).toEqual({ openai: "priority" });
			h.session.setFastMode(false);
			expect(h.session.serviceTierByFamily).toEqual({ openai: "flex" });
		});

		it("off clears a family the settings configure as priority, the one tier with no baseline below it", async () => {
			const h = await createHarness({
				model: requireBundledModel("openai", "gpt-5.2"),
				settings: { "tier.openai": "priority" },
				startingTiers: { openai: "priority" },
			});
			h.session.setFastMode(false);
			expect(h.session.serviceTierByFamily).toEqual({});
			expect(h.session.isFastModeEnabled()).toBe(false);
		});

		it("off leaves a tier that is not priority where it is", async () => {
			const h = await createHarness({ model: requireBundledModel("openai", "gpt-5.2") });
			h.session.setServiceTierFamily("openai", "flex");
			expect(h.session.setFastMode(false)).toBe(true);
			expect(h.session.serviceTierByFamily).toEqual({ openai: "flex" });
		});

		it("reads a flex tier as off, so toggling it turns priority on", async () => {
			const h = await createHarness({
				model: requireBundledModel("openai", "gpt-5.2"),
				settings: { "tier.openai": "flex" },
				startingTiers: { openai: "flex" },
			});
			expect(h.session.isFastModeEnabled()).toBe(false);
			expect(h.session.toggleFastMode()).toBe(true);
			expect(h.session.serviceTierByFamily).toEqual({ openai: "priority" });
		});

		it("on twice records one change in the transcript", async () => {
			const h = await createHarness();
			h.session.setFastMode(true);
			h.session.setFastMode(true);
			h.session.setServiceTierFamily("anthropic", "priority");
			expect(tierChanges(h)).toEqual([{ anthropic: "priority" }]);
		});
	});

	describe("an Anthropic priority rejection", () => {
		it("turns the Anthropic tier off and warns once", async () => {
			const h = await createHarness();
			h.session.setFastMode(true);
			h.provider.rejectPriority = true;
			await send(h);
			expect(h.session.serviceTierByFamily).toEqual({});
			expect(h.notices).toEqual([expect.objectContaining({ level: "warning" })]);
			await send(h);
			expect(h.provider.requestTiers).toEqual(["priority", undefined]);
		});

		it("on a session without Anthropic priority changes no tier and warns nothing", async () => {
			const h = await createHarness({ startingTiers: { openai: "priority" } });
			h.provider.rejectPriority = true;
			await send(h);
			expect(h.session.serviceTierByFamily).toEqual({ openai: "priority" });
			expect(h.notices).toEqual([]);
		});

		it("is undone by /fast on, which re-arms the provider's fast mode for the next request", async () => {
			const h = await createHarness();
			h.session.setFastMode(true);
			h.provider.rejectPriority = true;
			await send(h);
			// Another family going to priority is no re-arm of Anthropic fast mode.
			h.session.setServiceTierFamily("openai", "priority");
			await send(h);
			h.session.setFastMode(true);
			await send(h);
			expect(h.provider.requestTiers).toEqual(["priority", undefined, "priority"]);
			expect(h.provider.fallbackAtRequest).toEqual([false, true, false]);
		});
	});

	it("a failed switch keeps the tier the session had", async () => {
		const sessionDir = tempDir.path();
		const target = SessionManager.create(sessionDir, sessionDir);
		target.appendServiceTierChange({ anthropic: "priority" });
		target.appendMessage({ role: "user", content: "target", timestamp: 2 });
		// A transcript is written to disk once it holds an assistant message.
		target.appendMessage(createAssistantMessage("target reply"));
		await target.flush();
		const targetFile = target.getSessionFile();
		await target.close();
		if (!targetFile) throw new Error("expected a persisted target session file");

		const sessionManager = SessionManager.create(sessionDir, sessionDir);
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();
		const h = await createHarness({ sessionManager });
		h.session.setServiceTierFamily("openai", "flex");

		// Fail the step after the target's tier is installed, so the rollback has a tier to undo.
		let tierAtFault: ServiceTierByFamily | undefined;
		const fault = spyOn(MemoryContext.prototype, "resetForNewTranscript").mockImplementation(() => {
			tierAtFault = h.session.serviceTierByFamily;
			throw new Error("injected switch fault");
		});
		try {
			await expect(h.session.switchSession(targetFile)).rejects.toThrow("injected switch fault");
		} finally {
			fault.mockRestore();
		}
		expect(tierAtFault).toEqual({ anthropic: "priority" });
		expect(h.session.serviceTierByFamily).toEqual({ openai: "flex" });
	});
});
