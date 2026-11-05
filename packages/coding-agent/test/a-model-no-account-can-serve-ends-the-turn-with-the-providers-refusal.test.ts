/**
 * WHY: a provider that refuses a model for the account's plan (Cursor Free: "Named models
 * unavailable") answers every request for that model the same way. The refusal is classified as a
 * usage limit, and the retry loop waited out a usage window and asked again, so the turn sat in
 * "rate limited" retries on an account that had usage left and could never serve the model.
 *
 * Class closed: when the refusal leaves no account and no fallback model to serve the request, the
 * turn ends at once with the provider's sentence; when another account or a fallback model can
 * serve it, the turn continues there. Each branch of that decision is a case below.
 *
 * Not caught: which account the credential layer picks next. That is the library contract in
 * `packages/ai/test/a-plan-that-refuses-a-model-moves-the-session-to-an-account-that-serves-it.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { requireBundledModel } from "../../agent/test/helpers";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

const REFUSAL =
	"Connect error resource_exhausted: Named models unavailable: Free plans can only use Auto. Switch to Auto or upgrade plans to continue. (ERROR_RATE_LIMITED_CHANGEABLE)";

describe("a model no account can serve", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-plan-refusal-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		modelRegistry.clearSuppressedSelectors();
	});

	/** An agent whose `primary` refuses the model `refusals` times, then answers. */
	function agentRefusing(primary: Model, refusals: number, requested: string[]): Agent {
		const mock = createMockModel();
		let refused = 0;
		return new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				if (model.provider === primary.provider && model.id === primary.id && refused < refusals) {
					refused++;
					mock.push({ throw: REFUSAL });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});
	}

	function start(agent: Agent, settings: Settings): AutoRetryEndEvent[] {
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const ends: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") ends.push(event);
		});
		return ends;
	}

	function lastAssistant(): AssistantMessage {
		const last = session?.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("expected a final assistant message");
		return last;
	}

	function primaryModel(): Model {
		const model = requireBundledModel("anthropic", "claude-sonnet-4-5");
		return model;
	}

	it("ends the turn on the first refusal with the provider's sentence when nothing else can serve", async () => {
		const primary = primaryModel();
		const requested: string[] = [];
		const ends = start(
			agentRefusing(primary, Number.POSITIVE_INFINITY, requested),
			Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 5, "retry.maxRetries": 3 }),
		);

		await session?.prompt("use the named model");
		await session?.waitForIdle();

		expect(requested).toEqual([`${primary.provider}/${primary.id}`]);
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ success: false });
		expect(ends[0]?.finalError).toContain("Free plans can only use Auto");
		expect(lastAssistant().errorMessage).toContain("Free plans can only use Auto");
	});

	it("continues on another account when the credential layer moved the session", async () => {
		const primary = primaryModel();
		const requested: string[] = [];
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: true });
		const ends = start(
			agentRefusing(primary, 1, requested),
			Settings.isolated({ "compaction.enabled": false, "retry.baseDelayMs": 5, "retry.maxRetries": 3 }),
		);

		await session?.prompt("use the named model");
		await session?.waitForIdle();

		expect(requested).toEqual([`${primary.provider}/${primary.id}`, `${primary.provider}/${primary.id}`]);
		expect(ends).toEqual([expect.objectContaining({ success: true })]);
	});

	it("continues on the fallback model when one is configured", async () => {
		const primary = primaryModel();
		const fallback = requireBundledModel("openai", "gpt-4o-mini");
		const requested: string[] = [];
		const ends = start(
			agentRefusing(primary, Number.POSITIVE_INFINITY, requested),
			Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxRetries": 3,
				"retry.fallbackChains": { [`${primary.provider}/${primary.id}`]: [`${fallback.provider}/${fallback.id}`] },
			}),
		);

		await session?.prompt("use the named model");
		await session?.waitForIdle();

		expect(requested.at(-1)).toBe(`${fallback.provider}/${fallback.id}`);
		expect(requested.filter(entry => entry === `${primary.provider}/${primary.id}`)).toHaveLength(1);
		expect(ends.at(-1)).toMatchObject({ success: true });
	});
});
