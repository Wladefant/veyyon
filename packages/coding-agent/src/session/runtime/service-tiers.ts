/**
 * Service tiers: the per-family tier map a session sends (`/fast`, `tier.*`) and the tier each
 * request resolves to.
 *
 * This is a session collaborator. It holds the live map, records every change in the session file,
 * and reaches the session only through {@link ServiceTiersHost}.
 *
 * - **The map** ({@link ServiceTiers.byFamily}, {@link ServiceTiers.setFamily},
 *   {@link ServiceTiers.replace}) holds one tier per family (OpenAI, Anthropic, Google). A change
 *   through `setFamily` is persisted; `replace` installs the map a session switch loaded, which is
 *   already on disk.
 * - **`/fast`** ({@link ServiceTiers.setFastMode}, {@link ServiceTiers.toggleFastMode}) sets the
 *   active model's family to `priority`, and turning it off returns the family to the tier the
 *   settings configure.
 * - **The wire tier** ({@link ServiceTiers.effective}) is what one request to a model carries;
 *   Fireworks reads its own setting instead of the map.
 */
import type {
	AssistantMessage,
	Model,
	ProviderSessionState,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
} from "@veyyon/ai";
import { clearAnthropicFastModeFallback } from "@veyyon/ai/providers/anthropic-session-state";
import { isFireworksFastModelId } from "@veyyon/catalog/fireworks-model-id";
import {
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
} from "@veyyon/catalog/provider-models/service-tier";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { PRIORITY_TIER_COMMAND_LABEL } from "../../config/service-tier";

/** What {@link ServiceTiers} needs from the session that holds it. */
export interface ServiceTiersHost {
	/** The model the next request goes to. */
	model(): Model | undefined;
	/** Whether Providers › Fireworks Tier is `priority`. */
	fireworksPriority(): boolean;
	/** The per-family tiers the `tier.*` settings configure. */
	configuredTiers(): ServiceTierByFamily;
	/** The provider session states; re-arming Anthropic priority clears their fast-mode fallback flag. */
	readonly providerSessionStates: Map<string, ProviderSessionState>;
	/** The transcript every tier change is recorded in. */
	readonly sessionStore: Pick<SessionManager, "appendServiceTierChange">;
	emitNotice(level: "info" | "warning", message: string, source: string): void;
}

export class ServiceTiers {
	readonly #host: ServiceTiersHost;
	#byFamily: ServiceTierByFamily;

	constructor(host: ServiceTiersHost, byFamily: ServiceTierByFamily) {
		this.#host = host;
		this.#byFamily = byFamily;
	}

	/** Live per-family service tiers (OpenAI / Anthropic / Google). */
	get byFamily(): ServiceTierByFamily {
		return this.#byFamily;
	}

	/** Install a map without recording it: the one a session switch loaded, or the one it rolls back to. */
	replace(byFamily: ServiceTierByFamily): void {
		this.#byFamily = byFamily;
	}

	/** The persisted form of the map: `null` when no family carries a tier. */
	entry(): ServiceTierByFamily | null {
		return Object.keys(this.#byFamily).length > 0 ? this.#byFamily : null;
	}

	/**
	 * True when the currently selected model's family is set to `priority` — the
	 * `/fast` on/off state for the active model. Returns false when no model is
	 * selected or the model exposes no service-tier family (e.g. Fireworks, which
	 * has its own Providers › Fireworks Tier toggle).
	 *
	 * For "is priority actually applied to the next request?" use
	 * {@link fastModeActive} instead.
	 */
	fastModeEnabled(): boolean {
		const model = this.#host.model();
		const family = model ? serviceTierFamily(model) : undefined;
		return family ? this.#byFamily[family] === "priority" : false;
	}

	/**
	 * True when `priority` is actually realized on the wire for the currently
	 * selected model (OpenAI/Google `service_tier`, direct Anthropic fast mode,
	 * or Fireworks priority). Returns false for tiers the active model can't
	 * realize and when no model is selected.
	 */
	fastModeActive(): boolean {
		const model = this.#host.model();
		return !!model && realizesPriorityServiceTier(this.effective(model), model);
	}

	/**
	 * Effective wire service-tier for a request to `model`. Fireworks models take
	 * the Priority serving path only when the Providers › Fireworks Tier setting
	 * is `"priority"` (and never for `-fast` variants, whose Fast serving path is
	 * mutually exclusive with Priority). Every other model resolves the live
	 * per-family tier map down to the entry for its family.
	 */
	effective(model: Model | undefined = this.#host.model()): ServiceTier | undefined {
		if (model?.provider === "fireworks") {
			return this.#host.fireworksPriority() && !isFireworksFastModelId(model.id) ? "priority" : undefined;
		}
		if (!model) return undefined;
		return resolveModelServiceTier(this.#byFamily, model);
	}

	/** Set one family's tier (or clear it with `undefined`); persists the change. */
	setFamily(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (this.#byFamily[family] === tier) return;
		const next: ServiceTierByFamily = { ...this.#byFamily };
		if (tier) next[family] = tier;
		else delete next[family];
		// Re-arming Anthropic priority clears the per-session fast-mode auto-disable
		// so the next request carries `speed: "fast"` again.
		if (next.anthropic === "priority" && this.#byFamily.anthropic !== "priority") {
			clearAnthropicFastModeFallback(this.#host.providerSessionStates);
		}
		this.#byFamily = next;
		this.#host.sessionStore.appendServiceTierChange(this.entry());
	}

	/**
	 * `/fast on|off` targets the family of the currently selected model: it sets
	 * that family's `priority` tier, and turning it off returns the family to the
	 * tier the operator configured rather than to no tier at all. Returns `false`
	 * when the model has no service-tier family, so callers can report that fast
	 * mode is unavailable instead of claiming success.
	 */
	setFastMode(enabled: boolean): boolean {
		const model = this.#host.model();
		const family = model ? serviceTierFamily(model) : undefined;
		if (!family) {
			this.#host.emitNotice(
				"info",
				"The current model has no service-tier control for /fast to toggle.",
				"priority",
			);
			return false;
		}
		if (!enabled) {
			if (this.#byFamily[family] !== "priority") return true;
			// Fast mode OVERRODE whatever this family was configured for, so turning
			// it off restores that baseline. Clearing outright silently spent the
			// operator's `tier.openai: flex` (a cheaper, slower tier) for the rest of
			// the session, and the change is persisted, so a resume kept the loss. A
			// configured `priority` is the one case where clearing is what was asked
			// for: there is no other baseline to go back to.
			const configured = this.#host.configuredTiers()[family];
			this.setFamily(family, configured === "priority" ? undefined : configured);
			return true;
		}
		this.setFamily(family, "priority");
		return true;
	}

	toggleFastMode(): boolean {
		if (!this.setFastMode(!this.fastModeEnabled())) return false;
		return this.fastModeEnabled();
	}

	/**
	 * Turn Anthropic priority off when a settled response reports the provider dropped it. The
	 * request was already retried without it; leaving the tier on would repeat the rejection on
	 * every later request.
	 */
	onAssistantSettled(message: AssistantMessage): void {
		if (!message.disabledFeatures?.includes("priority") || this.#byFamily.anthropic !== "priority") return;
		this.setFamily("anthropic", undefined);
		this.#host.emitNotice(
			"warning",
			`${PRIORITY_TIER_COMMAND_LABEL} rejected for this model; retried without it. It is now off.`,
			"priority",
		);
	}
}
