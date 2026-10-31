/**
 * Kimi Code OAuth flow (device authorization grant)
 */

import {
	KIMI_CODE_REGIONS,
	type KimiCodeRegion,
	kimiCodeApiEndpointOf,
	kimiCodeRegionOfApiEndpoint,
	kimiCodeRegionOfOAuthHost,
} from "@veyyon/catalog/wire/kimi-code";
import { $env } from "@veyyon/utils/env";
import * as AIError from "../../error";
import { getKimiCommonHeaders } from "../../utils/kimi-headers";
import { loginStep, type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import { credentialExpiryFromExpiresIn } from "./expiry";
import { emitOAuthSuccessPage } from "./success-page";
import { requireTokenResponseObject } from "./token-response";
import type { OAuthController, OAuthCredentials } from "./types";

// One client id serves both regions; only the hosts differ.
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_FLOW_TTL_MS = 15 * 60 * 1000;

interface DeviceAuthorizationResponse {
	user_code?: string;
	device_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

interface TokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
	error?: string;
	error_description?: string;
	interval?: number;
}

/** The OAuth host for `region`. `KIMI_CODE_OAUTH_HOST` and `KIMI_OAUTH_HOST` override both regions. */
function resolveOAuthHost(region: KimiCodeRegion): string {
	return $env.KIMI_CODE_OAUTH_HOST || $env.KIMI_OAUTH_HOST || KIMI_CODE_REGIONS[region].oauthHost;
}

async function requestDeviceAuthorization(
	oauthHost: string,
	signal: AbortSignal | undefined,
): Promise<{
	userCode: string;
	deviceCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresInMs: number;
	intervalMs: number;
}> {
	const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({ client_id: CLIENT_ID }),
		signal,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new AIError.OAuthError(`Kimi device authorization failed: ${response.status} ${text}`, {
			kind: "device-auth",
			provider: "kimi",
			status: response.status,
		});
	}

	const payload = (await response.json()) as DeviceAuthorizationResponse;
	const userCode = payload.user_code;
	const deviceCode = payload.device_code;
	const verificationUri = payload.verification_uri;
	const verificationUriComplete = payload.verification_uri_complete;

	if (!userCode || !deviceCode || !verificationUri) {
		throw new AIError.OAuthError("Kimi device authorization response missing required fields", {
			kind: "validation",
			provider: "kimi",
		});
	}

	const expiresInMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : DEFAULT_DEVICE_FLOW_TTL_MS;
	const intervalMs =
		typeof payload.interval === "number" && payload.interval > 0 ? payload.interval * 1000 : DEFAULT_POLL_INTERVAL_MS;

	return {
		userCode,
		deviceCode,
		verificationUri,
		verificationUriComplete: verificationUriComplete || verificationUri,
		expiresInMs,
		intervalMs,
	};
}

/** The credential a granting token response describes, scoped to the region named by `apiEndpoint`. */
function parseTokenPayload(
	payload: TokenResponse,
	apiEndpoint: string | undefined,
	refreshTokenFallback?: string,
): OAuthCredentials {
	if (!payload.access_token || typeof payload.expires_in !== "number") {
		throw new AIError.OAuthError("Kimi token response missing required fields", {
			kind: "validation",
			provider: "kimi",
		});
	}

	const refresh = payload.refresh_token ?? refreshTokenFallback;
	if (!refresh) {
		throw new AIError.OAuthError("Kimi token response missing refresh token", {
			kind: "validation",
			provider: "kimi",
		});
	}

	return {
		access: payload.access_token,
		refresh,
		expires: credentialExpiryFromExpiresIn(payload.expires_in, { provider: "kimi" }),
		...(apiEndpoint !== undefined && { apiEndpoint }),
	};
}

// What a non-token answer means for the flow; throws when the device flow cannot continue.
function pollResultOf(payload: TokenResponse, status: number): OAuthDeviceCodePollResult<TokenResponse> {
	switch (payload.error) {
		case "authorization_pending":
			return { status: "pending" };
		case "slow_down":
			return { status: "slow_down", intervalSeconds: payload.interval };
		case "expired_token":
			throw new AIError.OAuthError("Kimi device authorization expired", { kind: "validation", provider: "kimi" });
		case "access_denied":
			throw new AIError.OAuthError("Kimi device authorization denied", { kind: "validation", provider: "kimi" });
	}
	const description = payload.error_description ? `: ${payload.error_description}` : "";
	throw new AIError.OAuthError(`Kimi device flow failed: ${payload.error ?? status}${description}`, {
		kind: "polling",
		provider: "kimi",
	});
}

/** Poll `oauthHost` until it grants a token, and return the granting response. */
function pollForToken(
	oauthHost: string,
	deviceCode: string,
	intervalMs: number,
	expiresInMs: number,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	return pollOAuthDeviceCodeFlow<TokenResponse>({
		intervalSeconds: intervalMs / 1000,
		expiresInSeconds: expiresInMs / 1000,
		signal,
		provider: "kimi",
		poll: async () => {
			const response = await fetch(`${oauthHost}/api/oauth/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					...getKimiCommonHeaders(),
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal,
			});
			const payload = (await response.json()) as TokenResponse;
			if (response.ok && payload.access_token) return { status: "complete", value: payload };
			return pollResultOf(payload, response.status);
		},
	});
}

/** The regions in the order the region menu lists them; an empty answer selects the first. */
const REGION_MENU = Object.keys(KIMI_CODE_REGIONS) as KimiCodeRegion[];

/**
 * Ask which Kimi Code deployment the account belongs to. The menu lists every region of
 * `KIMI_CODE_REGIONS` by number; an empty answer selects the first, and any other answer that is not
 * a listed number fails the login.
 */
export async function askKimiCodeRegion(options: OAuthController): Promise<KimiCodeRegion> {
	if (!options.onPrompt) throw new AIError.OnPromptRequiredError("Kimi Code");
	const numbers = REGION_MENU.map((_, index) => String(index + 1));
	const choices = REGION_MENU.map((region, index) => {
		const { name, site } = KIMI_CODE_REGIONS[region];
		return `${numbers[index]}=${name} (${site}${index === 0 ? ", default" : ""})`;
	});
	const answer = await options.onPrompt({
		message: `Select your Kimi Code region: ${choices.join(", ")} — enter ${numbers.join(" or ")}`,
		placeholder: numbers[0],
		// A menu number, not a credential: masking it would hide which region you picked.
		secret: false,
	});
	// Escape answers "" and aborts the signal; an empty answer without an abort selects the default.
	if (options.signal?.aborted) throw new AIError.LoginCancelledError();
	const choice = answer.trim();
	const index = choice === "" ? 0 : numbers.indexOf(choice);
	const region = REGION_MENU[index];
	if (region === undefined) {
		throw new AIError.ConfigurationError(
			`Unknown Kimi Code region "${choice}". Fix: run the login again and enter ${numbers.join(" or ")}.`,
		);
	}
	return region;
}

/**
 * Login with Kimi Code OAuth (device code flow) at the deployment of `region`: `mainland-cn` signs in
 * at kimi.com, `global` at kimi.ai. An OAuth host set in the environment overrides the region's host,
 * and the credential records the deployment of that host, or `region` when the host is neither's.
 */
export async function loginKimi(options: OAuthController, region: KimiCodeRegion): Promise<OAuthCredentials> {
	const oauthHost = resolveOAuthHost(region);
	const device = await loginStep(options.signal, () => requestDeviceAuthorization(oauthHost, options.signal));
	options.onAuth?.({
		url: device.verificationUriComplete,
		instructions: `Enter code: ${device.userCode}`,
	});

	const granted = await pollForToken(
		oauthHost,
		device.deviceCode,
		device.intervalMs,
		device.expiresInMs,
		options.signal,
	);
	const credentials = parseTokenPayload(
		granted,
		kimiCodeApiEndpointOf(kimiCodeRegionOfOAuthHost(oauthHost) ?? region),
	);
	// Device-code flow has no browser redirect; show the branded success page.
	emitOAuthSuccessPage(options);
	return credentials;
}

/**
 * Refresh a Kimi OAuth token at the OAuth host of the region the credential's `apiEndpoint` names, so
 * a kimi.ai credential is never posted to kimi.com. `signal` aborts the token request.
 */
export async function refreshKimiToken(
	refreshToken: string,
	apiEndpoint: string | undefined,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const region = kimiCodeRegionOfApiEndpoint(apiEndpoint);
	const response = await fetch(`${resolveOAuthHost(region)}/api/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			...getKimiCommonHeaders(),
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: CLIENT_ID,
		}),
		signal,
	});

	if (!response.ok) {
		const payload = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
		// Carry the machine-readable `error` code, not only the prose
		// `error_description`. `isDefinitiveOAuthFailure` keys on codes such as
		// `invalid_grant` to decide whether a refresh failure means the grant is
		// dead (disable the credential, tell the user to log in again) or merely
		// transient (retry). Kimi returns 400 with `error: "invalid_grant"` and
		// `error_description: "The provided authorization grant is invalid"`, and
		// dropping the code left only prose that matched neither the definitive
		// pattern nor the 401 fallback. Every dead kimi grant was therefore
		// classified transient: the row was blocked for five minutes, never
		// disabled, and the session reported "signed in, but could not get a
		// usable token right now (for example a lapsed subscription)" on a loop
		// instead of "your login expired, run /login".
		const detail = [payload?.error, payload?.error_description].filter(Boolean).join(": ");
		throw new AIError.OAuthError(`Kimi token refresh failed: ${response.status}${detail ? `: ${detail}` : ""}`, {
			kind: "token-refresh",
			provider: "kimi",
			status: response.status,
		});
	}

	const payload = requireTokenResponseObject<TokenResponse>(await response.json(), "kimi", "token refresh");
	return parseTokenPayload(payload, kimiCodeApiEndpointOf(region), refreshToken);
}
