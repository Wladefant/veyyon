/**
 * OpenCode Go account endpoints, and the API-key envelope that carries a Console login's organization
 * and inference endpoint from the credential store to the request.
 *
 * An OpenCode Go API key is sent to the public gateway (`https://opencode.ai/zen/go`). A Console login
 * token is rejected there: it is accepted only by the inference endpoint the Console names for the
 * organization that holds the subscription, together with that organization's id in
 * {@link OPENCODE_GO_ORG_HEADER}. A login credential's API key is the JSON envelope
 * `{ token, apiEndpoint, orgId }`; an API key is sent unchanged.
 *
 * The Console names the endpoint of the OpenAI-compatible route (`<root>/openai/v1`). The same account
 * root serves the Anthropic-compatible route at `<root>/anthropic`.
 */
import { trimTrailingSlashes } from "@veyyon/utils/url";

/** Request header that names the organization a Console login token is scoped to. */
export const OPENCODE_GO_ORG_HEADER = "x-opencode-org-id";

const OPENAI_ROUTE = "/openai/v1";
const ANTHROPIC_ROUTE = "/anthropic";

/** The public gateway bases the bundled catalog writes into Go models, as the completions and messages wires spell them. */
const PUBLIC_GATEWAY_BASES: ReadonlySet<string> = new Set([
	"https://opencode.ai/zen/go",
	"https://opencode.ai/zen/go/v1",
]);

/**
 * The account root of an inference endpoint the Console names (`<root>/openai/v1`), or `undefined` for an
 * endpoint that is not HTTPS or does not end in the OpenAI-compatible route.
 */
export function opencodeGoAccountRoot(apiEndpoint: string): string | undefined {
	let url: URL;
	try {
		url = new URL(apiEndpoint.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") return undefined;
	const path = trimTrailingSlashes(url.pathname);
	if (!path.endsWith(OPENAI_ROUTE)) return undefined;
	return `${url.origin}${path.slice(0, -OPENAI_ROUTE.length)}`;
}

/**
 * The API key of an OpenCode Go credential: the envelope when the login stored an endpoint the request
 * can route and an organization, the bare token otherwise.
 */
export function opencodeGoApiKey(token: string, apiEndpoint: string | undefined, orgId: string | undefined): string {
	if (apiEndpoint === undefined || !orgId || opencodeGoAccountRoot(apiEndpoint) === undefined) return token;
	return JSON.stringify({ token, apiEndpoint, orgId });
}

export interface OpenCodeGoAccount {
	/** The account root, without the route suffix. */
	readonly root: string;
	/** Organization the token is scoped to, sent in {@link OPENCODE_GO_ORG_HEADER}. */
	readonly orgId: string;
}

export interface ParsedOpenCodeGoApiKey {
	/** The bearer token. */
	readonly token: string;
	/** The account a login token belongs to, or `undefined` for an API key. */
	readonly account: OpenCodeGoAccount | undefined;
}

/** Read an API key written by {@link opencodeGoApiKey}. A plain key, such as `OPENCODE_API_KEY`, names no account. */
export function parseOpenCodeGoApiKey(apiKey: string): ParsedOpenCodeGoApiKey {
	if (apiKey.startsWith("{")) {
		let parsed: { token?: unknown; apiEndpoint?: unknown; orgId?: unknown } | null;
		try {
			parsed = JSON.parse(apiKey);
		} catch {
			// Text that only looks like JSON is not an envelope; it is sent as the token, as a plain key is.
			parsed = null;
		}
		if (typeof parsed?.token === "string") {
			const root = typeof parsed.apiEndpoint === "string" ? opencodeGoAccountRoot(parsed.apiEndpoint) : undefined;
			const orgId = typeof parsed.orgId === "string" && parsed.orgId.length > 0 ? parsed.orgId : undefined;
			return {
				token: parsed.token,
				account: root !== undefined && orgId !== undefined ? { root, orgId } : undefined,
			};
		}
	}
	return { token: apiKey, account: undefined };
}

/** Whether `apiKey` carries a Console login rather than an API key. */
export function isOpenCodeGoLoginApiKey(apiKey: string | undefined): boolean {
	return apiKey !== undefined && parseOpenCodeGoApiKey(apiKey).account !== undefined;
}

/** The wire a request speaks: the OpenAI-compatible routes (completions, responses) or the Anthropic messages route. */
export type OpenCodeGoWire = "openai" | "anthropic";

export interface OpenCodeGoEndpoint {
	/** The bearer token. */
	readonly apiKey: string;
	/** API base the request goes to; for `anthropic`, without the `/v1/messages` the Anthropic SDK appends. */
	readonly baseUrl: string | undefined;
	/** Organization to send in {@link OPENCODE_GO_ORG_HEADER}, or `undefined` for an API key. */
	readonly orgId: string | undefined;
}

/**
 * The token, API base and organization an OpenCode Go request uses. An API key keeps the configured
 * base. A login replaces the public gateway base with its account's route for `wire`; a custom base,
 * such as a proxy, is kept, and the organization is sent to it either way.
 */
export function resolveOpenCodeGoEndpoint(
	apiKey: string,
	baseUrl: string | undefined,
	wire: OpenCodeGoWire,
): OpenCodeGoEndpoint {
	const { token, account } = parseOpenCodeGoApiKey(apiKey);
	if (account === undefined) return { apiKey: token, baseUrl, orgId: undefined };
	const configured = baseUrl?.trim();
	const isPublicGateway = !configured || PUBLIC_GATEWAY_BASES.has(trimTrailingSlashes(configured).toLowerCase());
	return {
		apiKey: token,
		baseUrl: isPublicGateway ? `${account.root}${wire === "openai" ? OPENAI_ROUTE : ANTHROPIC_ROUTE}` : baseUrl,
		orgId: account.orgId,
	};
}
