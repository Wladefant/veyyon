/**
 * WHY: an agent whose effort is `inherit` took the parent's live level verbatim. That level was fitted
 * to the PARENT's model, so a parent on a model with `xhigh` spawning an agent on a model whose ladder
 * stops at `high` produced a child badge reading `xhigh` for a run that happened at `high`, and a
 * parent with no level at all handed the child `inherit` itself, leaving it no effort rather than its
 * own default.
 *
 * The class closed: every level a child can be asked to run at, on either channel (inherited from the
 * parent, or configured on the agent), lands on the child session as the level the child's model
 * accepts, and the badge states that same level. The sweep enumerates one bundled model per distinct
 * effort ladder at run time, so a model with a new ladder shape is covered the day it is generated.
 *
 * Not caught: a model whose provider rejects a level its catalog ladder lists. The catalog ladder is
 * the contract here, not the provider.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { type Effort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { formatModelStringWithRouting } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@veyyon/coding-agent/thinking";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

/** One bundled model per distinct `reasoning|ladder` shape, read from the catalog. */
function oneModelPerLadder(): Model<Api>[] {
	const byLadder = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider)) {
			// An id with a colon reads as a selector suffix; it has no ladder of its own to test.
			if (model.id.includes(":")) continue;
			const key = `${model.reasoning}|${getSupportedEfforts(model).join(",")}`;
			if (!byLadder.has(key)) byLadder.set(key, model);
		}
	}
	return [...byLadder.values()];
}

/** The level a model runs a requested effort at, stated from the ladder rather than from the clamp. */
function expectedFit(model: Model<Api>, requested: Effort): Effort | undefined {
	const ladder = getSupportedEfforts(model);
	if (!model.reasoning || ladder.length === 0) return undefined;
	if (ladder.includes(requested)) return requested;
	const at = THINKING_EFFORTS.indexOf(requested);
	const below = ladder.filter(level => THINKING_EFFORTS.indexOf(level) <= at);
	return below.at(-1) ?? ladder[0];
}

function registryFor(model: Model<Api>): ModelRegistry {
	return {
		authStorage: {},
		refresh: async () => {},
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
	} as unknown as ModelRegistry;
}

const REQUESTS: readonly (ConfiguredThinkingLevel | undefined)[] = [
	...THINKING_EFFORTS,
	ThinkingLevel.Off,
	AUTO_THINKING,
	undefined,
];

function expectedLevel(model: Model<Api>, requested: ConfiguredThinkingLevel | undefined) {
	if (requested === undefined || requested === ThinkingLevel.Off || requested === AUTO_THINKING) return requested;
	return expectedFit(model, requested as Effort);
}

async function spawnAt(
	model: Model<Api>,
	channel: { thinkingLevel?: ConfiguredThinkingLevel; parentThinkingLevel?: ConfiguredThinkingLevel },
	id: string,
) {
	const spy = vi
		.spyOn(sdkModule, "createAgentSession")
		.mockResolvedValue(
			createSessionResult(createMockSession(({ emit }) => emit(yieldSuccessEvent({ ok: true }, "fit")))),
		);
	const selector = `${model.provider}/${model.id}`;
	const result = await runSubprocess({
		cwd: "/tmp",
		agent,
		task: "do work",
		index: 0,
		id,
		settings: Settings.isolated(),
		modelRegistry: registryFor(model),
		enableLsp: false,
		modelOverride: [selector],
		// The parent runs some other model: its pattern is not the child's.
		parentActiveModelPattern: "anthropic/claude-sonnet-4-5",
		...channel,
	});
	const childOptions = spy.mock.calls.at(-1)?.[0];
	spy.mockRestore();
	if (!childOptions) throw new Error(`no child session was created for ${selector}`);
	return { result, childOptions };
}

describe("an agent's effort is fitted to the agent's own model", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const models = oneModelPerLadder();

	it("covers every ladder shape the catalog generates, including none and reasoning without a ladder", () => {
		const shapes = models.map(model => `${model.reasoning}|${getSupportedEfforts(model).join(",")}`);
		expect(shapes).toContain("false|");
		expect(shapes).toContain("true|");
		// A ladder missing the low end and one missing the high end are what make a clamp go both ways.
		expect(models.some(model => !getSupportedEfforts(model).includes(THINKING_EFFORTS[0]!))).toBe(true);
		expect(
			models.some(
				model =>
					getSupportedEfforts(model).length > 0 && !getSupportedEfforts(model).includes(THINKING_EFFORTS.at(-1)!),
			),
		).toBe(true);
	});

	for (const [channel, place] of [
		[
			"inherited from the parent",
			(level: ConfiguredThinkingLevel | undefined) => ({
				thinkingLevel: ThinkingLevel.Inherit,
				parentThinkingLevel: level,
			}),
		],
		[
			"configured on the agent",
			(level: ConfiguredThinkingLevel | undefined) => ({ thinkingLevel: level, parentThinkingLevel: undefined }),
		],
	] as const) {
		it(`runs a level ${channel} at what the agent's model accepts, and the badge states it`, async () => {
			for (const model of models) {
				const selector = formatModelStringWithRouting(model);
				for (const [index, requested] of REQUESTS.entries()) {
					const { result, childOptions } = await spawnAt(model, place(requested), `fit-${index}`);
					const expected = expectedLevel(model, requested);
					const label = `${selector} asked for ${requested ?? "nothing"} (${channel})`;
					expect(childOptions.thinkingLevel, label).toBe(expected);
					expect(result.resolvedModel, label).toBe(expected === undefined ? selector : `${selector}:${expected}`);
				}
			}
		});
	}

	it("lets the child pick its own effort when the parent has none, and the badge states what it picked", async () => {
		const model = models.find(candidate => getSupportedEfforts(candidate).includes(ThinkingLevel.High as Effort));
		if (!model) throw new Error("no bundled model accepts high");
		const spy = vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(
				createMockSession(({ emit }) => emit(yieldSuccessEvent({ ok: true }, "own-default")), {
					model,
					thinkingLevel: ThinkingLevel.High,
				}),
			),
		);
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "do work",
			index: 0,
			id: "own-default",
			settings: Settings.isolated(),
			modelRegistry: registryFor(model),
			enableLsp: false,
			modelOverride: [`${model.provider}/${model.id}`],
			thinkingLevel: ThinkingLevel.Inherit,
			parentThinkingLevel: undefined,
		});
		// Nothing is forced on the child, so it resolves its saved or model default itself.
		expect(spy.mock.calls[0]?.[0]?.thinkingLevel).toBeUndefined();
		expect(result.resolvedModel).toBe(`${formatModelStringWithRouting(model)}:high`);
	});
});
