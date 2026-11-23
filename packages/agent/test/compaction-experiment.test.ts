import { describe, expect, it } from "bun:test";
import { type AssistantMessage, type Context, type SimpleStreamOptions, z } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { Agent } from "../src/agent";
import { agentLoop } from "../src/agent-loop";
import { CompactionExperimentError, OversizeCompactionRecapError } from "../src/compaction/errors";
import { CompactionExperiment, type CompactionExperimentOptions } from "../src/compaction/experiment";
import type { CompactionScorerManifest } from "../src/compaction/experiment-receipt";
import { createCustomMessage, defaultConvertToLlm } from "../src/compaction/messages";
import { compactionRecapSource } from "../src/compaction/recap-request";
import type { StreamFn } from "../src/types";
import { createAssistantMessage, createUserMessage, identityConverter } from "./helpers";

const MODEL = { ...createMockModel({ responses: [] }).model, contextWindow: 100_000, maxTokens: 100_000 };
const SYSTEM = ["System prefix\r\nFirst block.", "Unmodified second block."];
const ORIGINAL = "  Exact original task.\nDo not alter the spaces.  ";
const CORRECTION = "Actually: KEEP `Case`.\r\n\tDo not do step 3.  ";
const DEAD_END = "Do not repeat the DB cache change: the check failed, and I undid it.";
const SETTINGS_SHA256 = "a".repeat(64);
const MODEL_ID = `${MODEL.provider}/${MODEL.id}`;
const MANIFEST: CompactionScorerManifest = {
	schema_version: 2,
	model: MODEL_ID,
	settings_sha256: SETTINGS_SHA256,
	cases: ["native-fixture", ...Array.from({ length: 9 }, (_, i) => `fixture-${i}`)],
	control: { compaction_model: null, fallback_chain: [] },
	arms: {
		"36k-48k": { mode: "36k-48k", compaction_model: MODEL_ID, fallback_chain: [] },
		"24k-32k": { mode: "24k-32k", compaction_model: MODEL_ID, fallback_chain: [] },
	},
};

function experiment(arm: CompactionExperimentOptions["arm"]): CompactionExperiment {
	return new CompactionExperiment({ arm, caseId: "native-fixture", settingsSha256: SETTINGS_SHA256 });
}

function reply(input: number, output: number, text: string, reason: "stop" | "length" = "stop"): AssistantMessage {
	const message = createAssistantMessage([{ type: "text", text }], reason);
	message.usage = { ...message.usage, input, output, totalTokens: input + output };
	message.timestamp = 1_000;
	return message;
}

function provider(responses: AssistantMessage[]) {
	const calls: { context: Context; options: SimpleStreamOptions | undefined }[] = [];
	const stream: StreamFn = (_model, context, options) => {
		const response = responses[calls.length];
		if (!response) throw new Error("Unexpected provider call");
		calls.push({ context, options });
		const result = new AssistantMessageEventStream();
		result.push({ type: "done", reason: response.stopReason as "stop" | "length", message: response });
		result.end();
		return result;
	};
	return { calls, stream };
}

function native(arm: CompactionExperiment | undefined, streamFn: StreamFn) {
	return new Agent({
		initialState: { model: MODEL, systemPrompt: SYSTEM },
		streamFn,
		compactionExperiment: arm,
		convertToLlm: identityConverter,
		cwd: "isolated-benchmark-workspace",
		promptCacheKey: "same-prefix-cache-key",
		providerSessionState: new Map(),
	});
}

describe("native compaction experiment request boundary", () => {
	it("leaves the unconfigured loop and the measured baseline on the same request path", async () => {
		const baseline = experiment("baseline");
		const plain = provider([reply(36_000, 100, DEAD_END), reply(10, 2, "done")]);
		const measured = provider([reply(36_000, 100, DEAD_END), reply(10, 2, "done")]);
		const first = createUserMessage(ORIGINAL, 100);
		const correction = createUserMessage(CORRECTION, 101);
		const control = native(undefined, plain.stream);
		const instrumented = native(baseline, measured.stream);
		for (const agent of [control, instrumented]) {
			await agent.prompt(first);
			await agent.prompt(correction);
		}
		expect(measured.calls.map(call => call.context)).toEqual(plain.calls.map(call => call.context));
		expect(measured.calls.map(call => call.options?.maxTokens)).toEqual(
			plain.calls.map(call => call.options?.maxTokens),
		);
		expect(baseline.finish(true)).toMatchObject({ arm: "baseline", success: true, compactions: 0 });
	});

	for (const [arm, trigger, hard] of [
		["36k-48k", 36_000, 48_000],
		["24k-32k", 24_000, 32_000],
	] as const) {
		it(`${arm} does not recap one token below its trigger`, async () => {
			const exp = experiment(arm);
			const endpoint = provider([reply(trigger - 2, 1, DEAD_END), reply(15, 2, "done")]);
			const agent = native(exp, endpoint.stream);
			await agent.prompt(ORIGINAL);
			await agent.prompt(CORRECTION);
			expect(endpoint.calls).toHaveLength(2);
			expect(endpoint.calls[1].context.messages.map(message => message.role)).toEqual(["user", "assistant", "user"]);
			expect(exp.finish(true).compactions).toBe(0);
		});

		it(`${arm} recaps at its trigger, preserves the task and correction, and charges the recap`, async () => {
			const exp = experiment(arm);
			const endpoint = provider([
				reply(trigger - 1, 1, DEAD_END),
				reply(111, 11, DEAD_END),
				reply(50, 3, "new final output"),
			]);
			const agent = native(exp, endpoint.stream);
			await agent.prompt(createUserMessage(ORIGINAL, 100));
			await agent.prompt(createUserMessage(CORRECTION, 101));

			expect(agent.state.error).toBeUndefined();
			expect(endpoint.calls).toHaveLength(3);
			const [first, recap, restart] = endpoint.calls;
			expect(first.options?.maxTokens).toBeLessThan(hard);
			expect(recap.context.tools).toBeUndefined();
			expect(compactionRecapSource(recap.context)?.messages.at(-1)?.content).toBe(CORRECTION);
			expect(compactionRecapSource(restart.context)).toBeUndefined();
			expect(recap.options?.toolChoice).toBe("none");
			expect(recap.options?.cursorExecHandlers).toBeUndefined();
			expect(recap.context.messages).toHaveLength(1);
			expect(JSON.stringify(recap.context.messages)).toContain("Dead ends not to repeat");
			expect(JSON.stringify(recap.context.messages)).toContain(DEAD_END);
			expect(restart.context.systemPrompt).toEqual(first.context.systemPrompt);
			expect(restart.options?.cwd).toBe(first.options?.cwd);
			expect(restart.options?.promptCacheKey).toBe(first.options?.promptCacheKey);
			expect(restart.options?.providerSessionState).toBeUndefined();
			expect(restart.context.messages).toMatchObject([
				{ role: "user", content: ORIGINAL },
				{ role: "user", content: expect.stringContaining(DEAD_END) },
				{ role: "user", content: CORRECTION },
			]);
			expect(agent.state.messages.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
			const { receipt, sample } = exp.finishForScorer(true, true, MANIFEST);
			expect(receipt).toMatchObject({
				arm,
				success: true,
				compactions: 1,
				peak_context_tokens: trigger,
				uncached_input_tokens: trigger - 1 + 111 + 50,
				output_tokens: 15,
			});
			expect(Object.keys(sample).sort()).toEqual([
				"arm",
				"case",
				"compaction_model",
				"compaction_quality_pass",
				"compaction_tokens_per_sec",
				"compaction_usage",
				"compaction_wall_ms",
				"compactions",
				"fallback_chain",
				"fallback_triggered",
				"peak_context",
				"success",
				"tokens",
				"wall_ms",
			]);
			expect(sample.tokens.standard.uncached).toBe(trigger - 1 + 50);
			expect(sample.compaction_usage[receipt.model].standard).toMatchObject({ uncached: 111, output: 11 });
			expect(sample.compaction_tokens_per_sec).toBe((11 * 1000) / sample.compaction_wall_ms);
			const serialized = JSON.stringify({ receipt, sample });
			for (const privateText of [
				"System prefix",
				"Exact original task",
				"DB cache change",
				"KEEP",
				"new final output",
			]) {
				expect(serialized).not.toContain(privateText);
			}
		});
	}

	it("carries user-authored custom messages verbatim without retaining agent notices", async () => {
		const exp = experiment("24k-32k");
		const endpoint = provider([reply(23_999, 1, DEAD_END), reply(25, 5, DEAD_END), reply(20, 2, "done")]);
		const agent = new Agent({
			initialState: { model: MODEL, systemPrompt: SYSTEM },
			compactionExperiment: exp,
			convertToLlm: defaultConvertToLlm,
			streamFn: endpoint.stream,
		});
		const skill = createCustomMessage(
			"skill-prompt",
			CORRECTION,
			true,
			undefined,
			new Date(120).toISOString(),
			"user",
		);
		const notice = createCustomMessage(
			"notice",
			"Not an operator ask.",
			true,
			undefined,
			new Date(121).toISOString(),
			"agent",
		);
		await agent.prompt(createUserMessage(ORIGINAL, 119));
		await agent.prompt([skill, notice, createUserMessage("Keep that correction.", 122)]);
		expect(endpoint.calls).toHaveLength(3);
		expect(endpoint.calls[2].context.messages).toMatchObject([
			{ role: "user", content: ORIGINAL },
			{ role: "user", content: expect.stringContaining(DEAD_END) },
			{ role: "developer", attribution: "user", content: [{ type: "text", text: CORRECTION }] },
			{ role: "user", content: "Keep that correction." },
		]);
	});

	it("keeps a finite arm limit when catalog window and output limits are unknown", async () => {
		const exp = experiment("24k-32k");
		const endpoint = provider([reply(31_999, 1, "done")]);
		const model = { ...MODEL, contextWindow: null, maxTokens: null };
		const stream = agentLoop(
			[createUserMessage(ORIGINAL)],
			{ systemPrompt: SYSTEM, messages: [], tools: [] },
			{ model, convertToLlm: identityConverter, compactionExperiment: exp },
			undefined,
			endpoint.stream,
		);
		await stream.result();
		expect(endpoint.calls[0].options?.maxTokens).toBeGreaterThan(0);
		expect(endpoint.calls[0].options?.maxTokens).toBeLessThan(32_000);
		expect(exp.finish(true)).toMatchObject({ success: true, peak_context_tokens: 32_000 });
	});

	it("fails the case when measured usage exceeds the hard limit by one token", async () => {
		const exp = experiment("36k-48k");
		const endpoint = provider([reply(48_000, 1, "over budget")]);
		const agent = native(exp, endpoint.stream);
		await agent.prompt(ORIGINAL);
		expect(exp.failure).toBeInstanceOf(CompactionExperimentError);
		expect(exp.finish(true)).toMatchObject({ success: false, peak_context_tokens: 48_001 });
		expect(endpoint.calls).toHaveLength(1);
	});

	it("counts the system prompt and tool schemas before a request", async () => {
		const exp = experiment({ triggerTokens: 2_000, hardLimitTokens: 4_000 });
		const endpoint = provider([reply(8, 1, DEAD_END)]);
		const model = MODEL;
		const tool = {
			name: "fixture",
			label: "Fixture",
			description: "large schema ".repeat(900),
			parameters: z.object({}),
			execute: async () => ({ content: [], details: {} }),
		};
		const stream = agentLoop(
			[createUserMessage(ORIGINAL)],
			{ systemPrompt: ["prefix ".repeat(1_000)], messages: [], tools: [tool] },
			{
				model,
				convertToLlm: identityConverter,
				compactionExperiment: exp,
			},
			undefined,
			endpoint.stream,
		);
		await expect(stream.result()).rejects.toBeInstanceOf(OversizeCompactionRecapError);
		expect(endpoint.calls).toHaveLength(0);
	});

	it("does not execute a tool even if the recap transport returns a tool call", async () => {
		let ran = false;
		const illegal = createAssistantMessage([{ type: "toolCall", id: "illegal", name: "fixture", arguments: {} }]);
		const endpoint = provider([reply(23_999, 1, DEAD_END), illegal]);
		const exp = experiment("24k-32k");
		const agent = native(exp, endpoint.stream);
		agent.setTools([
			{
				name: "fixture",
				label: "Fixture",
				description: "Fixture side effect",
				parameters: z.object({}),
				execute: async () => {
					ran = true;
					return { content: [], details: {} };
				},
			},
		]);
		await agent.prompt(ORIGINAL);
		await agent.prompt(CORRECTION);
		expect(endpoint.calls[0].context.tools?.map(tool => tool.name)).toEqual(["fixture"]);
		expect(endpoint.calls[1].context.tools).toBeUndefined();
		expect(ran).toBe(false);
		expect(exp.failure).toBeInstanceOf(CompactionExperimentError);
		expect(exp.finish(true).success).toBe(false);
	});

	it("hard-fails an oversized recap, retains the transcript, and never restarts or retries", async () => {
		for (const recap of [reply(20, 3, "partial recap", "length"), reply(20, 3, "oversize ".repeat(20_000))]) {
			const exp = experiment("24k-32k");
			const endpoint = provider([reply(23_999, 1, DEAD_END), recap]);
			const agent = native(exp, endpoint.stream);
			await agent.prompt(ORIGINAL);
			await agent.prompt(CORRECTION);
			expect(exp.failure).toBeInstanceOf(OversizeCompactionRecapError);
			expect(endpoint.calls).toHaveLength(2);
			expect(
				agent.state.messages.some(
					message => message.role === "assistant" && JSON.stringify(message.content).includes(DEAD_END),
				),
			).toBe(true);
			await agent.prompt("Do not dispatch a third provider request");
			expect(endpoint.calls).toHaveLength(2);
			expect(exp.finish(true)).toMatchObject({ success: false, compactions: 1 });
		}
	});
});
