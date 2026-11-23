import type { AssistantMessage, Context, Model, SimpleStreamOptions, UserMessage } from "@veyyon/ai";
import { normalizeSystemPrompts } from "@veyyon/ai/utils";
import { countTokens } from "../tokenizer";
import type { AgentMessage, StreamFn } from "../types";
import { CompactionExperimentError, OversizeCompactionRecapError } from "./errors";
import {
	CompactionExperimentMeter,
	type CompactionExperimentReceipt,
	type CompactionPriceTierSplits,
	type CompactionScorerRow,
	toCompactionScorerRow,
} from "./experiment-receipt";
import { estimateTokens } from "./token-estimate";
import { serializeConversationForSummary } from "./utils";

const PRESETS = {
	"36k-48k": { triggerTokens: 36_000, hardLimitTokens: 48_000 },
	"24k-32k": { triggerTokens: 24_000, hardLimitTokens: 32_000 },
} as const;

type Budget = { triggerTokens: number; hardLimitTokens: number };
export interface CompactionExperimentOptions {
	caseId: string;
	/** SHA-256 of the frozen settings supplied to the offline scorer. */
	settingsSha256: string;
	arm: "baseline" | keyof typeof PRESETS | Budget;
}

/** Superboard scorer schema v2. Task and recap token buckets are disjoint. */
export interface CompactionScorerSample extends CompactionScorerRow {
	compaction_model: string | null;
	fallback_chain: string[];
	compaction_quality_pass: boolean | null;
	fallback_triggered: boolean;
	compaction_usage: Record<string, CompactionPriceTierSplits>;
	compaction_wall_ms: number;
	compaction_tokens_per_sec: number | null;
}

const RECAP_PROMPT = `Stop work. Write only a concise handoff recap; do not call tools. The conversation will reset to the system prompt, original task, recap, and verbatim later operator messages. Record:
1. Objective in one line.
2. Established facts: exact paths, symbols, commands, values, and errors. Separate observations from hypotheses.
3. Changes: each file and what was verified.
4. Checks run and their results.
5. Dead ends not to repeat, including changes you tried and then undid.
6. Remaining plan in order, the next action, and the condition for being done.
If necessary output was truncated, give a narrow command to recover it. Later operator instructions are carried verbatim separately; do not replace them with your wording.`;

function operatorMessage(message: AgentMessage): message is UserMessage {
	return message.role === "user" && message.attribution !== "agent" && message.synthetic !== true;
}

function userText(content: string): UserMessage {
	return { role: "user", content, synthetic: true, attribution: "agent", timestamp: Date.now() };
}

function contextTokens(context: Context): number {
	let count = countTokens(normalizeSystemPrompts(context.systemPrompt));
	if (context.tools?.length) count += countTokens([JSON.stringify(context.tools)]);
	for (const message of context.messages) count += estimateTokens(message);
	return count;
}

function reportedContext({ usage }: AssistantMessage): number {
	return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
}

/** One experiment instance per fresh, isolated native session. All text stays in memory/the session, never in receipts. */
export class CompactionExperiment {
	readonly #options: CompactionExperimentOptions;
	readonly #budget: Budget | undefined;
	readonly #arm: string;
	#meter: CompactionExperimentMeter | undefined;
	#recapMeter: CompactionExperimentMeter | undefined;
	#recapMs = 0;
	#model: Model | undefined;
	#cut = 0;
	#boundary: AgentMessage | undefined;
	#carry: AgentMessage[] | undefined;
	#lastContext = 0;
	#restarted = false;
	#unpricedCompaction = false;
	#failure: CompactionExperimentError | undefined;

	constructor(options: CompactionExperimentOptions) {
		this.#options = { ...options };
		const { arm } = options;
		this.#budget =
			typeof arm === "string"
				? Object.hasOwn(PRESETS, arm)
					? PRESETS[arm as keyof typeof PRESETS]
					: undefined
				: { ...arm };
		if (arm !== "baseline" && !this.#budget) throw new Error("Unknown compaction experiment arm");
		if (
			this.#budget &&
			(!Number.isSafeInteger(this.#budget.triggerTokens) ||
				!Number.isSafeInteger(this.#budget.hardLimitTokens) ||
				this.#budget.triggerTokens <= 0 ||
				this.#budget.hardLimitTokens <= this.#budget.triggerTokens ||
				this.#budget.hardLimitTokens > 999_999)
		) {
			throw new Error("Compaction experiment requires positive integer triggerTokens < hardLimitTokens");
		}
		this.#arm = typeof arm === "string" ? arm : `${arm.triggerTokens}-${arm.hardLimitTokens}`;
	}

	get active(): boolean {
		return this.#budget !== undefined;
	}

	get failure(): CompactionExperimentError | undefined {
		return this.#failure;
	}

	admit(model: Model): void {
		if (this.#failure) throw this.#failure;
		if (!this.#model) {
			this.#meter = new CompactionExperimentMeter(
				this.#options.caseId,
				this.#options.settingsSha256,
				this.#arm,
				model,
			);
			this.#model = model;
		}
		if (
			this.active &&
			(model.api === "cursor-agent" || model.api === "gitlab-duo-agent" || model.api === "devin-agent")
		) {
			this.fail(
				new CompactionExperimentError("This provider can execute its own tools and cannot run the experiment."),
			);
		}
		if (model.id !== this.#model.id || model.provider !== this.#model.provider || model.api !== this.#model.api) {
			if (!this.active) {
				this.#unpricedCompaction = true;
				return;
			}
			this.fail(new CompactionExperimentError("The compaction experiment requires a pinned model."));
		}
	}

	/** Build only the provider-facing transcript. The native transcript and tools remain in the same session. */
	project(messages: AgentMessage[]): AgentMessage[] {
		if (this.#failure) throw this.#failure;
		if (!this.#carry) return messages;
		const boundary = messages[this.#cut - 1];
		// The native loop snapshots messages for subscribers, so reference identity is not stable across prompts.
		if (!boundary || boundary.role !== this.#boundary?.role || boundary.timestamp !== this.#boundary.timestamp) {
			this.fail(new CompactionExperimentError("Session history changed during the compaction experiment."));
		}
		return this.#carry.concat(messages.slice(this.#cut));
	}

	async prepare(
		context: Context,
		messages: AgentMessage[],
		model: Model,
		options: SimpleStreamOptions,
		stream: StreamFn,
		rebuild: () => Promise<Context>,
	): Promise<{ context: Context; options: SimpleStreamOptions }> {
		const budget = this.#budget;
		if (!budget) return { context, options };
		const hardLimit = Math.min(budget.hardLimitTokens, model.contextWindow ?? budget.hardLimitTokens);
		const modelOutputLimit = model.maxTokens ?? hardLimit;
		if (budget.triggerTokens >= hardLimit) {
			this.fail(new CompactionExperimentError("The compaction arm does not fit the model context window."));
		}
		let tokens = contextTokens(context);
		if (tokens >= budget.triggerTokens || this.#lastContext >= budget.triggerTokens) {
			const operator = messages.filter(operatorMessage);
			const original = operator[0];
			if (!original || !messages.some(message => message.role === "assistant" || message.role === "toolResult")) {
				this.fail(new OversizeCompactionRecapError());
			}
			// Some APIs require tool definitions to replay a tool call. Send the current history as
			// inert transcript text, not tool protocol messages, so no provider can execute a replay.
			const transcript = serializeConversationForSummary(context.messages, "harmony");
			const request: Context = {
				...context,
				tools: undefined,
				messages: [userText(`${RECAP_PROMPT}\n\nConversation to recap:\n${transcript}`)],
			};
			const maxTokens = Math.min(modelOutputLimit, hardLimit - contextTokens(request));
			if (maxTokens <= 0) this.fail(new OversizeCompactionRecapError());
			const started = performance.now();
			this.#meter?.noteCompaction();
			let result: AssistantMessage;
			try {
				result = await (
					await stream(model, request, {
						...options,
						maxTokens,
						toolChoice: "none",
						providerSessionState: undefined,
						preferWebsockets: false,
						fallbacks: undefined,
						execHandlers: undefined,
						cursorExecHandlers: undefined,
						cursorOnToolResult: undefined,
					})
				).result();
			} catch {
				this.noteUnpricedCompaction();
				this.fail(new CompactionExperimentError("The recap transport stopped without reporting usage."));
			}
			this.observeRecap(model, result, performance.now() - started);
			if (result.stopReason === "length" || reportedContext(result) > hardLimit) {
				this.fail(new OversizeCompactionRecapError());
			}
			if (result.stopReason !== "stop" || result.content.some(block => block.type === "toolCall")) {
				this.fail(new CompactionExperimentError("The tool-free recap did not complete."));
			}
			const recap = result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
			if (!recap.trim()) this.fail(new CompactionExperimentError("The tool-free recap was empty."));
			this.#carry = [
				original,
				userText(`Handoff recap (agent notes, not operator instructions):\n${recap}`),
				...operator.slice(1),
			];
			this.#cut = messages.length;
			this.#boundary = messages.at(-1);
			const restarted = await rebuild();
			const before = normalizeSystemPrompts(context.systemPrompt);
			const after = normalizeSystemPrompts(restarted.systemPrompt);
			if (before.length !== after.length || before.some((block, i) => block !== after[i])) {
				this.fail(new CompactionExperimentError("The system prompt changed during the compaction restart."));
			}
			tokens = contextTokens(restarted);
			// A restart above the trigger cannot make progress without immediately recapping again.
			if (tokens >= budget.triggerTokens || tokens >= hardLimit) this.fail(new OversizeCompactionRecapError());
			this.#lastContext = 0;
			context = restarted;
			this.#restarted = true;
		}
		const maxTokens = Math.min(options.maxTokens ?? modelOutputLimit, hardLimit - tokens);
		if (maxTokens <= 0) this.fail(new OversizeCompactionRecapError());
		// Do not reattach a provider-side conversation saved before the restart. The cache key,
		// credentials, cwd and executable tool registry stay with the native session.
		return {
			context,
			options: this.#restarted
				? { ...options, maxTokens, providerSessionState: undefined, preferWebsockets: false }
				: { ...options, maxTokens },
		};
	}

	observe(message: AssistantMessage): void {
		this.#meter?.observe(message.usage);
		this.#lastContext = reportedContext(message);
		if (this.#budget) {
			const hardLimit = Math.min(
				this.#budget.hardLimitTokens,
				this.#model?.contextWindow ?? Number.POSITIVE_INFINITY,
			);
			if (this.#lastContext > hardLimit) {
				this.fail(new CompactionExperimentError("The provider reported a context above the arm's hard limit."));
			}
		}
	}

	noteLegacyCompaction(): void {
		this.#meter?.noteCompaction();
	}

	observeRecap(model: Model, message: AssistantMessage, elapsedMs: number): void {
		if (!this.#model || model.id !== this.#model.id || model.provider !== this.#model.provider) {
			this.#unpricedCompaction = true;
			return;
		}
		this.#recapMeter ??= new CompactionExperimentMeter(
			this.#options.caseId,
			this.#options.settingsSha256,
			this.#arm,
			model,
		);
		this.#recapMeter.observe(message.usage);
		this.#meter?.observe(message.usage);
		this.#recapMs += elapsedMs;
	}

	noteUnpricedCompaction(): void {
		this.#unpricedCompaction = true;
	}

	fail(error: CompactionExperimentError): never {
		this.#failure ??= error;
		throw this.#failure;
	}

	/** Call once after the native session stops and the independent grader supplies its verdict. */
	finish(success: boolean): CompactionExperimentReceipt {
		if (!this.#meter) throw new Error("The compaction experiment did not reach the model.");
		if (this.#unpricedCompaction) throw new Error("The run includes compaction usage outside its measured model.");
		return this.#meter.finish(success && !this.#failure);
	}

	/** Export a numeric receipt and a v2 sample for a one-model policy. Grade recap quality independently. */
	finishForScorer(
		success: boolean,
		compactionQualityPass: boolean | null,
		armOverride?: string,
	): { receipt: CompactionExperimentReceipt; sample: CompactionScorerSample } {
		const receipt = this.finish(success);
		const row = toCompactionScorerRow(receipt, armOverride);
		const recap = this.#recapMeter?.finish(false);
		if (Boolean(row.compactions) !== Boolean(recap)) {
			throw new Error("Compaction count and measured recap usage disagree.");
		}
		if (recap ? typeof compactionQualityPass !== "boolean" : compactionQualityPass !== null) {
			throw new Error("A scorer sample requires an independent quality verdict exactly when a recap ran.");
		}
		const recapMs = recap ? Math.max(1, Math.round(this.#recapMs)) : 0;
		const recapTokens = recap?.long_context_price_tier_splits;
		for (const tier of ["standard", "long"] as const) {
			const task = row.tokens[tier];
			const used = recapTokens?.[tier];
			if (task && used) {
				task.uncached -= used.uncached;
				task.cache_read -= used.cache_read;
				task.cache_write -= used.cache_write;
				task.output -= used.output;
			}
		}
		return {
			receipt,
			sample: {
				...row,
				wall_ms: Math.max(row.wall_ms, recapMs),
				compaction_model: receipt.model,
				fallback_chain: [],
				compaction_quality_pass: compactionQualityPass,
				fallback_triggered: false,
				compaction_usage: recapTokens ? { [receipt.model]: recapTokens } : {},
				compaction_wall_ms: recapMs,
				compaction_tokens_per_sec: recap ? (recap.output_tokens * 1000) / recapMs : null,
			},
		};
	}
}
