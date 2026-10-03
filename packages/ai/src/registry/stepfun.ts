import { createApiKeyLogin } from "./api-key-login";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const loginStepFun = createApiKeyLogin({
	providerLabel: "StepFun",
	authUrl: "https://platform.stepfun.ai/interface-key",
	instructions: "Copy your API key from the StepFun Open Platform",
	promptMessage: "Paste your StepFun API key",
	placeholder: "...",
	validation: {
		kind: "chat-completions",
		provider: "StepFun",
		baseUrl: "https://api.stepfun.ai/v1",
		model: "step-5-preview",
	},
});

export const stepfunProvider = {
	id: "stepfun",
	name: "StepFun",
	login: (cb: OAuthLoginCallbacks) => loginStepFun(cb),
	credential: "api-key",
} as const satisfies ProviderDefinition;
