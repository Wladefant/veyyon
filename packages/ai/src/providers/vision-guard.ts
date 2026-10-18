import { isDashscopeCompatibleModeUrl } from "@veyyon/catalog/hosts";
import { isQwenModelId } from "@veyyon/catalog/identity";
import { $env } from "@veyyon/utils";

import type { Api, Model } from "../types";

export {
	NON_VIDEO_MODEL_PLACEHOLDER,
	NON_VISION_IMAGE_PLACEHOLDER,
	joinTextWithImagePlaceholder,
	partitionVisionContent,
} from "./vision-content";
/**
 * Detect known text-only Qwen models served via Alibaba DashScope's consumer
 * `compatible-mode` endpoint that the upstream chat-completions API rejects
 * multimodal content arrays for. The compatible-mode endpoint also serves
 * multimodal Qwen SKUs without `vl` in the id (e.g. `qwen3.7-plus`), so this
 * guard only covers families verified to be text-only for issue #1859:
 * `qwen*-max` and `qwen*-coder*`.
 *
 * Used as a defensive override in `convertMessages` so a misconfigured custom
 * provider (issue #1859) can't drive the request into an unrecoverable 400.
 */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	if (!model.baseUrl || !isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	const id = model.id.toLowerCase();
	if (!isQwenModelId(model.id)) return false;
	return /\bqwen(?:[\d.]+)?-max\b/.test(id) || /\bqwen(?:[\d.]+)?-coder\b/.test(id);
}

/**
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions" | "openrouter">): boolean {
	if (!model.input.includes("image")) return false;
	const compat = model.compat as { stripImageInput?: boolean } | undefined;
	if (compat?.stripImageInput !== undefined) {
		if (compat.stripImageInput) return false;
	} else if (model.api === "openai-completions" && isDashscopeCompatibleModeTextOnlyQwen(model)) {
		return false;
	}
	return true;
}

/**
 * Whether the transport that will carry `model` sends image content on the wire.
 *
 * The `pi-native` transport forwards the original context (images included) to
 * the gateway, which resolves its own model server-side, so the Chat
 * Completions guard below never runs client-side and the declared input
 * applies. Otherwise the OpenAI Chat Completions path applies the text-only
 * guard, as does the OpenRouter chat fallback (`VEYYON_OPENROUTER_RESPONSES=0` or
 * `PI_OPENROUTER_RESPONSES=0`, which dispatches `openrouter` models through
 * `streamOpenAICompletions`); every other API ships the modalities the model
 * declares. Callers that report or gate on the wire (for example the `omp models`
 * table) read this predicate; declared capability reads `model.input`.
 */
export function sendsImageInputOnWire(model: Model<Api>): boolean {
	if (model.transport === "pi-native") return model.input.includes("image");
	if (
		model.api === "openai-completions" ||
		(model.api === "openrouter" &&
			($env.VEYYON_OPENROUTER_RESPONSES === "0" || $env.PI_OPENROUTER_RESPONSES === "0"))
	) {
		return isOpenAICompletionsVisionSupported(model);
	}
	return model.input.includes("image");
}
