import { createApiKeyLogin } from "./api-key-login";
import type { ProviderDefinition } from "./types";

export const loginDeepinfra = createApiKeyLogin({
	providerLabel: "DeepInfra",
	authUrl: "https://deepinfra.com/dash/api_keys",
	instructions: "Create or copy your API key from the DeepInfra dashboard",
	promptMessage: "Paste your DeepInfra API key",
	placeholder: "...",
	validation: {
		kind: "chat-completions",
		provider: "DeepInfra",
		baseUrl: "https://api.deepinfra.com/v1/openai",
		model: "deepseek-ai/DeepSeek-V4-Flash-0731",
	},
});

export const deepinfraProvider = {
	id: "deepinfra",
	name: "DeepInfra",
	login: loginDeepinfra,
	credential: "api-key",
} satisfies ProviderDefinition & { readonly id: "deepinfra" };
