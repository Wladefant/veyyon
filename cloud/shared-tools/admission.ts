import type {
	AdmissionIdentity,
	AdmissionPolicy,
	DevicePolicy,
	SecretBinding,
	ToolScope,
	UserPolicy,
} from "./contracts";
import { isOpaqueId } from "./ids";

// Admission for shared tools. A caller proves two things on every request:
// the Cloudflare Access service token it holds (client id and client secret,
// matched to an enrolled device by SHA-256), and the application token Access
// signed for that token (RS256, checked against the team's JWKS). The enrolled
// device decides the user. Nothing the request says about its user is read,
// so a caller-supplied email or user header cannot change the answer.
//
// WHY identities are minted here and tracked in a WeakMap: a caller that could
// build its own AdmissionIdentity could name another user's device. Only an
// identity this module issued resolves a key, and the key lookup takes nothing
// but that identity, so no request input can select another user's binding.

export interface AdmissionConfig {
	readonly issuer: string;
	readonly audience: string;
	readonly secrets: readonly SecretBinding[];
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

export interface ResolvedKey {
	readonly apiKey: string;
	readonly costMicrousdPerRequest: number;
}

export interface Admission {
	authorize(request: Request, scope: ToolScope): Promise<AdmissionIdentity | null>;
	discover(request: Request): Promise<ToolScope[]>;
	resolveBraveKey(identity: AdmissionIdentity): Promise<ResolvedKey | null>;
}

// Satisfies makes a missing or extra scope a compile error, so the runtime list
// cannot drift from the contract's ToolScope union.
const TOOL_SCOPE_SET = { "fetch:public": true, "search:public": true } satisfies Record<ToolScope, true>;
const TOOL_SCOPES = Object.keys(TOOL_SCOPE_SET) as ToolScope[];

// Brave search is the only tool that takes a key, so its key is released under
// this scope. A user without it never resolves the key, even with a valid token.
const BRAVE_SCOPE: ToolScope = "search:public";

const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const ACCESS_HOST_SUFFIX = ".cloudflareaccess.com";
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFRESH_MS = 30_000;
const JWKS_DEADLINE_MS = 3_000;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_MAX_KEYS = 16;
const RSA_MIN_MODULUS_BYTES = 256;
const CLOCK_SKEW_MS = 60_000;
const MAX_TOKEN_CHARS = 8_192;
const MAX_CLIENT_ID_CHARS = 128;
const MAX_CLIENT_SECRET_CHARS = 512;
const MAX_ID_CHARS = 128;
const MAX_KID_CHARS = 128;
const MAX_AUDIENCE_CHARS = 256;
const MAX_SECRET_VALUE_CHARS = 4_096;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const RSA_VERIFY = { name: "RSASSA-PKCS1-v1_5" } as const;
const RSA_IMPORT = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

interface Enrollment {
	readonly deviceId: string;
	readonly userId: string;
	readonly clientId: string;
	readonly secretSha256: string;
}

interface PolicyIndex {
	readonly policy: AdmissionPolicy;
	readonly users: ReadonlyMap<string, UserPolicy>;
	readonly devicesById: ReadonlyMap<string, DevicePolicy>;
	readonly devicesByClientId: ReadonlyMap<string, DevicePolicy>;
}

interface Admitted {
	readonly index: PolicyIndex;
	readonly device: DevicePolicy;
	readonly user: UserPolicy;
}

interface ParsedJwt {
	readonly kid: string;
	readonly claims: Record<string, unknown>;
	readonly signingInput: Uint8Array<ArrayBuffer>;
	readonly signature: Uint8Array<ArrayBuffer>;
}

interface KeySet {
	readonly fetchedAt: number;
	readonly keys: ReadonlyMap<string, CryptoKey>;
}

export function createAdmission(policy: AdmissionPolicy, config: AdmissionConfig): Admission {
	const issuer = parseIssuer(config.issuer);
	if (!isNonEmptyString(config.audience, MAX_AUDIENCE_CHARS)) {
		throw new Error("admission audience is malformed");
	}
	const audience = config.audience;
	indexPolicy(policy);
	// Validated at construction, so a malformed binding set fails here. Each resolution re-indexes it.
	indexSecrets(config.secrets);
	const fetchImpl = config.fetch ?? fetch;
	const now = config.now ?? Date.now;
	const keyFor = createKeySource(new URL(ACCESS_CERTS_PATH, issuer).href, fetchImpl);
	const enrollments = new WeakMap<AdmissionIdentity, Enrollment>();

	// The policy can change while the key is fetched and the signature checked. Re-read it, and admit
	// only the device this request proved, still enrolled unchanged and still live. The device returned
	// is the live entry, never the copy read before the awaits.
	const confirmEnrollment = (proven: Enrollment, at: number): Admitted | null => {
		const index = indexPolicy(policy);
		if (!index.policy.enabled) return null;
		const device = index.devicesById.get(proven.deviceId);
		if (
			device === undefined ||
			device.userId !== proven.userId ||
			device.clientId !== proven.clientId ||
			!constantTimeEqual(device.secretSha256, proven.secretSha256)
		) {
			return null;
		}
		const user = usableUser(index, device, at);
		return user === null ? null : { index, device, user };
	};

	// Every call re-indexes the live policy, so an edit made after construction
	// takes effect on the next request. A malformed edit refuses, it never admits.
	const admit = async (request: Request): Promise<Enrollment | null> => {
		try {
			const at = now();
			const index = indexPolicy(policy);
			if (!index.policy.enabled) return null;
			const clientId = request.headers.get("cf-access-client-id");
			const clientSecret = request.headers.get("cf-access-client-secret");
			const token = request.headers.get("cf-access-jwt-assertion");
			if (clientId === null || clientSecret === null || token === null) return null;
			if (
				!isNonEmptyString(clientId, MAX_CLIENT_ID_CHARS) ||
				!isNonEmptyString(clientSecret, MAX_CLIENT_SECRET_CHARS) ||
				token.length > MAX_TOKEN_CHARS
			) {
				return null;
			}
			const jwt = parseJwt(token);
			if (jwt === null || !claimsAccepted(jwt.claims, issuer, audience, at)) return null;
			if (jwt.claims.common_name !== clientId) return null;
			const device = index.devicesByClientId.get(clientId);
			if (device === undefined) return null;
			const user = usableUser(index, device, at);
			if (user === null) return null;
			// Snapshot scalar enrollment fields before hashing or fetching keys can yield to policy edits.
			const proven: Enrollment = {
				deviceId: device.deviceId,
				userId: device.userId,
				clientId: device.clientId,
				secretSha256: device.secretSha256,
			};
			if (!constantTimeEqual(await sha256Hex(clientSecret), proven.secretSha256)) return null;
			const key = await keyFor(jwt.kid, at);
			if (key === null) return null;
			const valid = await crypto.subtle.verify(RSA_VERIFY, key, jwt.signature, jwt.signingInput);
			return valid && confirmEnrollment(proven, now()) !== null ? proven : null;
		} catch {
			return null;
		}
	};

	const mint = (device: DevicePolicy): AdmissionIdentity => {
		const identity: AdmissionIdentity = Object.freeze({ userId: device.userId, deviceId: device.deviceId });
		enrollments.set(identity, {
			deviceId: device.deviceId,
			userId: device.userId,
			clientId: device.clientId,
			secretSha256: device.secretSha256,
		});
		return identity;
	};

	const authorize = async (request: Request, scope: ToolScope): Promise<AdmissionIdentity | null> => {
		if (!isToolScope(scope)) return null;
		const proven = await admit(request);
		try {
			// Confirm after the outer await; no live policy reference crosses that boundary.
			const admitted = proven === null ? null : confirmEnrollment(proven, now());
			if (admitted === null || !grantedScopes(admitted.index.policy, admitted.user).includes(scope)) {
				return null;
			}
			return mint(admitted.device);
		} catch {
			return null;
		}
	};

	const discover = async (request: Request): Promise<ToolScope[]> => {
		const proven = await admit(request);
		try {
			const admitted = proven === null ? null : confirmEnrollment(proven, now());
			return admitted === null ? [] : grantedScopes(admitted.index.policy, admitted.user);
		} catch {
			return [];
		}
	};

	// Revalidates everything an admission depended on, because a key can outlive
	// the admission that minted its identity: device rotation, device revocation,
	// expiry, user disable, global kill switch and secret-hash drift all refuse here.
	const resolveBraveKey = async (identity: AdmissionIdentity): Promise<ResolvedKey | null> => {
		try {
			const enrollment = enrollments.get(identity);
			if (enrollment === undefined) return null;
			const admitted = confirmEnrollment(enrollment, now());
			if (admitted === null || !grantedScopes(admitted.index.policy, admitted.user).includes(BRAVE_SCOPE)) {
				return null;
			}
			// Re-indexed on every resolution, so a binding replaced or removed after construction takes effect here.
			const binding = indexSecrets(config.secrets).get(admitted.user.userId);
			if (binding === undefined) return null;
			const { value, sha256, costMicrousdPerRequest } = binding;
			if (!constantTimeEqual(await sha256Hex(value), sha256)) return null;
			const current = confirmEnrollment(enrollment, now());
			if (current === null || !grantedScopes(current.index.policy, current.user).includes(BRAVE_SCOPE)) return null;
			const currentBinding = indexSecrets(config.secrets).get(current.user.userId);
			if (!currentBinding || currentBinding.value !== value || currentBinding.sha256 !== sha256 || currentBinding.costMicrousdPerRequest !== costMicrousdPerRequest) return null;
			return { apiKey: value, costMicrousdPerRequest };
		} catch {
			return null;
		}
	};

	return Object.freeze({ authorize, discover, resolveBraveKey });
}

function parseIssuer(issuer: string): string {
	let url: URL;
	try {
		url = new URL(issuer);
	} catch {
		throw new Error("admission issuer is not a URL");
	}
	if (url.protocol !== "https:" || !url.hostname.endsWith(ACCESS_HOST_SUFFIX) || url.origin !== issuer) {
		throw new Error("admission issuer must be the https Cloudflare Access team origin");
	}
	return url.origin;
}

function indexPolicy(policy: AdmissionPolicy): PolicyIndex {
	if (
		!isRecord(policy) ||
		typeof policy.enabled !== "boolean" ||
		!Array.isArray(policy.users) ||
		!Array.isArray(policy.devices) ||
		!isRecord(policy.tools)
	) {
		throw new Error("admission policy is malformed");
	}
	for (const scope of TOOL_SCOPES) {
		if (typeof policy.tools[scope] !== "boolean") throw new Error("admission policy tool switch is malformed");
	}
	const users = new Map<string, UserPolicy>();
	for (const user of policy.users) {
		if (
			!isOpaqueId(user.userId) ||
			typeof user.enabled !== "boolean" ||
			!isScopeList(user.scopes)
		) {
			throw new Error("admission policy user is malformed");
		}
		if (users.has(user.userId)) throw new Error("admission policy repeats a user");
		users.set(user.userId, user);
	}
	const devicesById = new Map<string, DevicePolicy>();
	const devicesByClientId = new Map<string, DevicePolicy>();
	for (const device of policy.devices) {
		if (
			!isNonEmptyString(device.deviceId, MAX_ID_CHARS) ||
			!isOpaqueId(device.userId) ||
			!isNonEmptyString(device.clientId, MAX_CLIENT_ID_CHARS) ||
			!isSha256Hex(device.secretSha256) ||
			typeof device.enabled !== "boolean" ||
			!isFiniteNumber(device.expiresAt)
		) {
			throw new Error("admission policy device is malformed");
		}
		if (!users.has(device.userId)) throw new Error("admission policy device names an unknown user");
		if (devicesById.has(device.deviceId) || devicesByClientId.has(device.clientId)) {
			throw new Error("admission policy repeats a device");
		}
		devicesById.set(device.deviceId, device);
		devicesByClientId.set(device.clientId, device);
	}
	return { policy, users, devicesById, devicesByClientId };
}

function indexSecrets(secrets: readonly SecretBinding[]): ReadonlyMap<string, SecretBinding> {
	if (!Array.isArray(secrets)) throw new Error("admission secrets are malformed");
	const byUser = new Map<string, SecretBinding>();
	for (const binding of secrets) {
		if (
			!isOpaqueId(binding.userId) ||
			!isNonEmptyString(binding.value, MAX_SECRET_VALUE_CHARS) ||
			!isSha256Hex(binding.sha256) ||
			!Number.isSafeInteger(binding.costMicrousdPerRequest) ||
			binding.costMicrousdPerRequest < 0
		) {
			throw new Error("admission secret binding is malformed");
		}
		if (byUser.has(binding.userId)) throw new Error("admission secret bindings repeat a user");
		byUser.set(binding.userId, Object.freeze({ ...binding }));
	}
	return byUser;
}

function usableUser(index: PolicyIndex, device: DevicePolicy, at: number): UserPolicy | null {
	if (!device.enabled || at >= device.expiresAt) return null;
	const user = index.users.get(device.userId);
	return user !== undefined && user.enabled ? user : null;
}

function grantedScopes(policy: AdmissionPolicy, user: UserPolicy): ToolScope[] {
	return TOOL_SCOPES.filter((scope) => policy.tools[scope] && user.scopes.includes(scope));
}

function parseJwt(token: string): ParsedJwt | null {
	const parts = token.split(".");
	const [headerPart, payloadPart, signaturePart] = parts;
	if (parts.length !== 3 || headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
		return null;
	}
	const header = decodeJsonSegment(headerPart);
	const claims = decodeJsonSegment(payloadPart);
	if (header === null || claims === null || header.alg !== "RS256" || !isNonEmptyString(header.kid, MAX_KID_CHARS)) {
		return null;
	}
	return {
		kid: header.kid,
		claims,
		signingInput: new TextEncoder().encode(`${headerPart}.${payloadPart}`),
		signature: base64UrlToBytes(signaturePart),
	};
}

// Access service-token application tokens: type "app", an empty sub, and the
// Client ID in common_name. Identity tokens carry a non-empty sub and are refused.
function claimsAccepted(claims: Record<string, unknown>, issuer: string, audience: string, at: number): boolean {
	if (claims.iss !== issuer) return false;
	const aud = claims.aud;
	if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) return false;
	if (claims.type !== "app") return false;
	if (claims.sub !== "") return false;
	if (!isNonEmptyString(claims.common_name, MAX_CLIENT_ID_CHARS)) return false;
	if (!isFiniteNumber(claims.exp) || at >= claims.exp * 1000) return false;
	if (!isFiniteNumber(claims.iat) || claims.iat * 1000 > at + CLOCK_SKEW_MS) return false;
	if (claims.nbf !== undefined && (!isFiniteNumber(claims.nbf) || claims.nbf * 1000 > at + CLOCK_SKEW_MS)) {
		return false;
	}
	return true;
}

function createKeySource(jwksUrl: string, fetchImpl: typeof fetch): (kid: string, at: number) => Promise<CryptoKey | null> {
	let current: KeySet | null = null;
	let lastAttempt = Number.NEGATIVE_INFINITY;
	let inflight: Promise<void> | null = null;

	// A failed refresh keeps the previous set. Attempts are spaced by a fixed window,
	// so a stream of forged kids costs at most one upstream fetch per window.
	const refresh = (at: number): Promise<void> => {
		if (inflight !== null) return inflight;
		if (at - lastAttempt < JWKS_MIN_REFRESH_MS) return Promise.resolve();
		lastAttempt = at;
		inflight = fetchKeys(jwksUrl, fetchImpl)
			.then(
				(keys) => {
					current = { fetchedAt: at, keys };
				},
				() => undefined,
			)
			.finally(() => {
				inflight = null;
			});
		return inflight;
	};

	// Only a set inside its TTL admits a key. When a refresh fails after the TTL, no set is usable and the
	// request is refused, rather than served from keys past their window.
	return async (kid, at) => {
		if (current === null || at - current.fetchedAt >= JWKS_TTL_MS || !current.keys.has(kid)) {
			await refresh(at);
		}
		if (current === null || at - current.fetchedAt >= JWKS_TTL_MS) return null;
		return current.keys.get(kid) ?? null;
	};
}

// The deadline is enforced here, not by the fetch signal: a fetch that ignores its signal must not hold
// admission open. The race also covers the body read and the key import, so one bound applies to the load.
async function fetchKeys(jwksUrl: string, fetchImpl: typeof fetch): Promise<ReadonlyMap<string, CryptoKey>> {
	const controller = new AbortController();
	const expired = Promise.withResolvers<never>();
	const deadline = setTimeout(() => {
		controller.abort();
		expired.reject(new Error("jwks deadline exceeded"));
	}, JWKS_DEADLINE_MS);
	const load = loadKeys(jwksUrl, fetchImpl, controller.signal);
	// A load abandoned at the deadline may still settle later. Its outcome is discarded, never installed.
	load.catch(() => undefined);
	try {
		return await Promise.race([load, expired.promise]);
	} finally {
		clearTimeout(deadline);
		controller.abort();
	}
}

async function loadKeys(
	jwksUrl: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<ReadonlyMap<string, CryptoKey>> {
	// redirect: "error" keeps the JWKS on the configured issuer; a redirect is a refusal.
	const response = await fetchImpl(jwksUrl, { redirect: "error", signal });
	if (response.status !== 200) throw new Error("jwks status refused");
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) > JWKS_MAX_BYTES) throw new Error("jwks body too large");
	const body: unknown = JSON.parse(await readBounded(response, JWKS_MAX_BYTES));
	return await importJwks(body);
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error("jwks body too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

async function importJwks(body: unknown): Promise<ReadonlyMap<string, CryptoKey>> {
	if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length > JWKS_MAX_KEYS) {
		throw new Error("jwks malformed");
	}
	const candidates: { kid: string; n: string; e: string }[] = [];
	for (const entry of body.keys) {
		if (
			!isRecord(entry) ||
			entry.kty !== "RSA" ||
			entry.alg !== "RS256" ||
			(entry.use !== undefined && entry.use !== "sig") ||
			!isNonEmptyString(entry.kid, MAX_KID_CHARS) ||
			typeof entry.n !== "string" ||
			typeof entry.e !== "string"
		) {
			continue;
		}
		candidates.push({ kid: entry.kid, n: entry.n, e: entry.e });
	}
	// A kid that appears twice is ambiguous, so neither copy is trusted.
	const counts = new Map<string, number>();
	for (const candidate of candidates) counts.set(candidate.kid, (counts.get(candidate.kid) ?? 0) + 1);
	const keys = new Map<string, CryptoKey>();
	for (const candidate of candidates) {
		if (counts.get(candidate.kid) !== 1) continue;
		const key = await importRsaKey(candidate.n, candidate.e);
		if (key !== null) keys.set(candidate.kid, key);
	}
	return keys;
}

async function importRsaKey(n: string, e: string): Promise<CryptoKey | null> {
	try {
		const modulus = base64UrlToBytes(n);
		let start = 0;
		while (start < modulus.length && modulus[start] === 0) start++;
		if (modulus.length - start < RSA_MIN_MODULUS_BYTES) return null;
		return await crypto.subtle.importKey("jwk", { kty: "RSA", n, e, alg: "RS256", ext: true }, RSA_IMPORT, false, [
			"verify",
		]);
	} catch {
		return null;
	}
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
	const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
	return isRecord(value) ? value : null;
}

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
	if (!BASE64URL.test(input) || input.length % 4 === 1) throw new Error("base64url malformed");
	const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	let hex = "";
	for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return difference === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maxChars;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && HEX_SHA256.test(value);
}

function isToolScope(value: unknown): value is ToolScope {
	return typeof value === "string" && (TOOL_SCOPES as readonly string[]).includes(value);
}

function isScopeList(value: unknown): value is ToolScope[] {
	return Array.isArray(value) && value.every(isToolScope) && new Set(value).size === value.length;
}
