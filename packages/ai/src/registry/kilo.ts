import { DAY_MS } from "@veyyon/utils/time";
import * as AIError from "../error";
import { loginStep, pollOAuthDeviceCodeFlow } from "./oauth/device-code";
import type { OAuthController, OAuthCredentials } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const KILO_DEVICE_AUTH_BASE_URL = "https://api.kilo.ai/api/device-auth";
const POLL_INTERVAL_SECONDS = 5;
const ONE_YEAR_MS = 365 * DAY_MS;

interface KiloDeviceAuthCodeResponse {
	code?: string;
	verificationUrl?: string;
	expiresIn?: number;
}

interface KiloDeviceAuthPollResponse {
	status?: string;
	token?: string;
}

export async function loginKilo(callbacks: OAuthController): Promise<OAuthCredentials> {
	const fetchImpl = callbacks.fetch ?? fetch;
	const initiateResponse = await loginStep(callbacks.signal, () =>
		fetchImpl(`${KILO_DEVICE_AUTH_BASE_URL}/codes`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: callbacks.signal,
		}),
	);

	if (!initiateResponse.ok) {
		if (initiateResponse.status === 429) {
			throw new AIError.OAuthError("Too many pending authorization requests. Please try again later.", {
				kind: "polling",
				provider: "kilo",
				status: initiateResponse.status,
			});
		}
		throw new AIError.OAuthError(`Failed to initiate device authorization: ${initiateResponse.status}`, {
			kind: "device-auth",
			provider: "kilo",
			status: initiateResponse.status,
		});
	}

	const initiateData = (await initiateResponse.json()) as KiloDeviceAuthCodeResponse;
	const userCode = initiateData.code;
	const verificationUrl = initiateData.verificationUrl;
	const expiresInSeconds = initiateData.expiresIn;
	if (!userCode || !verificationUrl || typeof expiresInSeconds !== "number" || expiresInSeconds <= 0) {
		throw new AIError.OAuthError("Kilo device authorization response missing required fields", {
			kind: "validation",
			provider: "kilo",
		});
	}

	callbacks.onAuth?.({
		url: verificationUrl,
		instructions: `Enter code: ${userCode}`,
	});

	return pollOAuthDeviceCodeFlow<OAuthCredentials>({
		intervalSeconds: POLL_INTERVAL_SECONDS,
		expiresInSeconds,
		signal: callbacks.signal,
		provider: "kilo",
		poll: async () => {
			const pollResponse = await fetchImpl(`${KILO_DEVICE_AUTH_BASE_URL}/codes/${encodeURIComponent(userCode)}`, {
				signal: callbacks.signal,
			});
			if (pollResponse.status === 202) {
				return { status: "pending" };
			}
			if (pollResponse.status === 403) {
				throw new AIError.OAuthError("Authorization was denied", { kind: "device-auth", provider: "kilo" });
			}
			if (pollResponse.status === 410) {
				throw new AIError.OAuthError("Authorization code expired. Please try again.", {
					kind: "device-auth",
					provider: "kilo",
				});
			}
			if (!pollResponse.ok) {
				throw new AIError.OAuthError(`Failed to poll device authorization: ${pollResponse.status}`, {
					kind: "polling",
					provider: "kilo",
					status: pollResponse.status,
				});
			}

			const pollData = (await pollResponse.json()) as KiloDeviceAuthPollResponse;
			if (pollData.status === "approved" && pollData.token) {
				return {
					status: "complete",
					value: { refresh: "", access: pollData.token, expires: Date.now() + ONE_YEAR_MS },
				};
			}
			if (pollData.status === "denied") {
				throw new AIError.OAuthError("Authorization was denied", { kind: "device-auth", provider: "kilo" });
			}
			if (pollData.status === "expired") {
				throw new AIError.OAuthError("Authorization code expired. Please try again.", {
					kind: "device-auth",
					provider: "kilo",
				});
			}
			return { status: "pending" };
		},
	});
}

export const kiloProvider = {
	id: "kilo",
	name: "Kilo Gateway",
	login: loginKilo,
	credential: "oauth",
} as const satisfies ProviderDefinition;
