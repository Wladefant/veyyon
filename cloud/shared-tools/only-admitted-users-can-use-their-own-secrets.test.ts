import { afterEach, beforeAll, describe, expect, spyOn, test, vi } from "bun:test";
import { type Admission, createAdmission } from "./admission";
import type {
	AdmissionIdentity,
	AdmissionPolicy,
	DevicePolicy,
	SecretBinding,
	ToolScope,
	UserPolicy,
} from "./contracts";

// WHY: the shared-tools key release is the only place a user's secret leaves the
// runtime. These tests mint real RS256 Access tokens, serve the JWKS from a fake
// network, and check that a request can only ever reach its own enrolled device's
// key. They close the class "a request names or forges an identity and reads
// another user's binding". They do not cover Access itself, the Cloudflare
// dashboard or the Bitwarden copy that produced the bindings.

const DAY = 86_400_000;
const ISSUER = "https://team.cloudflareaccess.com";
const AUDIENCE = "aud-tag-shared-tools";
const CERTS_URL = "https://team.cloudflareaccess.com/cdn-cgi/access/certs";
const NOW = 1_800_000_000_000;
const CLIENT_A = "aaaa1111aaaa1111aaaa1111aaaa1111.access";
const CLIENT_B = "bbbb2222bbbb2222bbbb2222bbbb2222.access";
const SECRET_A = "client-secret-a-enrolled";
const SECRET_B = "client-secret-b-enrolled";
const BRAVE_A = "brave-key-user-a";
const BRAVE_B = "brave-key-user-b";
const JWKS_MAX_BYTES = 64 * 1024;

interface Signer {
	kid: string;
	privateKey: CryptoKey;
	publicJwk: JsonWebKey;
}

interface NetworkState {
	keys: JsonWebKey[];
	status: number;
	body: string | null;
	hang: boolean;
	// With `hang` and `ignoreSignal`, the fetch never honours its abort signal and answers only through `stalled`.
	ignoreSignal: boolean;
	stalled: PromiseWithResolvers<Response>;
	// Runs when the JWKS fetch starts, which is after the device check and before the signature check.
	onRequest: (() => void) | null;
	calls: { url: string; redirect: RequestRedirect | undefined }[];
}

interface FakeNetwork {
	state: NetworkState;
	fetch: typeof fetch;
}

interface Fixture {
	policy: AdmissionPolicy;
	userA: UserPolicy;
	userB: UserPolicy;
	deviceA: DevicePolicy;
	deviceB: DevicePolicy;
	secretA: SecretBinding;
	secretB: SecretBinding;
	secrets: SecretBinding[];
}

interface Harness extends Fixture {
	net: FakeNetwork;
	clock: { now: number };
	admission: Admission;
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function segment(value: unknown): string {
	return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function makeSigner(kid: string): Promise<Signer> {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	return { kid, privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

// Compact JWT signed the way Access signs one. Pass `undefined` for a claim to omit it.
async function signJwt(signer: Signer, claims: Record<string, unknown>): Promise<string> {
	const header = segment({ alg: "RS256", kid: signer.kid, typ: "JWT" });
	const payload = segment(claims);
	const signature = await crypto.subtle.sign(
		{ name: "RSASSA-PKCS1-v1_5" },
		signer.privateKey,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function claimsFor(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "app",
		aud: [AUDIENCE],
		iss: ISSUER,
		common_name: CLIENT_A,
		sub: "",
		iat: NOW / 1000 - 10,
		exp: NOW / 1000 + 300,
		...overrides,
	};
}

function accessHeaders(token: string, clientId: string, secret: string): Record<string, string> {
	return {
		"cf-access-jwt-assertion": token,
		"cf-access-client-id": clientId,
		"cf-access-client-secret": secret,
	};
}

function requestWith(headers: Record<string, string>): Request {
	return new Request("https://tools.example.test/mcp", { headers });
}

function fakeNetwork(keys: JsonWebKey[]): FakeNetwork {
	const state: NetworkState = {
		keys,
		status: 200,
		body: null,
		hang: false,
		ignoreSignal: false,
		stalled: Promise.withResolvers<Response>(),
		onRequest: null,
		calls: [],
	};
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		state.calls.push({ url: String(input), redirect: init?.redirect });
		state.onRequest?.();
		if (state.hang) {
			if (state.ignoreSignal) return state.stalled.promise;
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		}
		const body = state.body ?? JSON.stringify({ keys: state.keys });
		return new Response(body, { status: state.status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { state, fetch: fetchImpl };
}

async function fixture(): Promise<Fixture> {
	const userA: UserPolicy = { userId: "user-a", enabled: true, scopes: ["fetch:public", "search:public"] };
	const userB: UserPolicy = { userId: "user-b", enabled: true, scopes: ["fetch:public", "search:public"] };
	const deviceA: DevicePolicy = {
		deviceId: "dev-a",
		userId: "user-a",
		clientId: CLIENT_A,
		secretSha256: await sha256Hex(SECRET_A),
		enabled: true,
		expiresAt: NOW + DAY,
	};
	const deviceB: DevicePolicy = {
		deviceId: "dev-b",
		userId: "user-b",
		clientId: CLIENT_B,
		secretSha256: await sha256Hex(SECRET_B),
		enabled: true,
		expiresAt: NOW + DAY,
	};
	const policy: AdmissionPolicy = {
		enabled: true,
		users: [userA, userB],
		devices: [deviceA, deviceB],
		tools: { "fetch:public": true, "search:public": true },
	};
	const secretA: SecretBinding = {
		userId: "user-a",
		value: BRAVE_A,
		sha256: await sha256Hex(BRAVE_A),
		costMicrousdPerRequest: 1500,
	};
	const secretB: SecretBinding = {
		userId: "user-b",
		value: BRAVE_B,
		sha256: await sha256Hex(BRAVE_B),
		costMicrousdPerRequest: 2500,
	};
	return { policy, userA, userB, deviceA, deviceB, secretA, secretB, secrets: [secretA, secretB] };
}

async function start(signer: Signer, fx?: Fixture): Promise<Harness> {
	const base = fx ?? (await fixture());
	const net = fakeNetwork([signer.publicJwk]);
	const clock = { now: NOW };
	const admission = createAdmission(base.policy, {
		issuer: ISSUER,
		audience: AUDIENCE,
		secrets: base.secrets,
		fetch: net.fetch,
		now: () => clock.now,
	});
	return { ...base, net, clock, admission };
}

async function admitted(
	h: Harness,
	token: string,
	clientId: string,
	secret: string,
	scope: ToolScope = "search:public",
): Promise<AdmissionIdentity> {
	const identity = await h.admission.authorize(requestWith(accessHeaders(token, clientId, secret)), scope);
	if (identity === null) throw new Error("expected admission");
	return identity;
}

describe("only admitted users can use their own secrets", () => {
	let signer: Signer;
	let rogue: Signer;

	beforeAll(async () => {
		signer = await makeSigner("kid-1");
		rogue = await makeSigner("kid-rogue");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("a valid service token for an enrolled device resolves exactly that user's key", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		expect(identity).toEqual({ userId: "user-a", deviceId: "dev-a" });
		expect(await h.admission.resolveBraveKey(identity)).toEqual({ apiKey: BRAVE_A, costMicrousdPerRequest: 1500 });
	});

	test("user A cannot read user B's key by forging, editing or copying an identity", async () => {
		const h = await start(signer);
		const tokenA = await signJwt(signer, claimsFor({}));
		const identityA = await admitted(h, tokenA, CLIENT_A, SECRET_A);
		const forged = { userId: "user-b", deviceId: "dev-b" };
		const edited = { ...identityA, userId: "user-b", deviceId: "dev-b" };
		expect(await h.admission.resolveBraveKey(forged)).toBeNull();
		expect(await h.admission.resolveBraveKey(edited)).toBeNull();
		expect(await h.admission.resolveBraveKey({ ...identityA })).toBeNull();
		const resolvedA = await h.admission.resolveBraveKey(identityA);
		expect(resolvedA?.apiKey).toBe(BRAVE_A);
	});

	test("user B's own token resolves B's key, never A's", async () => {
		const h = await start(signer);
		const tokenB = await signJwt(signer, claimsFor({ common_name: CLIENT_B }));
		const identityB = await admitted(h, tokenB, CLIENT_B, SECRET_B);
		expect(identityB).toEqual({ userId: "user-b", deviceId: "dev-b" });
		expect((await h.admission.resolveBraveKey(identityB))?.apiKey).toBe(BRAVE_B);
	});

	test("a client id paired with another device's secret is refused", async () => {
		const h = await start(signer);
		const tokenA = await signJwt(signer, claimsFor({}));
		expect(await h.admission.authorize(requestWith(accessHeaders(tokenA, CLIENT_A, SECRET_B)), "search:public")).toBeNull();
	});

	test("caller-supplied email and user headers do not change the admitted user", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const headers = {
			...accessHeaders(token, CLIENT_A, SECRET_A),
			"cf-access-authenticated-user-email": "user-b@example.test",
			"x-user-id": "user-b",
		};
		const identity = await h.admission.authorize(requestWith(headers), "search:public");
		expect(identity?.userId).toBe("user-a");
	});

	test("a disabled user is refused for every scope, and an identity already issued stops resolving", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		h.userA.enabled = false;
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "fetch:public")).toBeNull();
		expect(await h.admission.discover(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)))).toEqual([]);
		expect(await h.admission.resolveBraveKey(identity)).toBeNull();
	});

	test("discovery and authorization follow the user's scopes and the tool switches together", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const headers = accessHeaders(token, CLIENT_A, SECRET_A);
		h.userA.scopes = ["fetch:public"];
		expect(await h.admission.discover(requestWith(headers))).toEqual(["fetch:public"]);
		expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
		expect(await h.admission.authorize(requestWith(headers), "fetch:public")).not.toBeNull();
		h.policy.tools["fetch:public"] = false;
		expect(await h.admission.discover(requestWith(headers))).toEqual([]);
		expect(await h.admission.authorize(requestWith(headers), "fetch:public")).toBeNull();
	});

	test("the global kill switch refuses admission and resolution, including for an identity already issued", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		h.policy.enabled = false;
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		expect(await h.admission.discover(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)))).toEqual([]);
		expect(await h.admission.resolveBraveKey(identity)).toBeNull();
	});

	test("a revoked device is refused at the next request and its issued identity stops resolving", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		h.deviceA.enabled = false;
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		expect(await h.admission.resolveBraveKey(identity)).toBeNull();
	});

	test("device expiry is read at each call's clock, so the boundary instant refuses", async () => {
		const h = await start(signer);
		h.deviceA.expiresAt = NOW + 1000;
		const token = await signJwt(signer, claimsFor({}));
		const headers = accessHeaders(token, CLIENT_A, SECRET_A);
		h.clock.now = NOW + 999;
		expect(await h.admission.authorize(requestWith(headers), "search:public")).not.toBeNull();
		h.clock.now = NOW + 1000;
		expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
	});

	test("rotating a device secret stops the old secret admitting and the old identity resolving", async () => {
		const h = await start(signer);
		const oldToken = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, oldToken, CLIENT_A, SECRET_A);
		h.deviceA.secretSha256 = await sha256Hex("client-secret-a-rotated");
		expect(await h.admission.authorize(requestWith(accessHeaders(oldToken, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		expect(await h.admission.resolveBraveKey(identity)).toBeNull();
		const rotated = await admitted(h, oldToken, CLIENT_A, "client-secret-a-rotated");
		expect((await h.admission.resolveBraveKey(rotated))?.apiKey).toBe(BRAVE_A);
	});

	test("a wrong client secret for a valid token and enrolled client id is refused", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, "not-the-secret")), "search:public")).toBeNull();
	});

	test("a token whose common_name differs from the presented client id is refused", async () => {
		const h = await start(signer);
		const tokenB = await signJwt(signer, claimsFor({ common_name: CLIENT_B }));
		expect(await h.admission.authorize(requestWith(accessHeaders(tokenB, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
	});

	test("a binding whose value no longer matches its enrolled sha256 never releases its key", async () => {
		const base = await fixture();
		const corrupted = { ...base, secrets: [{ ...base.secretA, sha256: await sha256Hex("other-key") }, base.secretB] };
		const h = await start(signer, corrupted);
		const token = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		expect(await h.admission.resolveBraveKey(identity)).toBeNull();
	});

	test("requests missing any Access header, or carrying only a cookie, are refused", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const attempts: Record<string, string>[] = [
			{ "cf-access-client-id": CLIENT_A, "cf-access-client-secret": SECRET_A },
			{ "cf-access-jwt-assertion": token, "cf-access-client-secret": SECRET_A },
			{ "cf-access-jwt-assertion": token, "cf-access-client-id": CLIENT_A },
			{ cookie: `CF_Authorization=${token}`, "cf-access-client-id": CLIENT_A, "cf-access-client-secret": SECRET_A },
		];
		for (const headers of attempts) {
			expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
		}
	});

	test("a token signed by another key under a served kid is refused", async () => {
		const h = await start(signer);
		const forged = await signJwt({ ...rogue, kid: signer.kid }, claimsFor({}));
		expect(await h.admission.authorize(requestWith(accessHeaders(forged, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
	});

	test("a tampered payload, an alg none token and an HS256 token are refused", async () => {
		const h = await start(signer);
		const valid = await signJwt(signer, claimsFor({}));
		const [headerPart, , signaturePart] = valid.split(".");
		const tampered = `${headerPart}.${segment(claimsFor({ exp: NOW / 1000 + 9999 }))}.${signaturePart}`;
		const unsigned = `${segment({ alg: "none", kid: "kid-1" })}.${segment(claimsFor({}))}.`;
		const hmac = `${segment({ alg: "HS256", kid: "kid-1" })}.${segment(claimsFor({}))}.${signaturePart}`;
		for (const token of [tampered, unsigned, hmac]) {
			expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		}
	});

	test("tokens expired, not yet valid, issued in the future or without exp are refused", async () => {
		const h = await start(signer);
		const attempts = [
			claimsFor({ exp: NOW / 1000 - 1 }),
			claimsFor({ exp: undefined }),
			claimsFor({ nbf: NOW / 1000 + 3600 }),
			claimsFor({ iat: NOW / 1000 + 3600 }),
		];
		for (const claims of attempts) {
			const token = await signJwt(signer, claims);
			expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		}
	});

	test("tokens for another audience, another issuer, a user session or a non-empty subject are refused", async () => {
		const h = await start(signer);
		const attempts = [
			claimsFor({ aud: ["some-other-application"] }),
			claimsFor({ iss: "https://evil.cloudflareaccess.com" }),
			claimsFor({ type: "org" }),
			claimsFor({ sub: "7335d417-61da-459d-899c-0a01c76a2f94" }),
			claimsFor({ sub: undefined }),
		];
		for (const claims of attempts) {
			const token = await signJwt(signer, claims);
			expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		}
		const multiAudience = await signJwt(signer, claimsFor({ aud: ["other", AUDIENCE] }));
		expect(await h.admission.authorize(requestWith(accessHeaders(multiAudience, CLIENT_A, SECRET_A)), "search:public")).not.toBeNull();
	});

	test("the JWKS is fetched only from the configured team issuer and never follows a redirect", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		await admitted(h, token, CLIENT_A, SECRET_A);
		expect(h.net.state.calls).toEqual([{ url: CERTS_URL, redirect: "error" }]);
	});

	test("a non-200 JWKS, a non-JSON JWKS or an oversized JWKS refuses every token without throwing", async () => {
		const token = await signJwt(signer, claimsFor({}));
		const headers = accessHeaders(token, CLIENT_A, SECRET_A);
		const scenarios: ((state: NetworkState) => void)[] = [
			(state) => {
				state.status = 500;
			},
			(state) => {
				state.body = "not json";
			},
			(state) => {
				state.body = JSON.stringify({ keys: [signer.publicJwk], pad: "x".repeat(JWKS_MAX_BYTES + 1) });
			},
		];
		for (const scenario of scenarios) {
			const h = await start(signer);
			scenario(h.net.state);
			expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
			expect(await h.admission.discover(requestWith(headers))).toEqual([]);
		}
	});

	test("forged kids cause at most one JWKS refetch per window, and rotation is picked up after the window", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		await admitted(h, token, CLIENT_A, SECRET_A);
		const forged = await signJwt(rogue, claimsFor({}));
		for (let i = 0; i < 5; i++) {
			expect(await h.admission.authorize(requestWith(accessHeaders(forged, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		}
		expect(h.net.state.calls.length).toBe(1);

		const rotated = await makeSigner("kid-2");
		h.net.state.keys = [signer.publicJwk, rotated.publicJwk];
		const rotatedToken = await signJwt(rotated, claimsFor({}));
		expect(await h.admission.authorize(requestWith(accessHeaders(rotatedToken, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		h.clock.now = NOW + 30_000;
		expect(await h.admission.authorize(requestWith(accessHeaders(rotatedToken, CLIENT_A, SECRET_A)), "search:public")).not.toBeNull();
		expect(h.net.state.calls.length).toBe(2);
	});

	test("a JWKS fetch that never answers is abandoned at the deadline and refuses admission", async () => {
		const h = await start(signer);
		h.net.state.hang = true;
		const token = await signJwt(signer, claimsFor({}));
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
	}, 10_000);

	test("a JWKS fetch that ignores its abort signal is refused at the deadline", async () => {
		const h = await start(signer);
		h.net.state.hang = true;
		h.net.state.ignoreSignal = true;
		const token = await signJwt(signer, claimsFor({}));
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		expect(h.net.state.calls.length).toBe(1);
	}, 10_000);

	test("a JWKS fetch that fails after the deadline is handled and admission stays refused", async () => {
		const h = await start(signer);
		h.net.state.hang = true;
		h.net.state.ignoreSignal = true;
		const token = await signJwt(signer, claimsFor({}));
		const headers = accessHeaders(token, CLIENT_A, SECRET_A);
		expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
		h.net.state.stalled.reject(new Error("late transport failure"));
		expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
	}, 10_000);

	test("once the JWKS TTL lapses, a failed refresh refuses the token rather than serving cached keys", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({ exp: NOW / 1000 + 2 * 86_400 }));
		const headers = accessHeaders(token, CLIENT_A, SECRET_A);
		expect(await h.admission.authorize(requestWith(headers), "search:public")).not.toBeNull();
		h.net.state.status = 500;
		h.clock.now = NOW + 10 * 60_000 + 1;
		expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
		h.net.state.status = 200;
		h.clock.now = NOW + 10 * 60_000 + 1 + 30_000;
		expect(await h.admission.authorize(requestWith(headers), "search:public")).not.toBeNull();
	});

	test("malformed or duplicate configuration fails closed at construction", async () => {
		const base = await fixture();
		const config = (issuer = ISSUER, secrets: SecretBinding[] = base.secrets) => ({
			issuer,
			audience: AUDIENCE,
			secrets,
			fetch: fakeNetwork([]).fetch,
		});
		const builds: (() => unknown)[] = [
			() => createAdmission({ ...base.policy, devices: [base.deviceA, { ...base.deviceB, deviceId: "dev-a" }] }, config()),
			() => createAdmission({ ...base.policy, devices: [base.deviceA, { ...base.deviceB, clientId: CLIENT_A }] }, config()),
			() => createAdmission({ ...base.policy, devices: [base.deviceA, { ...base.deviceB, userId: "ghost" }] }, config()),
			() => createAdmission({ ...base.policy, users: [base.userA, { ...base.userA }] }, config()),
			() =>
				createAdmission(
					{
						...base.policy,
						users: [{ ...base.userA, scopes: ["email:read" as unknown as ToolScope] }, base.userB],
					},
					config(),
				),
			() =>
				createAdmission(
					{ ...base.policy, tools: { "fetch:public": true } as unknown as AdmissionPolicy["tools"] },
					config(),
				),
			() => createAdmission(base.policy, config("http://team.cloudflareaccess.com")),
			() => createAdmission(base.policy, config("https://team.example.com")),
			() => createAdmission(base.policy, config("https://team.cloudflareaccess.com/")),
			() => createAdmission(base.policy, config(ISSUER, [base.secretA, { ...base.secretA }])),
			() => createAdmission(base.policy, config(ISSUER, [{ ...base.secretA, sha256: "XYZ" }])),
			() =>
				createAdmission(
					{ ...base.policy, devices: [{ ...base.deviceA, secretSha256: "a".repeat(128) }, base.deviceB] },
					config(),
				),
			() => createAdmission(base.policy, config(ISSUER, [{ ...base.secretA, costMicrousdPerRequest: -1 }])),
		];
		for (const build of builds) {
			expect(build).toThrow();
		}
	});

	// WHY: the budget authority refuses any user ID outside the shared opaque form, so admission must
	// refuse it too. Otherwise an admitted user could pass every check and then fail at reservation.
	test("a user ID outside the shared opaque form fails closed in the policy and in the secret bindings", async () => {
		const base = await fixture();
		const config = (secrets: SecretBinding[] = base.secrets) => ({
			issuer: ISSUER,
			audience: AUDIENCE,
			secrets,
			fetch: fakeNetwork([]).fetch,
		});
		for (const userId of ["", "has space", "-leading-dash", "a".repeat(129), "user/a", "usér"]) {
			expect(() =>
				createAdmission({ ...base.policy, users: [{ ...base.userA, userId }, base.userB], devices: [base.deviceB] }, config()),
			).toThrow("admission policy user is malformed");
			expect(() => createAdmission(base.policy, config([{ ...base.secretA, userId }, base.secretB]))).toThrow(
				"admission secret binding is malformed",
			);
		}
		expect(() => createAdmission(base.policy, config())).not.toThrow();
	});

	test("a policy edited into a malformed state after construction refuses every request", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		h.policy.users.push({ ...h.userA });
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
		expect(await h.admission.discover(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)))).toEqual([]);
	});

	test("a request that asks for an unknown scope or sends no credentials is refused without a log line", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => spyOn(console, method));
		expect(
			await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "email:read" as unknown as ToolScope),
		).toBeNull();
		expect(await h.admission.authorize(requestWith({}), "search:public")).toBeNull();
		expect(await h.admission.discover(new Request("https://tools.example.test/mcp"))).toEqual([]);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	test("a successful admission, a refused admission and a key resolution leave the console silent", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) => spyOn(console, method));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, "wrong-secret")), "search:public");
		await h.admission.resolveBraveKey(identity);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	test("a device disabled while its key is being fetched is refused", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		h.net.state.onRequest = () => {
			h.deviceA.enabled = false;
		};
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
	});

	test("a device that expires while its key is being fetched is refused", async () => {
		const h = await start(signer);
		h.deviceA.expiresAt = NOW + 1000;
		const token = await signJwt(signer, claimsFor({}));
		h.net.state.onRequest = () => {
			h.clock.now = NOW + 1000;
		};
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
	});

	test("a device removed from the policy while its key is being fetched is refused", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		h.net.state.onRequest = () => {
			h.policy.devices = [h.deviceB];
		};
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
	});

	test.each(["userId", "clientId", "deviceId"] as const)(
		"an in-place %s change while its key is being fetched refuses authorization and discovery",
		async (field) => {
			for (const operation of ["authorize", "discover"] as const) {
				const h = await start(signer);
				const token = await signJwt(signer, claimsFor({}));
				h.net.state.onRequest = () => {
					h.deviceA[field] = field === "userId" ? h.userB.userId : `rotated-${h.deviceA[field]}`;
				};
				const request = requestWith(accessHeaders(token, CLIENT_A, SECRET_A));
				if (operation === "authorize") {
					expect(await h.admission.authorize(request, "search:public")).toBeNull();
				} else {
					expect(await h.admission.discover(request)).toEqual([]);
				}
			}
		},
	);

	test.each(["userId", "clientId", "deviceId"] as const)(
		"an in-place %s change before the caller resumes refuses authorization and discovery",
		async (field) => {
			for (const operation of ["authorize", "discover"] as const) {
				const fx = await fixture();
				const net = fakeNetwork([signer.publicJwk]);
				let clockReads = 0;
				let changed = false;
				const admission = createAdmission(fx.policy, {
					issuer: ISSUER,
					audience: AUDIENCE,
					secrets: fx.secrets,
					fetch: net.fetch,
					now: () => {
						if (++clockReads === 2) {
							queueMicrotask(() => {
								fx.deviceA[field] = field === "userId" ? fx.userB.userId : `rotated-${fx.deviceA[field]}`;
								changed = true;
							});
						}
						return NOW;
					},
				});
				const token = await signJwt(signer, claimsFor({}));
				const request = requestWith(accessHeaders(token, CLIENT_A, SECRET_A));
				if (operation === "authorize") {
					expect(await admission.authorize(request, "search:public")).toBeNull();
				} else {
					expect(await admission.discover(request)).toEqual([]);
				}
				expect(changed).toBe(true);
			}
		},
	);

	test("a device re-enrolled with a new secret while its key is being fetched is refused", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const rotatedSha = await sha256Hex("client-secret-a-rotated");
		h.net.state.onRequest = () => {
			h.deviceA.secretSha256 = rotatedSha;
		};
		expect(await h.admission.authorize(requestWith(accessHeaders(token, CLIENT_A, SECRET_A)), "search:public")).toBeNull();
	});

	test("a scope revoked while the key is being fetched is not granted, and the live scope applies", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const headers = accessHeaders(token, CLIENT_A, SECRET_A);
		h.net.state.onRequest = () => {
			h.userA.scopes = ["fetch:public"];
		};
		expect(await h.admission.authorize(requestWith(headers), "search:public")).toBeNull();
		expect(await h.admission.authorize(requestWith(headers), "fetch:public")).not.toBeNull();
	});

	test("a binding replaced or removed after construction takes effect on the next resolution", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		expect((await h.admission.resolveBraveKey(identity))?.apiKey).toBe(BRAVE_A);
		const replacement = "brave-key-user-a-replaced";
		h.secrets[0] = { ...h.secretA, value: replacement, sha256: await sha256Hex(replacement), costMicrousdPerRequest: 1700 };
		expect(await h.admission.resolveBraveKey(identity)).toEqual({ apiKey: replacement, costMicrousdPerRequest: 1700 });
		h.secrets.splice(0, 1);
		expect(await h.admission.resolveBraveKey(identity)).toBeNull();
	});

	test("a duplicate binding added after construction fails closed on the next resolution", async () => {
		const h = await start(signer);
		const token = await signJwt(signer, claimsFor({}));
		const identity = await admitted(h, token, CLIENT_A, SECRET_A);
		h.secrets.push({ ...h.secretA });
		expect(await h.admission.resolveBraveKey(identity)).toBeNull();
	});
});
