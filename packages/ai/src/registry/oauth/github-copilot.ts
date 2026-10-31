/**
 * GitHub Copilot OAuth flow (device code, with the operator's own GitHub OAuth app; see
 * `../../github-copilot-client-id.ts`)
 */
import { getBundledModels } from "@veyyon/catalog/models";
import {
	COPILOT_API_HEADERS,
	COPILOT_IDENTITY_HEADERS,
	getGitHubCopilotBaseUrl,
	isPublicGitHubHost,
	normalizeDomain,
	normalizeGitHubCopilotApiEndpoint,
	normalizeGitHubCopilotEnterpriseDomain,
} from "@veyyon/catalog/wire/github-copilot";
import { batched } from "@veyyon/utils/array";
import { DAY_MS } from "@veyyon/utils/time";
import * as AIError from "../../error";
import {
	GITHUB_COPILOT_CLIENT_ID_MISSING_MESSAGE,
	GITHUB_COPILOT_EXPIRING_TOKEN_MESSAGE,
	resolveGitHubCopilotOAuthClientId,
} from "../../github-copilot-client-id";
import type { FetchImpl } from "../../types";
import { fetchGitHubCopilotJson } from "../../utils/github-copilot-http";
import { deviceFlowTimeoutError, loginStep, waitForNextLoginPoll } from "./device-code";
import { emitOAuthSuccessPage } from "./success-page";
import type { OAuthCredentials } from "./types";

// No client ID is bundled: it comes from `resolveGitHubCopilotOAuthClientId()` at login time.

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;

type GitHubCopilotLoginOptions = {
	onAuth: (url: string, instructions?: string) => void;
	onPrompt: (prompt: {
		message: string;
		placeholder?: string;
		allowEmpty?: boolean;
		secret?: boolean;
	}) => Promise<string>;
	onProgress?: (message: string) => void;
	onSuccessPage?: (url: string) => void;
	signal?: AbortSignal;
	fetch?: FetchImpl;
};
type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	interval: number;
	expires_in: number;
};


function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
	};
}

async function startDeviceFlow(
	domain: string,
	clientId: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<DeviceCodeResponse> {
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const urls = getUrls(domain);
	const data = await fetchGitHubCopilotJson(fetchImpl, urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			...COPILOT_IDENTITY_HEADERS,
		},
		body: JSON.stringify({
			client_id: clientId,
			scope: "read:user",
		}),
		signal,
	});

	if (!data || typeof data !== "object") {
		throw new AIError.OAuthError("Invalid device code response", { kind: "validation", provider: "github-copilot" });
	}

	const deviceCode = "device_code" in data ? data.device_code : undefined;
	const userCode = "user_code" in data ? data.user_code : undefined;
	const verificationUri = "verification_uri" in data ? data.verification_uri : undefined;
	const interval = "interval" in data ? data.interval : undefined;
	const expiresIn = "expires_in" in data ? data.expires_in : undefined;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof interval !== "number" ||
		typeof expiresIn !== "number"
	) {
		throw new AIError.OAuthError("Invalid device code response fields", {
			kind: "validation",
			provider: "github-copilot",
		});
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: verificationUri,
		interval,
		expires_in: expiresIn,
	};
}

async function pollForGitHubAccessToken(
	domain: string,
	clientId: string,
	deviceCode: string,
	intervalSeconds: number,
	expiresIn: number,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
) {
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const urls = getUrls(domain);
	const deadline = Date.now() + expiresIn * 1000;
	let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
	let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}
		const remainingMs = deadline - Date.now();
		await waitForNextLoginPoll(Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs), signal);

		const raw = await loginStep(signal, () =>
			fetchGitHubCopilotJson(fetchImpl, urls.accessTokenUrl, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					...COPILOT_IDENTITY_HEADERS,
				},
				body: JSON.stringify({
					client_id: clientId,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal,
			}),
		);

		if (raw && typeof raw === "object" && "access_token" in raw && typeof raw.access_token === "string") {
			// Veyyon stores the access token as its own refresh credential and never calls GitHub's refresh
			// endpoint. An expiring token (8 h, with a separate refresh_token) would be stored with a 10-year
			// expiry and silently stop working, so it is refused instead of kept.
			if (
				("refresh_token" in raw && typeof raw.refresh_token === "string") ||
				("expires_in" in raw && typeof raw.expires_in === "number")
			) {
				throw new AIError.OAuthError(GITHUB_COPILOT_EXPIRING_TOKEN_MESSAGE, {
					kind: "validation",
					provider: "github-copilot",
				});
			}
			return raw.access_token;
		}

		if (raw && typeof raw === "object" && "error" in raw && typeof raw.error === "string") {
			const error = raw.error;
			const description =
				"error_description" in raw && typeof raw.error_description === "string" ? raw.error_description : undefined;
			const interval = "interval" in raw && typeof raw.interval === "number" ? raw.interval : undefined;
			if (error === "authorization_pending") {
				continue;
			}

			if (error === "slow_down") {
				slowDownResponses += 1;
				intervalMs =
					typeof interval === "number" && interval > 0
						? Math.max(1000, interval * 1000)
						: Math.max(1000, intervalMs + 5000);
				intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
				continue;
			}

			const descriptionSuffix = description ? `: ${description}` : "";
			throw new AIError.OAuthError(`Device flow failed: ${error}${descriptionSuffix}`, {
				kind: "polling",
				provider: "github-copilot",
			});
		}
	}

	throw deviceFlowTimeoutError(slowDownResponses, "github-copilot");
}

/** Far-future expiry (10 years). GitHub OAuth tokens are long-lived; no JWT exchange needed. */
const FAR_FUTURE_MS = Date.now() + 10 * 365.25 * DAY_MS;

/**
 * Refresh GitHub Copilot token.
 * The GitHub token from the device flow is used directly — no JWT exchange needed, and no client ID is
 * involved, so logins made with any OAuth app (including earlier Veyyon releases) keep working.
 */
export function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain?: string,
	apiEndpoint?: string,
): OAuthCredentials {
	return {
		refresh: refreshToken,
		access: refreshToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain,
		apiEndpoint,
	};
}

async function discoverGitHubCopilotApiEndpoint(
	token: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	try {
		const data = await loginStep(signal, () =>
			fetchGitHubCopilotJson(fetchImpl, "https://api.github.com/copilot_internal/user", {
				headers: {
					Accept: "application/json",
					Authorization: `token ${token}`,
					...COPILOT_IDENTITY_HEADERS,
				},
				signal,
			}),
		);
		if (!data || typeof data !== "object") return undefined;
		if (
			"endpoints" in data &&
			data.endpoints &&
			typeof data.endpoints === "object" &&
			"api" in data.endpoints &&
			typeof data.endpoints.api === "string"
		) {
			return normalizeGitHubCopilotApiEndpoint(data.endpoints.api);
		}
		return undefined;
	} catch (error) {
		if (signal?.aborted || error instanceof AIError.LoginCancelledError) {
			throw error;
		}
		// Undefined means "no endpoint advertised", so the caller uses the documented default base URL. That
		// is the same path a response without an `endpoints.api` takes, and a wrong endpoint would be worse
		// than the default; the request that follows reports if the default does not work either.
		return undefined;
	}
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
async function enableGitHubCopilotModel(
	token: string,
	modelId: string,
	fetchImpl: FetchImpl,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const baseUrl = apiEndpoint ?? getGitHubCopilotBaseUrl(enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	try {
		const response = await loginStep(signal, () =>
			fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					...COPILOT_API_HEADERS,
					...COPILOT_IDENTITY_HEADERS,
					"openai-intent": "chat-policy",
					"x-interaction-type": "chat-policy",
				},
				body: JSON.stringify({ state: "enabled" }),
				signal,
			}),
		);
		return response.ok;
	} catch (error) {
		if (signal?.aborted || error instanceof AIError.LoginCancelledError) {
			throw error;
		}
		// False means "the policy could not be enabled", which the caller surfaces to the user as the reason
		// sign-in did not complete. Same answer as a non-ok response, so a network failure and a refusal are
		// treated alike on purpose: neither one leaves the policy enabled.
		return false;
	}
}

/**
 * Enable all known GitHub Copilot models that may require policy acceptance.
 * Called after successful login to ensure all models are available.
 */
async function enableAllGitHubCopilotModels(
	token: string,
	enterpriseDomain: string | undefined,
	apiEndpoint: string | undefined,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
	onProgress?: (model: string, success: boolean) => void,
): Promise<void> {
	if (signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	// Synthesized catalog variants (Copilot long-context `-1m` entries) share
	// the upstream model id; enable each wire id exactly once.
	const wireModelIds = Array.from(
		new Set(getBundledModels("github-copilot").map(model => model.requestModelId ?? model.id)),
	);
	const BATCH_SIZE = 5;
	for (const batch of batched(wireModelIds, BATCH_SIZE)) {
		if (signal?.aborted) {
			throw new AIError.LoginCancelledError();
		}
		await Promise.all(
			batch.map(async modelId => {
				const success = await enableGitHubCopilotModel(
					token,
					modelId,
					fetchImpl,
					enterpriseDomain,
					apiEndpoint,
					signal,
				);
				if (signal?.aborted) {
					throw new AIError.LoginCancelledError();
				}
				onProgress?.(modelId, success);
			}),
		);
	}
}

/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 * @param options.signal - Optional AbortSignal for cancellation
 */
export async function loginGitHubCopilot(options: GitHubCopilotLoginOptions): Promise<OAuthCredentials> {
	const clientId = resolveGitHubCopilotOAuthClientId();
	if (!clientId) {
		throw new AIError.OAuthError(GITHUB_COPILOT_CLIENT_ID_MISSING_MESSAGE, {
			kind: "validation",
			provider: "github-copilot",
		});
	}
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const fetchImpl = options.fetch ?? fetch;
	const input = await loginStep(options.signal, () =>
		options.onPrompt({
			message: "GitHub Enterprise URL/domain (blank for github.com)",
			placeholder: "company.ghe.com",
			allowEmpty: true,
			// A hostname, not a credential, and it is rejected for a typo you have to be able to see.
			secret: false,
		}),
	);

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const trimmed = input.trim();
	const normalizedDomain = normalizeDomain(input);
	if (trimmed && !normalizedDomain) {
		throw new AIError.OAuthError("Invalid GitHub Enterprise URL/domain", {
			kind: "validation",
			provider: "github-copilot",
		});
	}
	const enterpriseDomain = normalizeGitHubCopilotEnterpriseDomain(normalizedDomain ?? undefined);
	const domain =
		normalizedDomain && isPublicGitHubHost(normalizedDomain) ? "github.com" : (normalizedDomain ?? "github.com");

	const device = await loginStep(options.signal, () =>
		startDeviceFlow(domain, clientId, fetchImpl, options.signal),
	);
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

	const githubAccessToken = await pollForGitHubAccessToken(
		domain,
		clientId,
		device.device_code,
		device.interval,
		device.expires_in,
		options.signal,
		fetchImpl,
	);

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	const apiEndpoint = await discoverGitHubCopilotApiEndpoint(githubAccessToken, fetchImpl, options.signal);

	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}

	// The GitHub token is used directly for all API requests
	const credentials: OAuthCredentials = {
		refresh: githubAccessToken,
		access: githubAccessToken,
		expires: FAR_FUTURE_MS,
		enterpriseUrl: enterpriseDomain ?? undefined,
		apiEndpoint,
	};

	// Enable all models after successful login
	options.onProgress?.("Enabling models...");
	await enableAllGitHubCopilotModels(
		githubAccessToken,
		enterpriseDomain ?? undefined,
		apiEndpoint,
		fetchImpl,
		options.signal,
	);
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	// Device-code flow has no browser redirect; show the branded success page.
	emitOAuthSuccessPage(options);
	return credentials;
}
