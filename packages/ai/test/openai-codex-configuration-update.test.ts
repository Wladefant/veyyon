// WHY: Changing request effort invalidates the cached prefix for Responses models.
// Defend Codex provider integration for GPT-6 Astra configuration_update insertion,
// capability gating, session and baseUrl scoping, compaction bypass, and state lifecycle.
import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { buildTransformedCodexRequestBody } from "../src/providers/openai-codex-responses";
import type { Context, ModelSpec, ProviderSessionState } from "../src/types";
import { createCodexModel } from "./helpers";

const createAstraModel = (spec?: Partial<ModelSpec<"openai-codex-responses">>) =>
	createCodexModel("gpt-6-astra", {
		reasoningOptions: {
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		...spec,
	});

const userTurn = (text: string) => ({
	role: "user" as const,
	content: text,
	timestamp: 1,
});

const assistantTurn = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	timestamp: 2,
});

describe("openai-codex stable reasoning effort via configuration_update", () => {
	it("pins baseline effort on first turn and inserts configuration_update on subsequent effort change", async () => {
		const model = createAstraModel();
		const providerSessionState = new Map<string, ProviderSessionState>();

		const turn1Context: Context = {
			messages: [userTurn("first question")],
		};
		const body1 = await buildTransformedCodexRequestBody(model, turn1Context, {
			sessionId: "session-astra-1",
			reasoning: "low",
			providerSessionState,
		});

		expect(body1.reasoning?.effort).toBe("low");
		expect(body1.input?.some(item => item.type === "configuration_update")).toBe(false);

		const turn2Context: Context = {
			messages: [userTurn("first question"), assistantTurn("first answer"), userTurn("second question")],
		};
		const body2 = await buildTransformedCodexRequestBody(model, turn2Context, {
			sessionId: "session-astra-1",
			reasoning: "high",
			providerSessionState,
		});

		expect(body2.reasoning?.effort).toBe("low");
		const updateIndex = body2.input?.findIndex(item => item.type === "configuration_update") ?? -1;
		expect(updateIndex).toBeGreaterThan(-1);
		expect(body2.input?.[updateIndex]).toEqual({
			type: "configuration_update",
			reasoning: { effort: "high" },
		});
		expect(body2.input?.[updateIndex + 1]?.role).toBe("user");

		// Turn 3: same high effort replays existing configuration_update
		const turn3Context: Context = {
			messages: [
				userTurn("first question"),
				assistantTurn("first answer"),
				userTurn("second question"),
				assistantTurn("second answer"),
				userTurn("third question"),
			],
		};
		const body3 = await buildTransformedCodexRequestBody(model, turn3Context, {
			sessionId: "session-astra-1",
			reasoning: "high",
			providerSessionState,
		});

		expect(body3.reasoning?.effort).toBe("low");
		const updateItems = body3.input?.filter(item => item.type === "configuration_update") ?? [];
		expect(updateItems).toHaveLength(1);
		expect(updateItems[0]).toEqual({
			type: "configuration_update",
			reasoning: { effort: "high" },
		});
	});

	it("bypasses configuration_update when codexCompaction is present", async () => {
		const model = createAstraModel();
		const providerSessionState = new Map<string, ProviderSessionState>();

		const context: Context = {
			messages: [userTurn("first question"), assistantTurn("first answer"), userTurn("second question")],
		};

		// First establish baseline
		await buildTransformedCodexRequestBody(
			model,
			{ messages: [userTurn("first question")] },
			{
				sessionId: "session-compaction-1",
				reasoning: "low",
				providerSessionState,
			},
		);

		const compactionBody = await buildTransformedCodexRequestBody(model, context, {
			sessionId: "session-compaction-1",
			reasoning: "high",
			providerSessionState,
			codexCompaction: {
				operationId: "compaction-op-1",
				trigger: "auto",
				reason: "budget",
			},
		});

		expect(compactionBody.reasoning?.effort).toBe("high");
		expect(compactionBody.input?.some(item => item.type === "configuration_update")).toBe(false);
	});

	it("does not insert configuration_update for models without capability support", async () => {
		const model = createCodexModel("gpt-5.6-sol");
		expect(model.compat.supportsConfigurationUpdate).toBe(false);
		const providerSessionState = new Map<string, ProviderSessionState>();

		await buildTransformedCodexRequestBody(
			model,
			{ messages: [userTurn("first question")] },
			{
				sessionId: "session-sol-1",
				reasoning: "low",
				providerSessionState,
			},
		);

		const context: Context = {
			messages: [userTurn("first question"), assistantTurn("first answer"), userTurn("second question")],
		};
		const body = await buildTransformedCodexRequestBody(model, context, {
			sessionId: "session-sol-1",
			reasoning: "high",
			providerSessionState,
		});

		expect(body.reasoning?.effort).toBe("high");
		expect(body.input?.some(item => item.type === "configuration_update")).toBe(false);
	});

	it("does not insert configuration_update when session ID is missing or blank", async () => {
		const model = createAstraModel();
		const providerSessionState = new Map<string, ProviderSessionState>();

		const context: Context = {
			messages: [userTurn("first question"), assistantTurn("first answer"), userTurn("second question")],
		};

		const bodyMissing = await buildTransformedCodexRequestBody(model, context, {
			reasoning: "high",
			providerSessionState,
		});
		expect(bodyMissing.reasoning?.effort).toBe("high");
		expect(bodyMissing.input?.some(item => item.type === "configuration_update")).toBe(false);

		const bodyBlank = await buildTransformedCodexRequestBody(model, context, {
			sessionId: "   ",
			reasoning: "high",
			providerSessionState,
		});
		expect(bodyBlank.reasoning?.effort).toBe("high");
		expect(bodyBlank.input?.some(item => item.type === "configuration_update")).toBe(false);
	});

	it("scopes effort controls across model id, baseUrl, and session id", async () => {
		const astraModel = createAstraModel();
		const providerSessionState = new Map<string, ProviderSessionState>();

		const initialContext: Context = {
			messages: [userTurn("first question")],
		};

		// Session A baseline: low
		await buildTransformedCodexRequestBody(astraModel, initialContext, {
			sessionId: "session-A",
			reasoning: "low",
			providerSessionState,
		});

		// Session B baseline: high
		const sessionBBody = await buildTransformedCodexRequestBody(astraModel, initialContext, {
			sessionId: "session-B",
			reasoning: "high",
			providerSessionState,
		});
		expect(sessionBBody.reasoning?.effort).toBe("high");
		expect(sessionBBody.input?.some(item => item.type === "configuration_update")).toBe(false);

		// Custom baseUrl on Session A has independent baseline: medium
		const customBaseUrlBody = await buildTransformedCodexRequestBody(astraModel, initialContext, {
			sessionId: "session-A",
			baseUrl: "https://custom-gateway.openai.com/v1",
			reasoning: "medium",
			providerSessionState,
		});
		expect(customBaseUrlBody.reasoning?.effort).toBe("medium");
		expect(customBaseUrlBody.input?.some(item => item.type === "configuration_update")).toBe(false);
	});

	it("clears effort controls on session state close", async () => {
		const astraModel = createAstraModel();
		const providerSessionState = new Map<string, ProviderSessionState>();

		await buildTransformedCodexRequestBody(
			astraModel,
			{ messages: [userTurn("q")] },
			{
				sessionId: "session-close-test",
				reasoning: "low",
				providerSessionState,
			},
		);

		const codexState = providerSessionState.get("openai-codex-responses") as {
			effortControls: Map<string, unknown>;
			close: () => void;
		};
		expect(codexState).toBeDefined();
		expect(codexState.effortControls.size).toBe(1);

		codexState.close();
		expect(codexState.effortControls.size).toBe(0);
	});
});
