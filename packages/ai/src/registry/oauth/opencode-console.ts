/**
 * OpenCode Go sign-in with an OpenCode Console account.
 *
 * The Console speaks the OAuth device flow (RFC 8628) to the public client `opencode-cli`, the client
 * OpenCode's own CLI signs in with, so the consent page names the OpenCode CLI. The access token is not
 * accepted by the public Go gateway: the Console's `/api/config` names, per organization, the inference
 * endpoint of that organization's Go subscription, and the endpoint takes the token as a bearer together
 * with the organization id. The login stores the organization and the endpoint beside the token, and a
 * request reads both from the API key (`@veyyon/catalog/wire/opencode-go`).
 *
 * Refresh tokens rotate: every refresh returns a new one and voids the old.
 */
import { opencodeGoAccountRoot } from "@veyyon/catalog/wire/opencode-go";
import { getOpenCodeUserAgent } from "@veyyon/catalog/wire/opencode-headers";
import { isRecord } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { pollOAuthDeviceCodeFlow } from "./device-code";
import { credentialExpiryFromExpiresIn } from "./expiry";
import { emitOAuthSuccessPage } from "./success-page";
import { requireTokenResponseObject } from "./token-response";
import type { OAuthController, OAuthCredentials } from "./types";

export const OPENCODE_CONSOLE_URL = "https://opencode.ai/console";
export const OPENCODE_CONSOLE_CLIENT_ID = "opencode-cli";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const PROVIDER_ID = "opencode-go";
/** RFC 8628 defaults, for a Console that omits `interval` or `expires_in`. */
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 600;
const API_KEY_LOGIN_HINT = "To use an OpenCode Go API key instead, run `/login opencode-go-api-key`.";

interface DeviceCodeResponse {
	device_code?: unknown;
	user_code?: unknown;
	verification_uri?: unknown;
	verification_uri_complete?: unknown;
	expires_in?: unknown;
	interval?: unknown;
}

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	org_id?: unknown;
	error?: unknown;
	error_description?: unknown;
	message?: unknown;
}

interface DeviceAuthorization {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}

/** The organization a login uses: the first, by name, whose Console config names a Go endpoint. */
interface GoOrganization {
	id: string;
	name: string;
	apiEndpoint: string;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function errorDetail(payload: TokenResponse): string {
	return [payload.error, payload.error_description, payload.message]
		.filter(isNonEmptyString)
		.map(value => value.trim())
		.join(": ");
}

/** One Console request. A `body` makes it a JSON POST; `orgId` scopes it to an organization. */
function consoleRequest(
	fetchImpl: FetchImpl,
	path: string,
	init: { body?: Record<string, string | boolean>; token?: string; orgId?: string; signal?: AbortSignal },
): Promise<Response> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": getOpenCodeUserAgent(),
	};
	if (init.body) headers["Content-Type"] = "application/json";
	if (init.token) headers.Authorization = `Bearer ${init.token}`;
	if (init.orgId) headers["x-org-id"] = init.orgId;
	return fetchImpl(`${OPENCODE_CONSOLE_URL}${path}`, {
		method: init.body ? "POST" : "GET",
		headers,
		body: init.body ? JSON.stringify(init.body) : undefined,
		signal: init.signal,
	});
}

function failedResponse(response: Response, operation: string, detail: string, cause?: unknown): AIError.OAuthError {
	const reason = detail || response.statusText;
	return new AIError.OAuthError(
		`OpenCode Console ${operation} failed: ${response.status}${reason ? `: ${reason}` : ""}`,
		{ kind: "http", provider: PROVIDER_ID, status: response.status, cause },
	);
}

/**
 * The JSON object a Console response carries. The status is read before a parse failure is reported:
 * a gateway in front of the Console answers a 502 with an HTML page, and calling that invalid JSON
 * would describe a request that never reached the Console as malformed.
 */
async function responseJson<T extends object>(response: Response, operation: string): Promise<T> {
	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		if (!response.ok) throw failedResponse(response, operation, "", cause);
		throw new AIError.OAuthError(`OpenCode Console ${operation} returned invalid JSON`, {
			kind: "validation",
			provider: PROVIDER_ID,
			status: response.status,
			cause,
		});
	}
	if (!response.ok && !isRecord(body)) throw failedResponse(response, operation, "");
	return requireTokenResponseObject<T>(body, PROVIDER_ID, operation);
}

/** A GET with the access token; a network failure is an `http` error naming the lookup. */
async function consoleGet(
	fetchImpl: FetchImpl,
	path: string,
	operation: string,
	token: string,
	signal: AbortSignal | undefined,
	orgId?: string,
): Promise<Response> {
	try {
		return await consoleRequest(fetchImpl, path, { token, orgId, signal });
	} catch (cause) {
		throw new AIError.OAuthError(`OpenCode Console ${operation} request failed`, {
			kind: "http",
			provider: PROVIDER_ID,
			cause,
		});
	}
}

async function requestDeviceAuthorization(fetchImpl: FetchImpl, signal?: AbortSignal): Promise<DeviceAuthorization> {
	let response: Response;
	try {
		response = await consoleRequest(fetchImpl, "/auth/device/code", {
			body: { client_id: OPENCODE_CONSOLE_CLIENT_ID, supports_org_scope: true },
			signal,
		});
	} catch (cause) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw new AIError.OAuthError(
			"Could not start the OpenCode Console login. Check the network connection, then retry.",
			{ kind: "device-auth", provider: PROVIDER_ID, cause },
		);
	}
	if (!response.ok) {
		const detail = await AIError.readProviderErrorDetail(response);
		throw new AIError.OAuthError(
			`OpenCode Console device authorization failed: ${response.status}${detail ? `: ${detail}` : ""}`,
			{ kind: "device-auth", provider: PROVIDER_ID, status: response.status },
		);
	}

	const payload = await responseJson<DeviceCodeResponse>(response, "device authorization");
	const rawUrl = isNonEmptyString(payload.verification_uri_complete)
		? payload.verification_uri_complete
		: isNonEmptyString(payload.verification_uri)
			? payload.verification_uri
			: undefined;
	if (!isNonEmptyString(payload.device_code) || !isNonEmptyString(payload.user_code) || rawUrl === undefined) {
		throw new AIError.OAuthError("OpenCode Console device authorization response missing required fields", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	// The Console answers with an origin-relative path (`/console/device?...`).
	let verificationUrl: URL;
	try {
		verificationUrl = new URL(rawUrl.trim(), `${OPENCODE_CONSOLE_URL}/`);
	} catch (cause) {
		throw new AIError.OAuthError(`OpenCode Console returned an unusable verification URL: ${rawUrl}`, {
			kind: "validation",
			provider: PROVIDER_ID,
			cause,
		});
	}
	if (verificationUrl.protocol !== "https:" && verificationUrl.protocol !== "http:") {
		throw new AIError.OAuthError(`OpenCode Console returned an unusable verification URL: ${rawUrl}`, {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	return {
		deviceCode: payload.device_code.trim(),
		userCode: payload.user_code.trim(),
		verificationUrl: verificationUrl.href,
		expiresInSeconds: isPositiveFiniteNumber(payload.expires_in) ? payload.expires_in : DEFAULT_EXPIRES_IN_SECONDS,
		intervalSeconds: isPositiveFiniteNumber(payload.interval) ? payload.interval : DEFAULT_INTERVAL_SECONDS,
	};
}

async function pollForToken(
	device: DeviceAuthorization,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<TokenResponse & { access_token: string }> {
	return pollOAuthDeviceCodeFlow<TokenResponse & { access_token: string }>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		signal,
		poll: async () => {
			let response: Response;
			try {
				response = await consoleRequest(fetchImpl, "/auth/device/token", {
					body: {
						grant_type: DEVICE_CODE_GRANT,
						device_code: device.deviceCode,
						client_id: OPENCODE_CONSOLE_CLIENT_ID,
					},
					signal,
				});
			} catch (cause) {
				if (signal?.aborted) throw new AIError.LoginCancelledError();
				throw new AIError.OAuthError("OpenCode Console device token request failed", {
					kind: "polling",
					provider: PROVIDER_ID,
					cause,
				});
			}
			// A gateway failure is not an answer to the code; the code stays valid until it expires.
			if (response.status === 429) return { status: "slow_down" };
			if (response.status >= 500) return { status: "pending" };

			const payload = await responseJson<TokenResponse>(response, "device token exchange");
			if (response.ok && isNonEmptyString(payload.access_token)) {
				return { status: "complete", value: { ...payload, access_token: payload.access_token } };
			}
			if (payload.error === "authorization_pending") return { status: "pending" };
			if (payload.error === "slow_down") return { status: "slow_down" };
			if (payload.error === "expired_token") {
				return { status: "failed", message: "The OpenCode Console login code expired before it was approved" };
			}
			if (payload.error === "access_denied") {
				return { status: "failed", message: "The OpenCode Console login was declined" };
			}
			const detail = errorDetail(payload);
			return {
				status: "failed",
				message: `OpenCode Console device authorization failed: ${detail || response.status}`,
			};
		},
	});
}

async function fetchUser(
	fetchImpl: FetchImpl,
	access: string,
	signal: AbortSignal | undefined,
): Promise<{ id: string; email: string | undefined }> {
	const response = await consoleGet(fetchImpl, "/api/user", "account lookup", access, signal);
	const payload = await responseJson<{ id?: unknown; email?: unknown } & TokenResponse>(response, "account lookup");
	if (!response.ok) throw failedResponse(response, "account lookup", errorDetail(payload));
	if (!isNonEmptyString(payload.id)) {
		throw new AIError.OAuthError("OpenCode Console account lookup returned no account id", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	return { id: payload.id.trim(), email: isNonEmptyString(payload.email) ? payload.email.trim() : undefined };
}

/** The Go inference endpoint an organization's Console config names, or `undefined` when it names none. */
function goApiEndpointOf(config: unknown): string | undefined {
	if (!isRecord(config) || !isRecord(config.config) || !isRecord(config.config.provider)) return undefined;
	const go = config.config.provider["opencode-go"];
	return isRecord(go) && isNonEmptyString(go.api) ? go.api.trim() : undefined;
}

async function goApiEndpointOfOrganization(
	fetchImpl: FetchImpl,
	access: string,
	orgId: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const response = await consoleGet(fetchImpl, "/api/config", "organization config", access, signal, orgId);
	// An organization whose config cannot be read is one the login cannot use; the next one is tried.
	if (!response.ok) {
		await response.body?.cancel();
		return undefined;
	}
	try {
		return goApiEndpointOf(await response.json());
	} catch {
		return undefined;
	}
}

/**
 * The organization a login uses. With `grantedOrgId`, the organization chosen on the consent page and
 * no other; otherwise the first by name, then id, whose Console config names a Go endpoint.
 */
async function findGoOrganization(
	fetchImpl: FetchImpl,
	access: string,
	grantedOrgId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<GoOrganization> {
	const response = await consoleGet(fetchImpl, "/api/orgs", "organization list", access, signal);
	if (!response.ok) {
		throw failedResponse(response, "organization list", await AIError.readProviderErrorDetail(response));
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch (cause) {
		throw new AIError.OAuthError("OpenCode Console organization list returned invalid JSON", {
			kind: "validation",
			provider: PROVIDER_ID,
			cause,
		});
	}
	if (!Array.isArray(body)) {
		throw new AIError.OAuthError("OpenCode Console organization list is not an array", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	const organizations: { id: string; name: string }[] = [];
	for (const entry of body) {
		if (!isRecord(entry) || !isNonEmptyString(entry.id)) continue;
		const id = entry.id.trim();
		organizations.push({ id, name: isNonEmptyString(entry.name) ? entry.name.trim() : id });
	}

	let candidates: { id: string; name: string }[];
	if (grantedOrgId !== undefined) {
		const granted = organizations.find(organization => organization.id === grantedOrgId);
		if (!granted) {
			throw new AIError.OAuthError(`OpenCode organization not found: ${grantedOrgId}`, {
				kind: "validation",
				provider: PROVIDER_ID,
			});
		}
		candidates = [granted];
	} else {
		candidates = organizations.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	}

	const endpoints = await Promise.all(
		candidates.map(organization => goApiEndpointOfOrganization(fetchImpl, access, organization.id, signal)),
	);
	const unroutable: string[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const endpoint = endpoints[i];
		if (endpoint === undefined) continue;
		if (opencodeGoAccountRoot(endpoint) === undefined) {
			unroutable.push(endpoint);
			continue;
		}
		return { ...candidates[i], apiEndpoint: trimTrailingSlashes(endpoint) };
	}
	if (unroutable.length > 0) {
		throw new AIError.OAuthError(
			`OpenCode Console named an OpenCode Go endpoint that is not an HTTPS .../openai/v1 route: ${unroutable.join(", ")}. ${API_KEY_LOGIN_HINT}`,
			{ kind: "validation", provider: PROVIDER_ID },
		);
	}
	const missing =
		grantedOrgId !== undefined
			? `The OpenCode organization ${candidates[0]?.name ?? grantedOrgId} has no OpenCode Go subscription`
			: "No organization of this OpenCode account has an OpenCode Go subscription";
	throw new AIError.OAuthError(
		`${missing}. Subscribe at https://opencode.ai/go and log in again. ${API_KEY_LOGIN_HINT}`,
		{ kind: "validation", provider: PROVIDER_ID },
	);
}

function requireRefreshToken(payload: TokenResponse, fallback?: string): string {
	if (isNonEmptyString(payload.refresh_token)) return payload.refresh_token.trim();
	if (fallback) return fallback;
	throw new AIError.OAuthError("OpenCode Console token response missing refresh_token", {
		kind: "validation",
		provider: PROVIDER_ID,
	});
}

function grantedOrganization(payload: TokenResponse): string | undefined {
	return isNonEmptyString(payload.org_id) ? payload.org_id.trim() : undefined;
}

/** Sign in to OpenCode Go with an OpenCode Console account through the device flow. */
export async function loginOpenCodeGo(options: OAuthController): Promise<OAuthCredentials> {
	if (!options.onAuth) {
		throw new AIError.OAuthError(
			"OpenCode Console login requires an onAuth callback to show the verification URL in browser and headless sessions",
			{ kind: "configuration", provider: PROVIDER_ID },
		);
	}
	const fetchImpl = options.fetch ?? fetch;
	const { signal } = options;
	const device = await requestDeviceAuthorization(fetchImpl, signal);
	options.onAuth({
		url: device.verificationUrl,
		// The link already carries the code, and every surface that shows it says how to open it.
		instructions: `Enter code ${device.userCode} if the page asks for it.`,
	});
	options.onProgress?.("Waiting for OpenCode Console authorization...");
	const token = await pollForToken(device, fetchImpl, signal);
	const issuedAtMs = Date.now();
	try {
		const access = token.access_token.trim();
		const refresh = requireRefreshToken(token);
		const expires = credentialExpiryFromExpiresIn(token.expires_in, { provider: PROVIDER_ID, issuedAtMs });
		options.onProgress?.("Finding the organization with an OpenCode Go subscription...");
		const [user, organization] = await Promise.all([
			fetchUser(fetchImpl, access, signal),
			findGoOrganization(fetchImpl, access, grantedOrganization(token), signal),
		]);
		emitOAuthSuccessPage(options);
		return {
			access,
			refresh,
			expires,
			accountId: user.id,
			email: user.email,
			orgId: organization.id,
			orgName: organization.name,
			apiEndpoint: organization.apiEndpoint,
		};
	} catch (error) {
		if (signal?.aborted) throw new AIError.LoginCancelledError();
		throw error;
	}
}

/**
 * Refresh an OpenCode Console token. The organization and endpoint stay as stored unless the Console
 * scopes the new token to a different organization. `signal` aborts the token request.
 */
export async function refreshOpenCodeGoToken(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const refreshToken = credentials.refresh.trim();
	if (!refreshToken) {
		throw new AIError.OAuthError("OpenCode Console refresh token is missing; sign in again", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}

	let response: Response;
	try {
		response = await consoleRequest(fetchImpl, "/auth/device/token", {
			body: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: OPENCODE_CONSOLE_CLIENT_ID },
			signal,
		});
	} catch (cause) {
		throw new AIError.OAuthError("OpenCode Console token refresh request failed", {
			kind: "token-refresh",
			provider: PROVIDER_ID,
			cause,
		});
	}
	const payload = await responseJson<TokenResponse>(response, "token refresh");
	if (!response.ok) {
		const detail = errorDetail(payload);
		throw new AIError.OAuthError(
			`OpenCode Console token refresh failed: ${response.status}${detail ? `: ${detail}` : ""}`,
			{ kind: "token-refresh", provider: PROVIDER_ID, status: response.status },
		);
	}
	if (!isNonEmptyString(payload.access_token)) {
		throw new AIError.OAuthError("OpenCode Console token response missing access_token", {
			kind: "validation",
			provider: PROVIDER_ID,
		});
	}
	const access = payload.access_token.trim();
	const refresh = requireRefreshToken(payload, refreshToken);
	const expires = credentialExpiryFromExpiresIn(payload.expires_in, { provider: PROVIDER_ID });
	const grantedOrgId = grantedOrganization(payload);
	if (grantedOrgId !== undefined && credentials.orgId !== undefined && grantedOrgId !== credentials.orgId) {
		const organization = await findGoOrganization(fetchImpl, access, grantedOrgId, signal);
		return {
			access,
			refresh,
			expires,
			orgId: organization.id,
			orgName: organization.name,
			apiEndpoint: organization.apiEndpoint,
		};
	}
	return { access, refresh, expires };
}
