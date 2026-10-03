import { isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import { credentialExpiryFromExpiresIn } from "./expiry";
import { emitOAuthSuccessPage } from "./success-page";
import type { OAuthController, OAuthCredentials } from "./types";

const PROVIDER = "muse-code";
const MUSE_CLIENT_ID = "1031625952748946";
const MUSE_DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
const MUSE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
const API_VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 20_000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface MuseCodeCredential {
	oauthAccessToken: string;
	apiKey: string;
}

export interface MuseCodeKeyRequestOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	/** Ask Meta to onboard the account during an interactive login exchange. */
	onboard?: boolean;
}

export interface MuseCodeKeyResponse {
	api_key?: string;
	require_payment_action_url?: string;
	require_payment?: boolean;
	action_url?: string | null;
	user_email?: string;
	user_id?: string;
	is_subs_active?: boolean;
	subs_tier_id?: string | null;
	subs_tier_name?: string | null;
	subs_usage?: {
		window?: { used_percent?: number; resets_at?: string | number; window_duration_mins?: number } | null;
		weekly?: { used_percent?: number; resets_at?: string | number; window_duration_mins?: number } | null;
	} | null;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parseMuseCodeCredential(value: string): MuseCodeCredential {
	let payload: unknown;
	try {
		payload = JSON.parse(value);
	} catch (cause) {
		throw new AIError.ConfigurationError("Muse Code credential is invalid; sign in again", { cause });
	}
	if (
		!isRecord(payload) ||
		typeof payload.oauthAccessToken !== "string" ||
		typeof payload.apiKey !== "string" ||
		!payload.oauthAccessToken.trim() ||
		!payload.apiKey.trim()
	) {
		throw new AIError.ConfigurationError("Muse Code credential is invalid; sign in again");
	}
	return { oauthAccessToken: payload.oauthAccessToken, apiKey: payload.apiKey };
}

export function encodeMuseCodeCredential(oauthAccessToken: string, apiKey: string): string {
	return JSON.stringify({ oauthAccessToken, apiKey });
}

export function getMuseCodeApiKey(credentials: OAuthCredentials): string {
	return parseMuseCodeCredential(credentials.access).apiKey;
}

export async function requestMuseCodeKey(
	accessToken: string,
	options: MuseCodeKeyRequestOptions = {},
): Promise<MuseCodeKeyResponse> {
	const response = await (options.fetch ?? fetch)(MUSE_KEY_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"x-api-version": API_VERSION,
		},
		body: JSON.stringify(options.onboard ? { onboard: true } : {}),
		redirect: "error",
		signal: requestSignal(options.signal),
	});
	const text = await response.text();
	if (!response.ok) {
		const excerpt = text.trim() ? ` ${text.slice(0, 500).trim()}` : "";
		throw new AIError.OAuthError(`Muse Code key exchange failed: ${response.status}${excerpt}`, {
			kind: "token-exchange",
			provider: PROVIDER,
			status: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch (cause) {
		throw new AIError.OAuthError("Muse Code key exchange returned invalid JSON", {
			kind: "validation",
			provider: PROVIDER,
			status: response.status,
			cause,
		});
	}
	if (!isRecord(payload)) {
		throw new AIError.OAuthError("Invalid Muse Code key response: expected object", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return payload as MuseCodeKeyResponse;
}

function isTransientKeyExchangeFailure(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return false;
	if (error instanceof AIError.OAuthError) {
		return AIError.isTransientStatus(error.status) || error.status === 401 || error.status === 403;
	}
	return (
		error instanceof TypeError ||
		(error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
	);
}

/** Exchange Meta account access for the Model API key authorized by a Muse subscription. */
export async function attachMuseCodeApiKey(
	credentials: OAuthCredentials,
	context: { fetch?: FetchImpl; signal?: AbortSignal; phase?: "login" | "refresh"; stored?: OAuthCredentials } = {},
): Promise<OAuthCredentials> {
	try {
		const existing = parseMuseCodeCredential(credentials.access);
		if (existing.apiKey.trim()) return credentials;
	} catch {
		// No usable minted key yet — fall through to mint one.
	}
	let payload: MuseCodeKeyResponse;
	try {
		payload = await requestMuseCodeKey(credentials.access, {
			fetch: context.fetch,
			signal: context.signal,
			onboard: true,
		});
	} catch (error) {
		if (context.phase === "refresh" && context.stored && isTransientKeyExchangeFailure(error, context.signal)) {
			try {
				const stored = parseMuseCodeCredential(context.stored.access);
				return {
					...credentials,
					access: encodeMuseCodeCredential(credentials.access, stored.apiKey),
					accountId: context.stored.accountId,
					email: context.stored.email,
				};
			} catch {
				// fall through to rethrow original error
			}
		}
		throw error;
	}
	if (payload.is_subs_active === false) {
		throw new AIError.OAuthError("invalid_grant: Muse Code subscription is inactive", {
			kind: "token-exchange",
			provider: PROVIDER,
			status: 403,
		});
	}
	const apiKey = typeof payload.api_key === "string" ? payload.api_key.trim() : "";
	if (!apiKey) {
		const actionUrl =
			typeof payload.action_url === "string"
				? payload.action_url.trim()
				: typeof payload.require_payment_action_url === "string"
					? payload.require_payment_action_url.trim()
					: "";
		if (payload.require_payment === true || actionUrl) {
			throw new AIError.OAuthError(
				actionUrl ? `Muse Code subscription is required: ${actionUrl}` : "Muse Code subscription is required",
				{ kind: "validation", provider: PROVIDER },
			);
		}
		throw new AIError.OAuthError("Muse Code key response is missing api_key", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	const email = typeof payload.user_email === "string" ? payload.user_email.trim().toLowerCase() : credentials.email;
	const accountId = typeof payload.user_id === "string" ? payload.user_id.trim() : email;
	if (!accountId) {
		throw new AIError.OAuthError("Muse Code key response is missing a stable account identity", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return {
		...credentials,
		access: encodeMuseCodeCredential(credentials.access, apiKey),
		accountId,
		email,
	};
}

async function requestDeviceAuthorization(fetchImpl: FetchImpl, signal?: AbortSignal) {
	const response = await fetchImpl(MUSE_DEVICE_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			client_id: MUSE_CLIENT_ID,
		}),
		signal,
	});
	if (!response.ok) {
		throw new AIError.OAuthError(`Muse Code device authorization request failed: ${response.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: response.status,
		});
	}
	const payload = await response.json();
	if (!isRecord(payload) || typeof payload.device_code !== "string" || typeof payload.user_code !== "string") {
		throw new AIError.OAuthError("Invalid Muse Code device authorization response", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return {
		deviceCode: payload.device_code,
		userCode: payload.user_code,
		verificationUri: typeof payload.verification_uri === "string" ? payload.verification_uri : "",
		verificationUriComplete:
			typeof payload.verification_uri_complete === "string" ? payload.verification_uri_complete : "",
		intervalSeconds: typeof payload.interval === "number" ? payload.interval : 5,
		expiresInSeconds: typeof payload.expires_in === "number" ? payload.expires_in : 900,
	};
}

async function pollForToken(
	device: { deviceCode: string; intervalSeconds: number; expiresInSeconds: number },
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
	return pollOAuthDeviceCodeFlow<{ accessToken: string; refreshToken?: string; expiresIn?: number }>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal,
		poll: async () => {
			let response: Response;
			try {
				response = await fetchImpl(MUSE_TOKEN_URL, {
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						grant_type: DEVICE_CODE_GRANT,
						client_id: MUSE_CLIENT_ID,
						device_code: device.deviceCode,
					}),
					signal,
				});
			} catch (cause) {
				if (signal?.aborted) throw new AIError.LoginCancelledError();
				throw new AIError.OAuthError("Muse Code device token request failed", {
					kind: "polling",
					provider: PROVIDER,
					cause,
				});
			}

			let payload: unknown;
			try {
				payload = await response.json();
			} catch (cause) {
				throw new AIError.OAuthError("Muse Code device token returned invalid JSON", {
					kind: "polling",
					provider: PROVIDER,
					cause,
				});
			}

			if (response.ok && isRecord(payload) && typeof payload.access_token === "string") {
				return {
					status: "complete",
					value: {
						accessToken: payload.access_token,
						refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
						expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
					},
				};
			}

			if (isRecord(payload)) {
				if (payload.error === "authorization_pending") return { status: "pending" };
				if (payload.error === "slow_down") return { status: "slow_down" };
				const detail = typeof payload.error_description === "string" ? payload.error_description : payload.error;
				return {
					status: "failed",
					message: `Muse Code device authorization failed: ${detail || response.status}`,
				};
			}

			return {
				status: "failed",
				message: `Muse Code device authorization failed: ${response.status}`,
			};
		},
	});
}

export async function loginMuseCode(options: OAuthController): Promise<OAuthCredentials> {
	if (!options.onAuth) {
		throw new AIError.OAuthError(
			"Muse Code login requires an onAuth callback to show the verification URL in browser and headless sessions",
			{ kind: "configuration", provider: PROVIDER },
		);
	}
	const fetchImpl = options.fetch ?? fetch;
	const device = await requestDeviceAuthorization(fetchImpl, options.signal);
	options.onAuth({
		url: device.verificationUriComplete || device.verificationUri,
		instructions:
			`Open the URL in a browser and enter code ${device.userCode} if prompted. ` +
			`If no browser opens or this is a headless/remote session, copy the URL into any browser (${device.verificationUri}).`,
	});
	options.onProgress?.("Waiting for Muse Code authorization...");
	const token = await pollForToken(device, fetchImpl, options.signal);
	emitOAuthSuccessPage(options);
	const initialCreds: OAuthCredentials = {
		access: token.accessToken,
		refresh: token.refreshToken ?? "",
		expires: credentialExpiryFromExpiresIn(token.expiresIn ?? 3600),
	};
	return attachMuseCodeApiKey(initialCreds, { fetch: fetchImpl, signal: options.signal, phase: "login" });
}

export async function refreshMuseCodeToken(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const refreshToken = credentials.refresh.trim();
	if (!refreshToken) {
		throw new AIError.OAuthError("Muse Code refresh token is missing; sign in again", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	let response: Response;
	try {
		response = await fetchImpl(MUSE_TOKEN_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: MUSE_CLIENT_ID,
				refresh_token: refreshToken,
			}),
		});
	} catch (cause) {
		throw new AIError.OAuthError("Muse Code token refresh request failed", {
			kind: "token-refresh",
			provider: PROVIDER,
			cause,
		});
	}
	const payload = await response.json();
	if (!response.ok || !isRecord(payload) || typeof payload.access_token !== "string") {
		const detail =
			isRecord(payload) && typeof payload.error_description === "string" ? payload.error_description : undefined;
		throw new AIError.OAuthError(`Muse Code token refresh failed: ${response.status}${detail ? `: ${detail}` : ""}`, {
			kind: "token-refresh",
			provider: PROVIDER,
			status: response.status,
		});
	}

	const newRefreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : refreshToken;
	const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
	const baseCreds: OAuthCredentials = {
		...credentials,
		access: payload.access_token,
		refresh: newRefreshToken,
		expires: credentialExpiryFromExpiresIn(expiresIn),
	};
	return attachMuseCodeApiKey(baseCreds, { fetch: fetchImpl, phase: "refresh", stored: credentials });
}
