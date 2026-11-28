/**
 * MCP OAuth Auto-Discovery
 *
 * Automatically detects OAuth requirements from MCP server responses
 * and extracts authentication endpoints.
 */

import * as AIError from "@veyyon/ai/error";
import type { FetchImpl } from "@veyyon/ai/types";
import { errorMessage, logger, trimTrailingSlashes } from "@veyyon/utils";
import { MCPHttpFailure } from "./transports/http-failure";

export interface OAuthEndpoints {
	authorizationUrl: string;
	tokenUrl: string;
	clientId?: string;
	/** Dynamic client registration endpoint advertised by the authorization server. */
	registrationUrl?: string;
	scopes?: string;
	/** Whether scopes are a provider-authored request rather than a supported-set fallback. */
	explicitScopes?: boolean;
	resource?: string;
}

function readRegistrationUrl(metadata: Record<string, unknown>): string | undefined {
	const value =
		metadata.registration_endpoint ??
		metadata.registrationEndpoint ??
		metadata.registration_url ??
		metadata.registrationUrl ??
		metadata.registration_uri ??
		metadata.registrationUri;
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export interface AuthDetectionResult {
	requiresAuth: boolean;
	authType?: "oauth" | "apikey" | "unknown";
	oauth?: OAuthEndpoints;
	authServerUrl?: string;
	resourceMetadataUrl?: string;
	/**
	 * OAuth scopes advertised by the challenge (RFC 6750 `scope=` on
	 * `WWW-Authenticate`) or by protected-resource metadata. Passed through
	 * `discoverOAuthEndpoints` as `protectedScopes` so the eventual
	 * authorization request carries them even when the auth-server metadata
	 * document itself omits `scopes_supported`.
	 */
	scopes?: string;
	message?: string;
}

export function extractMcpAuthServerUrl(error: Error, serverUrl?: string): string | undefined {
	const value =
		error instanceof MCPHttpFailure
			? error.mcpAuthServer
			: error.message.match(/Mcp-Auth-Server:\s*([^;\]\s]+)/i)?.[1];
	if (!value) return undefined;

	try {
		return new URL(value, serverUrl).toString();
	} catch {
		// The server sent an `Mcp-Auth-Server` value that is not a URL, so there is no auth server to
		// point at. Discovery continues with its well-known probes and reports if none of them work.
		return undefined;
	}
}

function leadingAuthChallenge(message: string): string | undefined {
	// Some callers pass a standalone challenge with an optional HTTP prefix.
	const prefix =
		/^(?:(?:HTTP )?(?:401|403)(?: Unauthorized| Forbidden)?:[ \t]*)?(?:WWW-Authenticate:[ \t]*|(?=Bearer(?:[ \t,]|$)))/i.exec(
			message,
		);
	return prefix ? message.slice(prefix[0].length) : undefined;
}

function readAuthChallenges(header: string): { scheme: string; params: ReadonlyMap<string, string> }[] {
	const challenges: { scheme: string; params: ReadonlyMap<string, string> }[] = [];

	// RFC 9110 sections 5.6 and 11: consume tokens at the current position.
	// After a comma, a token without '=' starts a new challenge.
	const scheme = /[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?=[ \t,]|$)/y;
	const param =
		/([!#$%&'*+\-.^_`|~0-9A-Za-z]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+\-.^_`|~0-9A-Za-z]+))(?=[ \t,;]|$)/y;
	const token68 = /[a-zA-Z0-9\-._~+/]+=*(?=[ \t,]|$)/y;
	const separator = /[ \t,]*/y;
	let pos = 0;
	while (pos < header.length) {
		separator.lastIndex = pos;
		separator.exec(header);
		pos = separator.lastIndex;
		scheme.lastIndex = pos;
		const challenge = scheme.exec(header);
		if (!challenge) break;
		const params = new Map<string, string>();
		challenges.push({ scheme: challenge[0].toLowerCase(), params });
		pos = scheme.lastIndex;
		let first = true;
		while (pos < header.length) {
			separator.lastIndex = pos;
			const gap = separator.exec(header)?.[0] ?? "";
			pos = separator.lastIndex;
			if (!gap) return challenges;

			param.lastIndex = pos;
			const entry = param.exec(header);
			if (entry) {
				const key = entry[1].toLowerCase();
				const value = entry[2]?.replace(/\\([^\r\n])/g, "$1") ?? entry[3];
				if (value.trim() && !params.has(key)) params.set(key, value);
				pos = param.lastIndex;
				first = false;
			} else if (gap.includes(",")) {
				break;
			} else {
				token68.lastIndex = pos;
				if (!first || !token68.test(header)) return challenges;
				separator.lastIndex = token68.lastIndex;
				if (!separator.exec(header)?.[0].includes(",")) return challenges;
				pos = separator.lastIndex;
				break;
			}
		}
	}
	return challenges;
}

function isHttpUrl(value: string | undefined): value is string {
	return value !== undefined && /^https?:/i.test(value) && URL.canParse(value);
}

function challengeEndpoints(params: ReadonlyMap<string, string>) {
	const authorizationUrl =
		params.get("authorization_uri") ??
		params.get("authorization_url") ??
		params.get("authorization_endpoint") ??
		params.get("authorize_url") ??
		params.get("realm");
	const tokenUrl = params.get("token_url") ?? params.get("token_uri") ?? params.get("token_endpoint");
	return isHttpUrl(authorizationUrl) && isHttpUrl(tokenUrl) ? { authorizationUrl, tokenUrl } : undefined;
}

function challengeResourceMetadata(params: ReadonlyMap<string, string>): string | undefined {
	const url = params.get("resource_metadata");
	return isHttpUrl(url) ? url : undefined;
}

function readBearerParams(error: Error): ReadonlyMap<string, string> {
	const header = error instanceof MCPHttpFailure ? error.wwwAuthenticate : leadingAuthChallenge(error.message);
	let metadataChallenge: ReadonlyMap<string, string> | undefined;
	let scopeChallenge: ReadonlyMap<string, string> | undefined;
	for (const { scheme, params } of header ? readAuthChallenges(header) : []) {
		if (scheme !== "bearer") continue;
		if (challengeEndpoints(params)) return params;
		// Prefer complete endpoints, then a discovery URL, then scopes alone.
		// Within a tier, keep the first challenge in the header.
		if (!metadataChallenge && challengeResourceMetadata(params)) metadataChallenge = params;
		if (!scopeChallenge && (params.has("scope") || params.has("scopes"))) scopeChallenge = params;
	}
	return metadataChallenge ?? scopeChallenge ?? new Map();
}

/** Read the OAuth scope requested by a Bearer challenge, not the response body. */
export function extractOAuthChallengeScopes(error: Error): string | undefined {
	const params = readBearerParams(error);
	return params.get("scope") ?? params.get("scopes");
}

/**
 * Extract OAuth endpoints from error response.
 * Looks for WWW-Authenticate header format or JSON error bodies.
 */
export function extractOAuthEndpoints(error: Error): OAuthEndpoints | null {
	return readOAuthEndpoints(error, readBearerParams(error));
}

function readOAuthEndpoints(error: Error, challengeValues: ReadonlyMap<string, string>): OAuthEndpoints | null {
	const errorMsg = error.message;

	const readEndpointsFromObject = (obj: Record<string, unknown>): OAuthEndpoints | null => {
		const authorizationUrl =
			(obj.authorization_url as string | undefined) ||
			(obj.authorizationUrl as string | undefined) ||
			(obj.authorization_endpoint as string | undefined) ||
			(obj.authorizationEndpoint as string | undefined) ||
			(obj.authorization_uri as string | undefined) ||
			(obj.authorizationUri as string | undefined);
		const tokenUrl =
			(obj.token_url as string | undefined) ||
			(obj.tokenUrl as string | undefined) ||
			(obj.token_endpoint as string | undefined) ||
			(obj.tokenEndpoint as string | undefined) ||
			(obj.token_uri as string | undefined) ||
			(obj.tokenUri as string | undefined);

		if (!authorizationUrl || !tokenUrl) return null;

		const explicitScopes = readExplicitScopes(obj, authorizationUrl);
		const scopes = explicitScopes ?? readMetadataScopes(obj);
		const clientId =
			(obj.client_id as string | undefined) ||
			(obj.clientId as string | undefined) ||
			(obj.default_client_id as string | undefined) ||
			(obj.public_client_id as string | undefined);

		const resource =
			(obj.resource as string | undefined) ||
			(obj.resource_uri as string | undefined) ||
			(obj.resourceUri as string | undefined);

		return {
			authorizationUrl,
			tokenUrl,
			registrationUrl: readRegistrationUrl(obj),
			clientId,
			scopes,
			explicitScopes: explicitScopes !== undefined,
			resource,
		};
	};

	const clientIdFromAuthUrl = (authorizationUrl: string): string | undefined => {
		try {
			return new URL(authorizationUrl).searchParams.get("client_id") ?? undefined;
		} catch {
			// This only mines an OPTIONAL hint out of the URL. Undefined means "not advertised there",
			// which is also what a parseable URL without the parameter returns, and the caller then falls
			// back to dynamic registration. The URL itself is validated where it is used.
			return undefined;
		}
	};

	try {
		// Try to parse as JSON error response
		// Many MCP servers return JSON with OAuth endpoints in error body
		const jsonMatch = errorMsg.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const errorBody = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

			// Check for OAuth endpoints in error body
			if (errorBody.oauth || errorBody.authorization || errorBody.auth) {
				const oauthData = (errorBody.oauth || errorBody.authorization || errorBody.auth) as Record<string, unknown>;
				const endpoints = readEndpointsFromObject(oauthData);
				if (endpoints) {
					const resourceExplicitScopes = readExplicitScopes(errorBody);
					const resourceScopes = readMetadataScopes(errorBody);

					return {
						...endpoints,
						clientId: endpoints.clientId || clientIdFromAuthUrl(endpoints.authorizationUrl),
						scopes:
							resourceExplicitScopes ??
							(endpoints.explicitScopes ? endpoints.scopes : undefined) ??
							resourceScopes ??
							endpoints.scopes,
						explicitScopes: resourceExplicitScopes !== undefined || endpoints.explicitScopes,
					};
				}
			}

			const topLevelEndpoints = readEndpointsFromObject(errorBody);
			if (topLevelEndpoints) {
				return {
					...topLevelEndpoints,
					clientId: topLevelEndpoints.clientId || clientIdFromAuthUrl(topLevelEndpoints.authorizationUrl),
				};
			}
		}
	} catch {
		// Not JSON, continue with other detection methods
	}

	const endpoints = challengeEndpoints(challengeValues);
	if (endpoints) {
		const { authorizationUrl, tokenUrl } = endpoints;
		const scope = mergeRequestedScopes(
			challengeValues.get("scope") ?? challengeValues.get("scopes"),
			scopeFromAuthUrl(authorizationUrl),
		);
		return {
			authorizationUrl,
			tokenUrl,
			registrationUrl:
				challengeValues.get("registration_endpoint") ||
				challengeValues.get("registration_url") ||
				challengeValues.get("registration_uri"),
			clientId: challengeValues.get("client_id") || clientIdFromAuthUrl(authorizationUrl),
			scopes: scope,
			explicitScopes: scope !== undefined,
			resource: challengeValues.get("resource") || challengeValues.get("resource_uri"),
		};
	}

	return null;
}

/**
 * Analyze an error to determine authentication requirements.
 * Returns structured info about what auth is needed.
 */
export function analyzeAuthError(error: Error, serverUrl?: string): AuthDetectionResult {
	// No auth required unless the error carries an HTTP auth status / auth-failure phrasing.
	if (!AIError.is(AIError.classify(error), AIError.Flag.AuthFailed)) {
		return { requiresAuth: false };
	}

	const authServerUrl = extractMcpAuthServerUrl(error, serverUrl);
	const challengeValues = readBearerParams(error);
	const resourceMetadataUrl = challengeResourceMetadata(challengeValues);
	const oauth = readOAuthEndpoints(error, challengeValues);
	const challengeScopes = challengeValues.get("scope") ?? challengeValues.get("scopes");

	if (oauth) {
		const mergedScopes = oauth.explicitScopes
			? mergeRequestedScopes(challengeScopes, oauth.scopes)
			: (challengeScopes ?? oauth.scopes);
		// Callers on the JSON-error-body path use `authResult.oauth` directly and
		// skip `discoverOAuthEndpoints`; without merging the challenge scope back
		// into the returned endpoints, `/mcp reauth` and `/mcp add` still mint a
		// scope-less grant when the challenge advertised `scope="…"`.
		const mergedOAuth: OAuthEndpoints = {
			...oauth,
			scopes: mergedScopes,
			explicitScopes: challengeScopes !== undefined || oauth.explicitScopes,
		};
		return {
			requiresAuth: true,
			authType: "oauth",
			oauth: mergedOAuth,
			authServerUrl,
			resourceMetadataUrl,
			scopes: mergedScopes,
			message: "Server requires OAuth authentication. Launching authorization flow...",
		};
	}

	// Check if it might be API key based
	const errorMsg = error.message.toLowerCase();
	if (
		errorMsg.includes("api key") ||
		errorMsg.includes("api_key") ||
		errorMsg.includes("token") ||
		errorMsg.includes("bearer")
	) {
		return {
			requiresAuth: true,
			authType: "apikey",
			authServerUrl,
			resourceMetadataUrl,
			scopes: challengeScopes,
			message: "Server requires API key authentication.",
		};
	}

	// Unknown auth type
	return {
		requiresAuth: true,
		authType: "unknown",
		authServerUrl,
		resourceMetadataUrl,
		scopes: challengeScopes,
		message: "Server requires authentication but type could not be determined.",
	};
}

/**
 * Normalize an OAuth issuer URL for RFC 8414 §3.3 comparison: lowercase
 * scheme/host (URL parser already does this), drop fragment/query, strip a
 * trailing slash on the path. The path is otherwise case-sensitive.
 */
function normalizeIssuerUrl(value: string): string | undefined {
	try {
		const u = new URL(value);
		const path = trimTrailingSlashes(u.pathname);
		return `${u.protocol}//${u.host}${path}`;
	} catch {
		// Not a URL, so it has no normal form to compare. Undefined means "cannot be compared", and the
		// only caller treats that as a failed comparison rather than a passing one.
		return undefined;
	}
}

/**
 * RFC 8414 §3.3: an authorization-server metadata document's `issuer` MUST
 * equal the URL the client used to construct the metadata URL. When a server
 * hosts metadata for several issuers under one origin (Plane serves a root
 * issuer `https://mcp.plane.so/` at `/.well-known/oauth-authorization-server`
 * *and* a path-scoped issuer `https://mcp.plane.so/http` at the path-prefixed
 * well-known URL), accepting the first hit silently routes the grant to the
 * wrong `/authorize` endpoint and produces opaque `server_error` redirects.
 *
 * Returns true when the metadata is safe to use:
 *   - the document has no `issuer` field (nonstandard / legacy servers — keep
 *     today's permissive behavior), or
 *   - the issuer matches `baseUrl` after trailing-slash normalization.
 *
 * An `issuer` that is present but is not a URL returns FALSE. It cannot be shown to match, and this
 * is a security control, so an unverifiable issuer is refused rather than waved through.
 */
function issuerMatchesBase(metadataIssuer: unknown, baseUrl: string): boolean {
	if (typeof metadataIssuer !== "string" || !metadataIssuer.trim()) {
		return true;
	}
	const normalizedIssuer = normalizeIssuerUrl(metadataIssuer);
	const normalizedBase = normalizeIssuerUrl(baseUrl);
	// An issuer that cannot be normalized cannot be shown to match, and this check exists to keep a
	// grant from being routed to an authorization server we did not verify. Accepting the document
	// because the comparison failed inverted the check exactly when it mattered: a document carrying a
	// junk `issuer` was trusted, while one carrying a mismatching valid issuer was rejected. Failing
	// here only skips this candidate document, so discovery moves on to the next well-known path.
	if (!normalizedIssuer || !normalizedBase) return false;
	return normalizedIssuer === normalizedBase;
}

function normalizeOAuthScopes(value: unknown): string | undefined {
	return (typeof value === "string" && value.trim()) || undefined;
}

/** Choose configured scopes, explicit requests, resource scopes, then authorization-server scopes. */
export function resolveOAuthScopes(
	configured: string | undefined,
	explicit: string | undefined,
	resource?: string,
	supported?: string,
): Pick<OAuthEndpoints, "scopes" | "explicitScopes"> {
	const requested = normalizeOAuthScopes(configured) ?? normalizeOAuthScopes(explicit);
	return {
		scopes: requested ?? normalizeOAuthScopes(resource) ?? normalizeOAuthScopes(supported),
		explicitScopes: requested !== undefined,
	};
}

function scopeFromAuthUrl(authorizationUrl: string): string | undefined {
	try {
		const params = new URL(authorizationUrl).searchParams;
		return normalizeOAuthScopes(params.get("scope")) ?? normalizeOAuthScopes(params.get("scopes"));
	} catch {
		// Endpoint validation owns invalid URLs.
		return undefined;
	}
}

/** Combine explicit requests only; supported sets must never widen a requested grant. */
function mergeRequestedScopes(challenge: string | undefined, provider: string | undefined): string | undefined {
	if (!challenge) return provider;
	if (!provider) return challenge;
	return [...new Set([...challenge.split(/\s+/), ...provider.split(/\s+/)].filter(Boolean))].join(" ");
}

function readExplicitScopes(metadata: Record<string, unknown>, authorizationUrl?: string): string | undefined {
	return (
		normalizeOAuthScopes(metadata.scope) ??
		normalizeOAuthScopes(metadata.scopes) ??
		(authorizationUrl ? scopeFromAuthUrl(authorizationUrl) : undefined)
	);
}

/**
 * Read space-separated OAuth scopes off a metadata document. Accepts either
 * an array (RFC 8414 `scopes_supported`) or a space-separated string
 * (`scopes` / `scope`), matching what MCP gateways emit under
 * `/.well-known/oauth-*`.
 */
function readMetadataScopes(metadata: Record<string, unknown>): string | undefined {
	const explicit = readExplicitScopes(metadata);
	if (explicit !== undefined) return explicit;
	if (Array.isArray(metadata.scopes_supported)) {
		const joined = metadata.scopes_supported
			.filter((scope): scope is string => normalizeOAuthScopes(scope) !== undefined)
			.join(" ");
		if (joined) return joined;
	}
	return undefined;
}

/**
 * Fetch the RFC 9728 protected-resource metadata document at
 * {@link resourceMetadataUrl} and return any scopes it advertises. Used by
 * `/mcp add` / `/mcp reauth` on the JSON-error-body path, where the caller
 * already holds usable OAuth endpoints but the required scopes live only in
 * the advertised protected-resource metadata — a case `discoverOAuthEndpoints`
 * normally handles but that path is skipped when the body carried endpoints.
 * Returns `undefined` on any error or when no scopes are advertised.
 */
export async function fetchResourceMetadataScopes(
	resourceMetadataUrl: string,
	opts?: { fetch?: FetchImpl },
): Promise<string | undefined> {
	const fetchImpl: FetchImpl = opts?.fetch ?? fetch;
	try {
		const resp = await fetchImpl(resourceMetadataUrl, {
			method: "GET",
			headers: { Accept: "application/json" },
			redirect: "follow",
			signal: AbortSignal.timeout(5_000),
		});
		if (!resp.ok) {
			logger.warn("Protected-resource scopes could not be fetched", {
				url: resourceMetadataUrl,
				status: resp.status,
			});
			return undefined;
		}
		const meta = (await resp.json()) as Record<string, unknown>;
		return readMetadataScopes(meta);
	} catch (error) {
		logger.warn("Protected-resource scopes could not be read", {
			url: resourceMetadataUrl,
			error: errorMessage(error),
		});
		return undefined;
	}
}

/**
 * Try to discover OAuth endpoints by querying the server's well-known endpoints.
 * This is a fallback when error responses don't include OAuth metadata.
 */
export async function discoverOAuthEndpoints(
	serverUrl: string,
	authServerUrl?: string,
	resourceMetadataUrl?: string,
	opts?: {
		fetch?: FetchImpl;
		protectedResource?: string;
		protectedScopes?: string;
		resourceScopes?: string;
		scopes?: string;
	},
): Promise<OAuthEndpoints | null> {
	const fetchImpl: FetchImpl = opts?.fetch ?? fetch;
	const wellKnownPaths = [
		"/.well-known/oauth-authorization-server",
		"/.well-known/openid-configuration",
		"/.well-known/oauth-protected-resource",
		"/oauth/metadata",
		"/.mcp/auth",
		"/authorize", // Some MCP servers expose OAuth config here
	];
	const urlsToQuery: Array<{ url: string; issuerCandidate: boolean }> = [];
	const visitedAuthServers = new Set<string>();

	let protectedResource = opts?.protectedResource;
	let protectedScopes = opts?.resourceScopes;
	const addDiscoveryBase = (url: string | undefined, issuerCandidate: boolean): void => {
		if (!url || visitedAuthServers.has(url)) return;
		urlsToQuery.push({ url, issuerCandidate });
		visitedAuthServers.add(url);
	};

	// Step 1: If a resource_metadata URL was provided, fetch it to discover auth servers.
	// This follows the RFC 9728 chain: resource_metadata → authorization_servers.
	if (resourceMetadataUrl && !visitedAuthServers.has(resourceMetadataUrl)) {
		visitedAuthServers.add(resourceMetadataUrl);
		try {
			const metaResp = await fetchImpl(resourceMetadataUrl, {
				method: "GET",
				headers: { Accept: "application/json" },
				redirect: "follow",
			});
			if (metaResp.ok) {
				const meta = (await metaResp.json()) as Record<string, unknown>;
				protectedScopes ??= readMetadataScopes(meta);
				if (typeof meta.resource === "string" && meta.resource.trim() !== "") {
					protectedResource = meta.resource;
				}
				const authServers = Array.isArray(meta.authorization_servers)
					? meta.authorization_servers.filter((entry): entry is string => typeof entry === "string")
					: [];
				for (const s of authServers) {
					addDiscoveryBase(s, true);
				}
			}
		} catch {
			// Ignore errors, continue to try explicit URLs
		}
	}

	// Step 2: Add explicit authServerUrl as an issuer candidate, then the resource server fallback.
	addDiscoveryBase(authServerUrl, true);
	addDiscoveryBase(serverUrl, false);

	const findEndpoints = (metadata: Record<string, unknown>): OAuthEndpoints | null => {
		if (metadata.authorization_endpoint && metadata.token_endpoint) {
			const resource = typeof metadata.resource === "string" ? metadata.resource : protectedResource;
			const requestedScopes = mergeRequestedScopes(
				opts?.protectedScopes,
				readExplicitScopes(metadata, String(metadata.authorization_endpoint)),
			);

			return {
				authorizationUrl: String(metadata.authorization_endpoint),
				tokenUrl: String(metadata.token_endpoint),
				registrationUrl: readRegistrationUrl(metadata),
				clientId:
					typeof metadata.client_id === "string"
						? metadata.client_id
						: typeof metadata.clientId === "string"
							? metadata.clientId
							: typeof metadata.default_client_id === "string"
								? metadata.default_client_id
								: typeof metadata.public_client_id === "string"
									? metadata.public_client_id
									: undefined,
				...resolveOAuthScopes(opts?.scopes, requestedScopes, protectedScopes, readMetadataScopes(metadata)),
				resource,
			};
		}

		if (metadata.oauth || metadata.authorization || metadata.auth) {
			const oauthData = (metadata.oauth || metadata.authorization || metadata.auth) as Record<string, unknown>;
			if (typeof oauthData.authorization_url === "string" && typeof oauthData.token_url === "string") {
				const resource = typeof oauthData.resource === "string" ? oauthData.resource : protectedResource;
				const requestedScopes = mergeRequestedScopes(
					opts?.protectedScopes,
					readExplicitScopes(oauthData, oauthData.authorization_url) ?? readExplicitScopes(metadata),
				);

				return {
					authorizationUrl: oauthData.authorization_url || String(oauthData.authorizationUrl),
					tokenUrl: oauthData.token_url || String(oauthData.tokenUrl),
					registrationUrl: readRegistrationUrl(oauthData),
					clientId:
						typeof oauthData.client_id === "string"
							? oauthData.client_id
							: typeof oauthData.clientId === "string"
								? oauthData.clientId
								: typeof oauthData.default_client_id === "string"
									? oauthData.default_client_id
									: typeof oauthData.public_client_id === "string"
										? oauthData.public_client_id
										: undefined,
					...resolveOAuthScopes(opts?.scopes, requestedScopes, protectedScopes, readMetadataScopes(oauthData)),
					resource,
				};
			}
		}

		return null;
	};

	for (const base of urlsToQuery) {
		for (const path of wellKnownPaths) {
			// Try each well-known path at both the absolute origin and relative
			const urlsToTry = buildWellKnownUrls(path, base.url);
			for (const url of urlsToTry) {
				try {
					const response = await fetchImpl(url.toString(), {
						method: "GET",
						headers: { Accept: "application/json" },
						redirect: "follow",
					});

					if (response.ok) {
						const metadata = (await response.json()) as Record<string, unknown>;
						// Authorization-server / OpenID Connect metadata documents carry an
						// `issuer` field that MUST equal the queried base URL only when that
						// URL came from an auth-server source (RFC 8414 §3.3, OIDC Discovery
						// §4.3). Resource-server fallback probes can legitimately return
						// cross-host issuer metadata.
						const requireIssuerMatch =
							base.issuerCandidate &&
							(path === "/.well-known/oauth-authorization-server" ||
								path === "/.well-known/openid-configuration");
						const issuerOk = requireIssuerMatch ? issuerMatchesBase(metadata.issuer, base.url) : true;
						const endpoints = issuerOk ? findEndpoints(metadata) : null;
						if (endpoints) return endpoints;

						if (path === "/.well-known/oauth-protected-resource") {
							const authServers = Array.isArray(metadata.authorization_servers)
								? metadata.authorization_servers.filter((entry): entry is string => typeof entry === "string")
								: [];

							const discoveredProtectedResource =
								typeof metadata.resource === "string" && metadata.resource.trim() !== ""
									? metadata.resource
									: protectedResource;

							for (const discoveredAuthServer of authServers) {
								if (visitedAuthServers.has(discoveredAuthServer)) {
									continue;
								}
								const discovered = await discoverOAuthEndpoints(serverUrl, discoveredAuthServer, undefined, {
									fetch: fetchImpl,
									protectedResource: discoveredProtectedResource,
									protectedScopes: opts?.protectedScopes,
									resourceScopes: protectedScopes ?? readMetadataScopes(metadata),
									scopes: opts?.scopes,
								});
								if (discovered) return discovered;
							}
						}
					}
				} catch {
					// Ignore errors, try next path
				}
			}
		}
	}

	return null;
}

function buildWellKnownUrls(wellKnownPath: string, baseUrl: string): URL[] {
	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		// No candidate URLs can be built from a base the URL parser rejects. The empty list is not a
		// "nothing to discover" answer: every caller treats zero candidates as a discovery failure and
		// reports it, so the operator sees the unusable server URL rather than a silent OAuth skip.
		return [];
	}

	const absUrl = new URL(wellKnownPath, parsed);
	if (!wellKnownPath.startsWith("/")) return [absUrl];

	const normalizedPath = parsed.pathname.replace(/\/$/, "");
	const lastSlash = normalizedPath.lastIndexOf("/");
	// Bare origin (no path beyond "/") — only the origin-root candidate applies.
	if (lastSlash < 0) return [absUrl];

	// Path-prefixed well-known (common for gateways with sub-path routing).
	// Multi-segment paths drop the trailing segment (typically the MCP endpoint);
	// single-segment paths (lastSlash === 0) are themselves the gateway prefix.
	const prefixPath = lastSlash === 0 ? normalizedPath : normalizedPath.slice(0, lastSlash);
	const relUrl = new URL(wellKnownPath.slice(1), `${parsed.origin}${prefixPath}/`);

	const candidates: URL[] = [absUrl];
	const seen = new Set<string>([absUrl.href]);
	const push = (u: URL): void => {
		if (!seen.has(u.href)) {
			candidates.push(u);
			seen.add(u.href);
		}
	};
	push(relUrl);

	// RFC 8414 §3.1 path-ful issuer form: /.well-known/<suffix>/<issuer-path>.
	// Only meaningful for well-known metadata documents.
	if (wellKnownPath.startsWith("/.well-known/")) {
		const pathfulUrl = new URL(`${wellKnownPath}${normalizedPath}`, parsed.origin);
		push(pathfulUrl);
	}

	return candidates;
}
