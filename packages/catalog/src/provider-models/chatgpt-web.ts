/**
 * Runtime model-manager wiring for the local `codex-chatgpt-web` bridge.
 *
 * The bridge is a loopback daemon, so its catalog is host-specific and nothing
 * about it can be bundled: `models.json` carries no `chatgpt-web` key, exactly
 * as it carries none for `lm-studio` or `ollama`. Every row comes from the live
 * `GET {base}/models` answer, which the daemon gates on the authenticated
 * ChatGPT account's real capabilities. `dynamicModelsAuthoritative` therefore
 * has to be set by the descriptor: a stale cache must not outlive the account
 * capability that produced it (an account that loses Pro must lose the Pro row).
 *
 * Discovery needs the ChatGPT/Codex bearer because the daemon proxies `/models`
 * upstream with the incoming `Authorization` header. Without a credential the
 * reader reports why and returns `null`, which is the honest answer: no rows,
 * and a reason an operator can act on. It never falls back to a locally
 * declared model list.
 */
import { fetchChatGptWebModels, normalizeChatGptWebBaseUrl } from "../discovery/chatgpt-web";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";

export interface ChatGptWebModelManagerConfig {
	/**
	 * ChatGPT/Codex OAuth access token. Named `apiKey` because that is the field
	 * the descriptor factory receives for every provider; the daemon forwards it
	 * verbatim to OpenAI's Codex backend for the catalog request.
	 */
	apiKey?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
}

export function chatGptWebModelManagerOptions(
	config?: ChatGptWebModelManagerConfig,
): ModelManagerOptions<"openai-codex-responses"> {
	const baseUrl = normalizeChatGptWebBaseUrl(config?.baseUrl);
	return {
		providerId: "chatgpt-web",
		// No bundled rows exist for this provider, so an empty static catalog is
		// the truth rather than a placeholder. Leaving `staticModels` unset would
		// read `models.json["chatgpt-web"]`, which is absent and would also let a
		// future bundled entry silently outlive a revoked account capability.
		staticModels: [],
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: async hooks => {
			const result = await fetchChatGptWebModels({
				accessToken: config?.apiKey ?? "",
				baseUrl,
				...(config?.fetch ? { fetchFn: config.fetch } : {}),
				...(hooks?.onFailure ? { onFailure: hooks.onFailure } : {}),
			});
			return result?.models ?? null;
		},
	};
}
