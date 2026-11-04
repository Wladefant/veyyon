import { CURSOR_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { decodeJwtPayload } from "@veyyon/utils/jwt";
import * as AIError from "../../error";
import { credentialExpiryFromJwtExp } from "./expiry";
import { generatePKCE } from "./pkce";
import { requireTokenResponseObject } from "./token-response";
import type { OAuthCredentials } from "./types";

const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = `${CURSOR_API_ENDPOINT}/auth/poll`;
const CURSOR_REFRESH_URL = `${CURSOR_API_ENDPOINT}/auth/exchange_user_api_key`;

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

export interface CursorAuthParams {
	verifier: string;
	challenge: string;
	uuid: string;
	loginUrl: string;
}

export async function generateCursorAuthParams(): Promise<CursorAuthParams> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = crypto.randomUUID();

	const params = new URLSearchParams({
		challenge,
		uuid,
		mode: "login",
		redirectTarget: "cli",
	});

	const loginUrl = `${CURSOR_LOGIN_URL}?${params.toString()}`;

	return { verifier, challenge, uuid, loginUrl };
}

export async function pollCursorAuth(
	uuid: string,
	verifier: string,
): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = POLL_BASE_DELAY;
	let consecutiveErrors = 0;

	for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
		await Bun.sleep(delay);

		try {
			const response = await fetch(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`);

			if (response.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
				continue;
			}

			if (response.ok) {
				const data = (await response.json()) as {
					accessToken: string;
					refreshToken: string;
				};
				return {
					accessToken: data.accessToken,
					refreshToken: data.refreshToken,
				};
			}

			throw new AIError.OAuthError(`Poll failed: ${response.status}`, {
				kind: "polling",
				provider: "cursor",
				status: response.status,
			});
		} catch {
			consecutiveErrors++;
			if (consecutiveErrors >= 3) {
				throw new AIError.OAuthError("Too many consecutive errors during Cursor auth polling", {
					kind: "polling",
					provider: "cursor",
				});
			}
		}
	}

	throw new AIError.OAuthError("Cursor authentication polling timeout", {
		kind: "timeout",
		provider: "cursor",
	});
}

export async function loginCursor(
	onAuthUrl: (url: string) => void,
	onPollStart?: () => void,
): Promise<OAuthCredentials> {
	const { verifier, uuid, loginUrl } = await generateCursorAuthParams();

	onAuthUrl(loginUrl);
	onPollStart?.();

	const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);

	const expiresAt = getTokenExpiry(accessToken);

	return {
		access: accessToken,
		refresh: refreshToken,
		expires: expiresAt,
	};
}

export async function refreshCursorToken(
	apiKeyOrRefreshToken: string,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKeyOrRefreshToken}`,
			"Content-Type": "application/json",
		},
		body: "{}",
		signal,
	});

	if (!response.ok) {
		// A refresh endpoint's error body can echo the credential it refused, so it is read
		// through the shared bounded reader and its redactor.
		// The status leads the message: a dead Cursor key answers `401 {"message":"Invalid User API
		// Key"}`, which carries no OAuth error code, so the status is the only definitive signal.
		const error = await AIError.readProviderErrorDetail(response);
		throw new AIError.OAuthError(`Cursor token refresh failed: ${response.status} ${error}`, {
			kind: "token-refresh",
			provider: "cursor",
			status: response.status,
		});
	}

	const data = requireTokenResponseObject<{ accessToken?: unknown; refreshToken?: unknown }>(
		await response.json(),
		"cursor",
		"token refresh",
	);
	if (typeof data.accessToken !== "string" || data.accessToken.length === 0) {
		throw new AIError.OAuthError("Cursor token refresh response missing accessToken", {
			kind: "validation",
			provider: "cursor",
		});
	}

	return {
		access: data.accessToken,
		refresh: typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : apiKeyOrRefreshToken,
		expires: getTokenExpiry(data.accessToken),
	};
}

function getTokenExpiry(token: string): number {
	const decoded = decodeJwtPayload<{ exp?: unknown }>(token);
	if (decoded && typeof decoded.exp === "number") {
		return credentialExpiryFromJwtExp(decoded.exp, { provider: "cursor" });
	}
	return Date.now() + 3600 * 1000;
}
