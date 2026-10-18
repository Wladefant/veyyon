/**
 * Reading a service tier for one model.
 *
 * Every answer here comes from the provider's entry in
 * `wire-capabilities.ts`; nothing in this file names a provider. It is a
 * separate module from that table because classifying a model needs
 * `isOpenAIModelId`, and the table is imported by callers — the
 * OpenAI-compatible builder among them — that must not grow the identity
 * subtree on their graph (`packages/ai/test/module-reach-stays-cut.test.ts`).
 */
import { isOpenAIModelId } from "../identity/family";
import type { Api, Model } from "../types";
import {
	OPENAI_WIRE_TIERS,
	isServiceTier,
	providerWireCapabilities,
	type ServiceTier,
	type ServiceTierByFamily,
	type ServiceTierFamily,
} from "./wire-capabilities";

type ServiceTierModel = Pick<Model, "provider" | "api" | "id"> & Partial<Pick<Model, "serviceTiers">>;

function isOpenAIServiceTierApi(api: Api | undefined): boolean {
	return api === "openai-completions" || api === "openai-responses" || api === "openai-codex-responses";
}

/**
 * A custom OpenAI-compatible relay serving an OpenAI model id: the OpenAI
 * family reaches it through the model, not through a declaration. Both callers
 * ask the declaration first, so this answers only for a provider that declares
 * nothing — which is why Fireworks, whose own entry names its dedicated serving
 * control, never inherits the OpenAI knob through an OpenAI model id.
 */
function isOpenAIRelayModel(model: ServiceTierModel): boolean {
	return isOpenAIServiceTierApi(model.api) && isOpenAIModelId(model.id);
}

function namespaceFamily(modelId: string): ServiceTierFamily | undefined {
	const id = modelId.toLowerCase();
	if (id.startsWith("anthropic/")) return "anthropic";
	if (id.startsWith("google/")) return "google";
	if (id.startsWith("openai/")) return "openai";
	return undefined;
}

/**
 * Classify a model into the service-tier family whose knob governs it, or
 * `undefined` when the model exposes no serving-priority control.
 *
 * A gateway declaring `"model-namespace"` is classified by id namespace
 * (`anthropic/`, `google/`, `openai/`); Claude on Bedrock/Vertex (api
 * `anthropic-messages`) is the anthropic family even though its provider is
 * `amazon-bedrock`/`google-vertex`.
 */
export function serviceTierFamily(model: ServiceTierModel): ServiceTierFamily | undefined {
	const capability = providerWireCapabilities(model.provider)?.serviceTier;
	if (capability) {
		if (capability.family === "model-namespace") return namespaceFamily(model.id);
		if (capability.family && !capability.anthropicMessagesOverridesFamily) return capability.family;
		if (model.api === "anthropic-messages") return "anthropic";
		return capability.family;
	}
	if (model.api === "anthropic-messages") return "anthropic";
	return isOpenAIRelayModel(model) ? "openai" : undefined;
}

/**
 * Reduce a per-family tier map to the single wire tier for `model` — the entry
 * for the model's family, or `undefined` when the model has no family.
 */
export function resolveModelServiceTier(
	tiers: ServiceTierByFamily | null | undefined,
	model: ServiceTierModel,
): ServiceTier | undefined {
	if (!tiers) return undefined;
	const family = serviceTierFamily(model);
	return family ? tiers[family] : undefined;
}

/** True when `ultrafast` is accepted by this provider and model's discovery metadata. */
function canSendUltrafastServiceTier(
	target: string | ServiceTierModel | undefined,
	provider: string | undefined,
): boolean {
	if (typeof target === "string") return providerWireCapabilities(provider)?.serviceTier?.family === "openai";
	if (!target) return false;
	if (target.api === "openai-codex-responses") return target.serviceTiers?.includes("ultrafast") === true;
	return target.provider === "openai";
}

/**
 * True when the tier should be sent on the wire as the provider's service-tier
 * request field. Codex models with a non-empty discovered tier list send only
 * advertised tiers; `ultrafast` requires discovery for Codex and is accepted
 * directly by OpenAI.
 */
export function shouldSendServiceTier(
	serviceTier: ServiceTier | null | undefined,
	target: string | ServiceTierModel | undefined,
): boolean {
	if (!serviceTier || serviceTier === "auto") return false;
	const provider = typeof target === "string" ? target : target?.provider;
	if (
		typeof target !== "string" &&
		target?.api === "openai-codex-responses" &&
		serviceTier !== "flex" &&
		serviceTier !== "default"
	) {
		const advertised = target.serviceTiers;
		if (serviceTier === "ultrafast") return advertised?.includes(serviceTier) === true;
		if (advertised !== undefined && advertised.length > 0) return advertised.includes(serviceTier);
	}
	if (serviceTier === "ultrafast") return canSendUltrafastServiceTier(target, provider);
	const capability = providerWireCapabilities(provider)?.serviceTier;
	if (capability) return capability.wireTiers.includes(serviceTier);
	if (typeof target !== "string" && target && isOpenAIRelayModel(target)) {
		return (OPENAI_WIRE_TIERS as readonly ServiceTier[]).includes(serviceTier);
	}
	return false;
}

/**
 * Premium-request weight contributed by a provider-reported or requested tier.
 * `served: true` records a tier the provider actually served, even when model
 * discovery metadata is unavailable for a historical request.
 */
export function getPremiumServiceTierRequests(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
	options?: { served?: boolean },
): number {
	if (serviceTier === "ultrafast") {
		const capability = providerWireCapabilities(model.provider)?.serviceTier;
		if (capability?.family !== "openai" || !capability.premiumPriority) return 0;
		return options?.served === true || shouldSendServiceTier(serviceTier, model) ? 1 : 0;
	}
	if (serviceTier !== "priority") return 0;
	if (options?.served !== true) return getPriorityPremiumRequests(serviceTier, model);
	return providerWireCapabilities(model.provider)?.serviceTier?.premiumPriority ? 1 : 0;
}

/** Parse a provider-reported service-tier echo, or return `undefined` if unknown. */
export function parseServiceTier(value: unknown): ServiceTier | undefined {
	return isServiceTier(value) ? value : undefined;
}

/**
 * True when `priority` will actually be realized on the wire for `model`.
 * Bedrock/Vertex Claude and an OpenRouter Anthropic model do not realize
 * priority and return `false`.
 */
export function realizesPriorityServiceTier(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): boolean {
	if (serviceTier !== "priority") return false;
	const capability = providerWireCapabilities(model.provider)?.serviceTier;
	if (capability?.realizesPriorityOffWire) return true;
	if (capability?.realizesPriorityForFamilies) {
		const family = serviceTierFamily(model);
		return family !== undefined && capability.realizesPriorityForFamilies.includes(family);
	}
	if (model.api === "anthropic-messages") return false;
	return shouldSendServiceTier(serviceTier, model);
}

/**
 * Premium-request weight contributed by a priority request to a provider that
 * realizes it and bills extra. Mirrors GitHub Copilot's `premiumRequests`
 * accounting so the "premium requests" stat aggregates priority traffic across
 * the OpenAI family, direct Anthropic fast mode, and Google priority.
 */
export function getPriorityPremiumRequests(
	serviceTier: ServiceTier | null | undefined,
	model: ServiceTierModel,
): number {
	if (!realizesPriorityServiceTier(serviceTier, model)) return 0;
	return providerWireCapabilities(model.provider)?.serviceTier?.premiumPriority ? 1 : 0;
}
