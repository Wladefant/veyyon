/**
 * The model switches a caller makes: a saved choice, a session-only choice, and the Ctrl+P cycle
 * through the scoped models or, without them, every available model.
 *
 * This is a session collaborator. It holds the scoped models the session was created with and
 * reaches the session only through {@link ModelSelectionHost}. Every switch takes the same steps:
 * lift the model's suppressed selector, drop an active retry fallback and install the model, record
 * the change in the session file and in model usage, apply the switch's thinking level, and rebuild
 * the base system prompt when the switch moved one of its inputs.
 */
import type { Model } from "@veyyon/ai";
import { modelsAreEqual } from "@veyyon/catalog/models";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { missingCredentialsMessage } from "../../config/missing-credentials";
import { normalizeModelPatternList } from "../../config/model-pattern-list";
import type { ModelRegistry } from "../../config/model-registry";
import {
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	formatModelSelectorValue,
	formatModelStringWithRouting,
} from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { EditMode } from "../../utils/edit-mode";
import type { ModelCycleResult, SessionScopedModel } from "../agent-session-types";
import type { ThinkingRuntime } from "./thinking-runtime";

/** What {@link ModelSelection} needs from the session that holds it. */
export interface ModelSelectionHost {
	readonly settings: Pick<Settings, "get" | "getAgentDir" | "setDefaultModel">;
	readonly sessionManager: Pick<SessionManager, "appendModelChange">;
	readonly thinking: Pick<ThinkingRuntime, "level" | "reapplyForModel">;
	modelRegistry(): Pick<
		ModelRegistry,
		| "clearSuppressedSelector"
		| "find"
		| "getApiKey"
		| "getApiKeyForProvider"
		| "getAvailable"
		| "hasConfiguredAuth"
		| "refreshSelectedModelMetadata"
	>;
	/** The model the session runs now. */
	model(): Model | undefined;
	sessionId(): string;
	/** The edit mode the session resolves for its current model. */
	activeEditMode(): EditMode;
	/** Drop an active retry fallback and make `model` the agent's model, closing the provider session the previous model held. */
	installModel(model: Model): void;
	/** Rebuild the base system prompt when a switch moved one of its inputs since `previousEditMode` was read. */
	syncAfterModelChange(previousEditMode: EditMode): Promise<void>;
}

/** Options of {@link ModelSelection.setModel}. */
export interface SetModelOptions {
	/** The selector the caller chose, saved in place of `provider/id`. */
	selector?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Save the choice as the `defaultModel` setting. */
	persist?: boolean;
	currentContextTokens?: number;
}

/** How one switch records and settles the model it installs. */
interface ModelSwitch {
	/** The edit mode read before the switch, which decides whether the prompt is rebuilt. */
	previousEditMode: EditMode;
	/** The role the session file records the change under; the default role when undefined. */
	role?: string;
	/** The thinking selector the switch pins; the session override or the saved default when undefined. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** The `defaultModel` value saved once the change is recorded; nothing is saved when undefined. */
	defaultModel?: string;
}

/** The entry one step from the current one; the first entry counts as current when none is. */
function cycleStep<T>(entries: readonly T[], isCurrent: (entry: T) => boolean, direction: "forward" | "backward"): T {
	const current = Math.max(0, entries.findIndex(isCurrent));
	const count = entries.length;
	return entries[direction === "forward" ? (current + 1) % count : (current - 1 + count) % count];
}

export class ModelSelection {
	readonly #host: ModelSelectionHost;
	readonly #scoped: readonly SessionScopedModel[];

	constructor(host: ModelSelectionHost, scoped: readonly SessionScopedModel[]) {
		this.#host = host;
		this.#scoped = scoped;
	}

	/** The models Ctrl+P cycles through, from the `--models` flags. */
	get scoped(): readonly SessionScopedModel[] {
		return this.#scoped;
	}

	/**
	 * Switch to `model` and record it under `slot`. Throws when no credential source is configured
	 * for it, checked without refreshing OAuth or running a key program. A transcript too large for
	 * the model does not block the switch: the next prompt's compaction or error path recovers it.
	 */
	async setModel(model: Model, slot: string, options?: SetModelOptions): Promise<{ switched: boolean }> {
		const previousEditMode = this.#host.activeEditMode();
		const target = await this.#credentialedMetadata(model);
		await this.#switchTo(target, {
			previousEditMode,
			role: slot,
			thinkingLevel: options?.thinkingLevel,
			defaultModel: options?.persist
				? this.#defaultModelValue(target, options.selector, options.thinkingLevel)
				: undefined,
		});
		return { switched: true };
	}

	/**
	 * Switch to `model` for this session only: the session file records it, the `defaultModel`
	 * setting does not. Throws as {@link setModel} does.
	 */
	async setModelTemporary(
		model: Model,
		thinkingLevel?: ConfiguredThinkingLevel,
		options?: { ephemeral?: boolean },
	): Promise<void> {
		const previousEditMode = this.#host.activeEditMode();
		const target = await this.#credentialedMetadata(model);
		await this.#switchTo(target, {
			previousEditMode,
			role: options?.ephemeral ? EPHEMERAL_MODEL_CHANGE_ROLE : "temporary",
			thinkingLevel,
		});
	}

	/**
	 * Switch to the next or previous model: among the scoped models that have an API key, or among
	 * every available model when the session has no scoped models. Returns undefined when there is
	 * at most one model to cycle through.
	 */
	async cycle(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const previousEditMode = this.#host.activeEditMode();
		if (this.#scoped.length > 0) {
			const scoped = await this.#scopedWithApiKey();
			if (scoped.length <= 1) return undefined;
			const current = this.#host.model();
			const next = cycleStep(scoped, entry => modelsAreEqual(entry.model, current), direction);
			// An unsuffixed scoped entry re-reads the current saved per-model default; only an explicit
			// scope suffix is a selector pin.
			await this.#switchTo(next.model, {
				previousEditMode,
				thinkingLevel: next.explicitThinkingLevel ? next.thinkingLevel : undefined,
			});
			return { model: next.model, thinkingLevel: this.#host.thinking.level, isScoped: true };
		}

		const registry = this.#host.modelRegistry();
		const available = registry.getAvailable();
		if (available.length <= 1) return undefined;
		const current = this.#host.model();
		const next = cycleStep(available, model => modelsAreEqual(model, current), direction);
		const apiKey = await registry.getApiKey(next, this.#host.sessionId());
		if (!apiKey) {
			throw new Error(missingCredentialsMessage(next.provider, next.id, "the next model in the cycle"));
		}
		await this.#switchTo(next, { previousEditMode });
		return { model: next, thinkingLevel: this.#host.thinking.level, isScoped: false };
	}

	/** Every available model with a valid API key, narrowed by the `enabledModels` patterns when set. */
	available(): Model[] {
		const all = this.#host.modelRegistry().getAvailable();
		const patterns = this.#host.settings.get("enabledModels");
		if (!patterns || patterns.length === 0) return all;
		return filterAvailableModelsByEnabledPatterns(all, patterns);
	}

	/** `model` with refreshed metadata, after checking that a credential source is configured for it. */
	async #credentialedMetadata(model: Model): Promise<Model> {
		const registry = this.#host.modelRegistry();
		if (!registry.hasConfiguredAuth(model)) {
			throw new Error(missingCredentialsMessage(model.provider, model.id, "the requested model"));
		}
		return registry.refreshSelectedModelMetadata(model);
	}

	async #switchTo(model: Model, change: ModelSwitch): Promise<void> {
		const selector = `${model.provider}/${model.id}`;
		this.#host.modelRegistry().clearSuppressedSelector(formatModelStringWithRouting(model));
		this.#host.installModel(model);
		this.#host.sessionManager.appendModelChange(selector, change.role);
		if (change.defaultModel !== undefined) this.#host.settings.setDefaultModel(change.defaultModel);
		AgentStorage.forAgentDir(this.#host.settings.getAgentDir())?.recordModelUsage(selector);
		this.#host.thinking.reapplyForModel(change.thinkingLevel);
		await this.#host.syncAfterModelChange(change.previousEditMode);
	}

	/** The scoped models whose provider has an API key, each provider's key read once. */
	async #scopedWithApiKey(): Promise<SessionScopedModel[]> {
		const registry = this.#host.modelRegistry();
		const keyed = new Map<string, boolean>();
		const result: SessionScopedModel[] = [];
		for (const scoped of this.#scoped) {
			const provider = scoped.model.provider;
			let hasKey = keyed.get(provider);
			if (hasKey === undefined) {
				hasKey = Boolean(await registry.getApiKeyForProvider(provider, this.#host.sessionId()));
				keyed.set(provider, hasKey);
			}
			if (hasKey) result.push(scoped);
		}
		return result;
	}

	/**
	 * The `defaultModel` value a saved switch writes: the chosen selector, carrying an explicit
	 * effort suffix when one was passed or when the configured primary already named one.
	 */
	#defaultModelValue(model: Model, selector?: string, thinkingLevel?: ConfiguredThinkingLevel): string {
		const modelKey = selector ?? `${model.provider}/${model.id}`;
		if (thinkingLevel !== undefined) return formatModelSelectorValue(modelKey, thinkingLevel);
		const [primary] = normalizeModelPatternList(this.#host.settings.get("defaultModel"));
		const configured = extractExplicitThinkingSelector(primary, {
			isLiteralModelId: (provider, id) => this.#host.modelRegistry().find(provider, id) !== undefined,
		});
		return formatModelSelectorValue(modelKey, configured);
	}
}
