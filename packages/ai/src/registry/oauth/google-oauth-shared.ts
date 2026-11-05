/**
 * Shared OAuth flow for Google-style providers (Gemini CLI, Antigravity).
 *
 * Both providers use the same authorization-code flow shape; only the client
 * credentials, scopes, endpoint constants, and project-discovery logic differ.
 */

import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import * as AIError from "../../error";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../../utils/google-validation";
import { OAuthCallbackFlow } from "./callback-server";
import { credentialExpiryFromExpiresIn } from "./expiry";
import { requireTokenResponseObject } from "./token-response";
import type { OAuthController, OAuthCredentials } from "./types";

/**
 * Google Code Assist tier ids, as the API spells them.
 *
 * ONE vocabulary for the two providers that speak this API. `legacy-tier` was
 * declared in BOTH `google-gemini-cli.ts` and `google-antigravity.ts`, and it is the
 * value each falls back to when the response names no tier, so a drift would have
 * put two providers on two different default tiers while both files read correctly
 * on their own. The other two ids live here with it rather than being left behind:
 * they are the same vocabulary, and splitting a vocabulary across modules is how the
 * duplicate appeared in the first place.
 */
export const TIER_FREE = "free-tier";
export const TIER_LEGACY = "legacy-tier";
export const TIER_STANDARD = "standard-tier";

export interface GoogleOAuthFlowConfig {
	clientId: string;
	clientSecret: string;
	authUrl: string;
	tokenUrl: string;
	/** Read only to build the `scope` parameter, so a shared, frozen scope list is accepted as-is. */
	scopes: readonly string[];
	callbackPort: number;
	callbackPath: string;
	discoverProject: (accessToken: string, onProgress?: (message: string) => void) => Promise<string>;
}

/** What differs between the Google providers' token refreshes. */
export interface GoogleTokenRefreshConfig {
	clientId: string;
	clientSecret: string;
	tokenUrl: string;
	/** Provider id recorded on a refresh error and on an invalid expiry. */
	provider: string;
	/** The provider as a refresh failure message names it, as in `Antigravity token refresh failed`. */
	label: string;
}

/** Exchange `refreshToken` for a new access token. `signal` aborts the token request. */
export async function refreshGoogleOAuthToken(
	config: GoogleTokenRefreshConfig,
	refreshToken: string,
	projectId: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch(config.tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
		signal,
	});

	if (!response.ok) {
		// A refresh endpoint's error body can echo the credential it refused, so it is read
		// through the shared bounded reader and its redactor.
		const error = await AIError.readProviderErrorDetail(response);
		throw new AIError.OAuthError(`${config.label} token refresh failed: ${response.status} ${error}`, {
			kind: "token-refresh",
			provider: config.provider,
			status: response.status,
		});
	}

	const data = requireTokenResponseObject<{
		access_token: string;
		expires_in: number;
		refresh_token?: string;
	}>(await response.json(), config.provider, "token refresh");

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: credentialExpiryFromExpiresIn(data.expires_in, { provider: config.provider }),
		projectId,
	};
}

/**
 * The signed-in Google account: its email, and `id`, the account's stable numeric identifier.
 *
 * The id is stored as the credential's `accountId` because a Google account keeps it across an
 * email change, and the email alone made the same account read as two: a login under the new
 * address left the login under the old one behind as a separate, signed-out account.
 */
async function getUserInfo(accessToken: string): Promise<{ email?: string; id?: string }> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		if (response.ok) {
			const data = (await response.json()) as { email?: unknown; id?: unknown };
			return {
				email: typeof data.email === "string" ? data.email : undefined,
				id: typeof data.id === "string" && data.id.length > 0 ? data.id : undefined,
			};
		}
		logger.warn("Google account email lookup was refused; the credential will be stored without an account label", {
			status: response.status,
		});
	} catch (error) {
		// The login still succeeds without an email, which is why this is not
		// fatal. But the email is how the account picker names this credential, so
		// discarding the reason leaves an operator with two unlabelled Google
		// accounts and no way to learn why either one lost its name.
		logger.warn("Google account email lookup failed; the credential will be stored without an account label", {
			error: errorMessage(error),
		});
	}
	return {};
}

export class GoogleOAuthFlow extends OAuthCallbackFlow {
	readonly #config: GoogleOAuthFlowConfig;

	constructor(ctrl: OAuthController, config: GoogleOAuthFlowConfig) {
		super(ctrl, {
			preferredPort: config.callbackPort,
			callbackPath: config.callbackPath,
			callbackHostname: "127.0.0.1",
		});
		this.#config = config;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: this.#config.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: this.#config.scopes.join(" "),
			state,
			access_type: "offline",
			prompt: "consent",
		});

		const url = `${this.#config.authUrl}?${authParams.toString()}`;
		return { url, instructions: "Complete the sign-in in your browser." };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

		const tokenResponse = await fetch(this.#config.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.#config.clientId,
				client_secret: this.#config.clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
			}),
		});

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			throw new AIError.OAuthError(`Token exchange failed: ${error}`, { kind: "token-exchange" });
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		if (!tokenData.refresh_token) {
			throw new AIError.OAuthError("No refresh token received. Please try again.", { kind: "validation" });
		}

		this.ctrl.onProgress?.("Getting user info...");
		const { email, id: accountId } = await getUserInfo(tokenData.access_token);
		let projectId: string;
		try {
			projectId = await this.#config.discoverProject(tokenData.access_token, this.ctrl.onProgress);
		} catch (err) {
			const validationUrl = extractGoogleValidationUrl(errorMessage(err));
			if (!validationUrl) throw err;
			throw new AIError.OAuthError(formatGoogleValidationRequiredMessage(validationUrl, "sign in again", email), {
				kind: "validation",
			});
		}

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: credentialExpiryFromExpiresIn(tokenData.expires_in, { provider: "google" }),
			projectId,
			email,
			...(accountId ? { accountId } : {}),
		};
	}
}

export async function runGoogleOAuthLogin(
	ctrl: OAuthController,
	config: GoogleOAuthFlowConfig,
): Promise<OAuthCredentials> {
	const flow = new GoogleOAuthFlow(ctrl, config);
	return flow.login();
}
