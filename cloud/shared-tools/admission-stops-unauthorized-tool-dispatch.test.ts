import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedToolBudgetAuthority } from "./budget";
import type {
	AdmissionPolicy,
	BudgetLimits,
	BudgetNamespace,
	DevicePolicy,
	DurableStorage,
	SecretBinding,
	SqlCursor,
	SqlStorage,
	ToolScope,
	UserPolicy,
} from "./contracts";
import { type SharedToolsConfig, type ToolContext, createSharedToolsWorker } from "./worker";

// WHY: the worker is the only HTTP boundary in front of paid tools. A caller reaches a tool only
// after the Access token, the device secret and the user's scope all admit it, and after the
// durable budget reserves the call. A reservation is an awaited hop, so admission can change while
// it runs. These tests drive the real worker with real RS256 Access tokens, an injected JWKS
// network and the real SharedToolBudgetAuthority over a real bun:sqlite file. They close the class
// "a request reaches a tool, or spends budget, that admission had already refused, or a request
// picks an identity or key that is not its own". They do not cover Cloudflare Access, the
// dashboard, the upstream tools' own behaviour, or the Bitwarden copy of the keys.

const DAY = 86_400_000;
const ISSUER = "https://team.cloudflareaccess.com";
const AUDIENCE = "aud-tag-shared-tools";
const CERTS_URL = "https://team.cloudflareaccess.com/cdn-cgi/access/certs";
const NOW = 1_800_000_000_000;
const FAR_FUTURE = Date.UTC(2100, 0, 1);
const BODY_LIMIT = 64 * 1024;
const CLIENT_A = "aaaa1111aaaa1111aaaa1111aaaa1111.access";
const CLIENT_B = "bbbb2222bbbb2222bbbb2222bbbb2222.access";
const CLIENT_C = "cccc3333cccc3333cccc3333cccc3333.access";
const SECRET_A = "client-secret-a-enrolled";
const SECRET_B = "client-secret-b-enrolled";
const SECRET_C = "client-secret-c-enrolled";
const BRAVE_A = "brave-key-user-a";
const BRAVE_B = "brave-key-user-b";
const BRAVE_C = "brave-key-user-c";

const WIDE: BudgetLimits = {
	minute: 100,
	month: 1000,
	costMicrousd: 1_000_000_000,
	totalMonth: 1000,
	totalCostMicrousd: 1_000_000_000,
	expiresAt: FAR_FUTURE,
};


const tempRoot = mkdtempSync(join(tmpdir(), "admission-dispatch-"));
let fileCount = 0;
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

interface Store {
	db: Database;
	storage: DurableStorage;
	close(): void;
}

// The same bun:sqlite adapter as the budget restart suite, copied rather than exported for tests.
function openStore(path: string): Store {
	const db = new Database(path, { create: true });
	let closed = false;
	const sql: SqlStorage = {
		exec<T extends Record<string, unknown> = Record<string, unknown>>(
			query: string,
			...bindings: (string | number | null)[]
		): SqlCursor<T> {
			const statement = db.query(query);
			if (statement.columnNames.length > 0) {
				const rows: T[] = statement.all(...bindings) as T[];
				return { toArray: () => rows };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	};
	return {
		db,
		storage: { sql, transactionSync: <T>(callback: () => T): T => db.transaction(callback)() },
		close: () => {
			if (closed) return;
			closed = true;
			db.close();
		},
	};
}

const opened: Store[] = [];
afterEach(() => {
	for (const store of opened.splice(0)) store.close();
});

interface Signer {
	kid: string;
	privateKey: CryptoKey;
	publicJwk: JsonWebKey;
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

// Compact application token signed the way Access signs one.
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

async function tokenFor(signer: Signer, clientId: string): Promise<string> {
	return signJwt(signer, {
		type: "app",
		aud: [AUDIENCE],
		iss: ISSUER,
		common_name: clientId,
		sub: "",
		iat: NOW / 1000 - 10,
		exp: NOW / 1000 + 300,
	});
}

// The injected network serves only the trusted key. Any other key is unknown to admission.
function jwksNetwork(keys: JsonWebKey[]): typeof fetch {
	return (async () => new Response(JSON.stringify({ keys }), { status: 200 })) as typeof fetch;
}

type Who = "a" | "b" | "c";
const CREDENTIALS: Record<Who, { clientId: string; secret: string }> = {
	a: { clientId: CLIENT_A, secret: SECRET_A },
	b: { clientId: CLIENT_B, secret: SECRET_B },
	c: { clientId: CLIENT_C, secret: SECRET_C },
};

interface Dispatch {
	scope: ToolScope;
	request: Request;
	body: string;
	context: ToolContext;
}

interface Hooks {
	// Counts every reservation the worker sends to the durable authority.
	reserves: number;
	failReserve: boolean;
	// Runs once, after the authority has committed the reservation and before the response returns.
	afterReserve: (() => void) | null;
	toolThrows: boolean;
}

interface Rig {
	worker: { fetch(request: Request): Promise<Response> };
	store: Store;
	policy: AdmissionPolicy;
	signer: Signer;
	rogue: Signer;
	userA: UserPolicy;
	userC: UserPolicy;
	deviceA: DevicePolicy;
	secretA: SecretBinding;
	secrets: SecretBinding[];
	dispatches: Dispatch[];
	hooks: Hooks;
}

async function buildRig(search: Partial<BudgetLimits> = {}): Promise<Rig> {
	const signer = await makeSigner("trusted");
	const rogue = await makeSigner("rogue");
	const userA: UserPolicy = { userId: "user-a", enabled: true, scopes: ["fetch:public", "search:public"] };
	const userB: UserPolicy = { userId: "user-b", enabled: true, scopes: ["fetch:public", "search:public"] };
	// User C holds the search scope only, so a fetch call from C must be refused by scope.
	const userC: UserPolicy = { userId: "user-c", enabled: true, scopes: ["search:public"] };
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
	const deviceC: DevicePolicy = {
		deviceId: "dev-c",
		userId: "user-c",
		clientId: CLIENT_C,
		secretSha256: await sha256Hex(SECRET_C),
		enabled: true,
		expiresAt: NOW + DAY,
	};
	const policy: AdmissionPolicy = {
		enabled: true,
		users: [userA, userB, userC],
		devices: [deviceA, deviceB, deviceC],
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
	const secretC: SecretBinding = {
		userId: "user-c",
		value: BRAVE_C,
		sha256: await sha256Hex(BRAVE_C),
		costMicrousdPerRequest: 1500,
	};
	// Kept as the array the worker reads, so a test can rebind a key while a reservation is in flight.
	const secrets: SecretBinding[] = [secretA, secretB, secretC];

	const store = openStore(join(tempRoot, `budget-${fileCount++}.sqlite`));
	opened.push(store);
	const authority = new SharedToolBudgetAuthority(
		{ storage: store.storage },
		{ limits: { "fetch:public": WIDE, "search:public": { ...WIDE, ...search } }, now: () => NOW },
	);

	const hooks: Hooks = { reserves: 0, failReserve: false, afterReserve: null, toolThrows: false };
	const budget: BudgetNamespace = {
		idFromName: () => "pilot",
		get: () => ({
			fetch: async (request: Request): Promise<Response> => {
				hooks.reserves += 1;
				if (hooks.failReserve) throw new Error(`budget store down ${SECRET_A}`);
				const response = await authority.fetch(request);
				const after = hooks.afterReserve;
				hooks.afterReserve = null;
				after?.();
				return response;
			},
		}),
	};

	const dispatches: Dispatch[] = [];
	const record = async (scope: ToolScope, request: Request, context: ToolContext): Promise<Response> => {
		dispatches.push({ scope, request, body: await request.text(), context });
		if (hooks.toolThrows) throw new Error(`provider rejected key ${BRAVE_A} for ${SECRET_A}`);
		return Response.json({ tool: scope, ok: true });
	};
	const tools: SharedToolsConfig["tools"] = {
		"fetch:public": (request, context) => record("fetch:public", request, context),
		"search:public": (request, context) => record("search:public", request, context),
	};

	const worker = createSharedToolsWorker({
		policy,
		authentication: {
			issuer: ISSUER,
			audience: AUDIENCE,
			secrets,
			fetch: (async () => new Response(JSON.stringify({ keys: [signer.publicJwk] }), { status: 200 })) as typeof fetch,
			now: () => NOW,
		},
		budget,
		tools,
	});
	return { worker, store, policy, signer, rogue, userA, userC, deviceA, secretA, secrets, dispatches, hooks };
}

function accessHeaders(token: string, who: Who): Record<string, string> {
	const credentials = CREDENTIALS[who];
	return {
		"cf-access-jwt-assertion": token,
		"cf-access-client-id": credentials.clientId,
		"cf-access-client-secret": credentials.secret,
	};
}

async function authFor(signer: Signer, who: Who): Promise<Record<string, string>> {
	return accessHeaders(await tokenFor(signer, CREDENTIALS[who].clientId), who);
}

function post(rig: Rig, path: string, headers: Record<string, string>, body: BodyInit = "{}"): Promise<Response> {
	return rig.worker.fetch(
		new Request(`https://tools.example.test${path}`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body,
		}),
	);
}

function discover(rig: Rig, headers: Record<string, string>): Promise<Response> {
	return rig.worker.fetch(new Request("https://tools.example.test/tools", { method: "GET", headers }));
}


// A body that yields `total` bytes in `chunk`-sized pieces and never declares a length.
function streamOf(total: number, chunk: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= total) {
				controller.close();
				return;
			}
			const size = Math.min(chunk, total - sent);
			sent += size;
			controller.enqueue(new Uint8Array(size).fill(120));
		},
	});
}


describe("admission stops unauthorized tool dispatch", () => {
	test("a token that the trusted JWKS does not sign is refused before reservation or dispatch", async () => {
		const rig = await buildRig();
		const forged = accessHeaders(await tokenFor(rig.rogue, CLIENT_A), "a");
		const response = await post(rig, "/tools/search", forged);
		expect(response.status).toBe(403);
		expect(rig.hooks.reserves).toBe(0);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("a request without Access headers is refused before reservation or dispatch", async () => {
		const rig = await buildRig();
		const response = await post(rig, "/tools/search", {});
		expect(response.status).toBe(403);
		expect(rig.hooks.reserves).toBe(0);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("the global switch refuses every caller before reservation", async () => {
		const rig = await buildRig();
		rig.policy.enabled = false;
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(403);
		expect(rig.hooks.reserves).toBe(0);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("discovery lists only the scopes the calling user holds, and nothing without admission", async () => {
		const rig = await buildRig();
		const full = await discover(rig, await authFor(rig.signer, "a"));
		expect(await full.json()).toEqual({ tools: ["fetch:public", "search:public"] });

		const scoped = await discover(rig, await authFor(rig.signer, "c"));
		expect(await scoped.json()).toEqual({ tools: ["search:public"] });

		const refused = await discover(rig, accessHeaders(await tokenFor(rig.rogue, CLIENT_A), "a"));
		expect(refused.status).toBe(403);
	});

	test("a tool switched off disappears from discovery and refuses calls", async () => {
		const rig = await buildRig();
		rig.policy.tools["fetch:public"] = false;
		const listed = await discover(rig, await authFor(rig.signer, "a"));
		expect(await listed.json()).toEqual({ tools: ["search:public"] });

		const call = await post(rig, "/tools/fetch", await authFor(rig.signer, "a"));
		expect(call.status).toBe(403);
		expect(rig.hooks.reserves).toBe(0);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("a valid user without the scope cannot call the tool, and nothing is reserved", async () => {
		const rig = await buildRig();
		const response = await post(rig, "/tools/fetch", await authFor(rig.signer, "c"));
		expect(response.status).toBe(403);
		expect(rig.hooks.reserves).toBe(0);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("a valid user cannot select another user's identity or key through headers or body", async () => {
		const rig = await buildRig();
		const spoofed = {
			...(await authFor(rig.signer, "a")),
			"x-user-id": "user-b",
			"x-device-id": "dev-b",
			"x-brave-key": BRAVE_B,
		};
		const response = await post(rig, "/tools/search", spoofed, JSON.stringify({ userId: "user-b", braveKey: BRAVE_B }));
		expect(response.status).toBe(200);
		const [dispatch] = rig.dispatches;
		expect(dispatch?.context.identity).toEqual({ userId: "user-a", deviceId: "dev-a" });
		expect(dispatch?.context.braveKey?.apiKey).toBe(BRAVE_A);
		expect(dispatch?.context.braveKey?.apiKey).not.toBe(BRAVE_B);
	});

	test("each valid user reaches only their own key, whatever the body names", async () => {
		const rig = await buildRig();
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "b"), JSON.stringify({ userId: "user-a" }));
		expect(response.status).toBe(200);
		expect(rig.dispatches[0]?.context.identity.userId).toBe("user-b");
		expect(rig.dispatches[0]?.context.braveKey?.apiKey).toBe(BRAVE_B);
	});

	test("an exhausted minute quota refuses the second call and never reaches the tool", async () => {
		const rig = await buildRig({ minute: 1 });
		const headers = await authFor(rig.signer, "a");
		expect((await post(rig, "/tools/search", headers)).status).toBe(200);
		const refused = await post(rig, "/tools/search", headers);
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "budget_refused", reason: "minute_limit" });
		expect(rig.hooks.reserves).toBe(2);
		expect(rig.dispatches).toHaveLength(1);
	});

	test("an exhausted cost quota refuses before dispatch", async () => {
		// The enrolled key costs 1500 microusd per call, so a 1000 cap refuses the first call.
		const rig = await buildRig({ costMicrousd: 1000 });
		const refused = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "budget_refused", reason: "cost_limit" });
		expect(rig.dispatches).toHaveLength(0);
	});

	test("the callback carries no caller credentials and no caller identity headers", async () => {
		const rig = await buildRig();
		const response = await post(rig, "/tools/search", {
			...(await authFor(rig.signer, "a")),
			cookie: "session=secret",
			authorization: "Bearer leaked",
		});
		expect(response.status).toBe(200);
		const [dispatch] = rig.dispatches;
		expect(dispatch?.scope).toBe("search:public");
		expect(dispatch?.request.url).toBe("https://tools.internal/tools/search");
		expect([...(dispatch?.request.headers.keys() ?? [])].sort()).toEqual(["content-type"]);
	});

	test("a body at the 64 KiB limit is forwarded whole", async () => {
		const rig = await buildRig();
		const body = "x".repeat(BODY_LIMIT);
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"), body);
		expect(response.status).toBe(200);
		expect(rig.dispatches[0]?.body.length).toBe(BODY_LIMIT);
	});

	test("a streamed body one byte over the limit is refused before reservation", async () => {
		const rig = await buildRig();
		const headers = await authFor(rig.signer, "a");
		const response = await post(rig, "/tools/search", headers, streamOf(BODY_LIMIT + 1, 1024));
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "payload_too_large" });
		expect(rig.hooks.reserves).toBe(0);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("a stalled body is cancelled and refused with a timeout before reservation", async () => {
		const rig = await buildRig();
		let cancelled = false;
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([123]));
			},
			pull() {
				return new Promise<void>(() => {});
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"), stalled);
		expect(response.status).toBe(408);
		expect(await response.json()).toEqual({ error: "request_timeout" });
		expect(cancelled).toBe(true);
		expect(rig.hooks.reserves).toBe(0);
		expect(rig.dispatches).toHaveLength(0);
	}, 15_000);

	test("the global switch flipped during reservation blocks dispatch, and the charge stands", async () => {
		const rig = await buildRig();
		rig.hooks.afterReserve = () => {
			rig.policy.enabled = false;
		};
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(403);
		expect(rig.hooks.reserves).toBe(1);
		expect(rig.dispatches).toHaveLength(0);
		// A reservation is final, so the refused call stays charged rather than refunded.
		expect(rig.store.db.query<{ decision: string }, []>("SELECT decision FROM audit ORDER BY id").all().map((row) => row.decision)).toEqual(["allowed"]);
	});

	test("a device disabled during reservation blocks dispatch", async () => {
		const rig = await buildRig();
		rig.hooks.afterReserve = () => {
			rig.deviceA.enabled = false;
		};
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(403);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("a user disabled during reservation blocks dispatch", async () => {
		const rig = await buildRig();
		rig.hooks.afterReserve = () => {
			rig.userA.enabled = false;
		};
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(403);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("a key rebound to a different cost during reservation blocks dispatch", async () => {
		const rig = await buildRig();
		rig.hooks.afterReserve = () => {
			rig.secrets[0] = { ...rig.secretA, costMicrousdPerRequest: 9999 };
		};
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(403);
		expect(rig.dispatches).toHaveLength(0);
	});

	test("a tool failure returns a generic error that hides the key and the provider text", async () => {
		const rig = await buildRig();
		rig.hooks.toolThrows = true;
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(text).toBe(JSON.stringify({ error: "unavailable" }));
		expect(text).not.toContain(BRAVE_A);
		expect(text).not.toContain(SECRET_A);
	});

	test("a budget authority failure returns a generic error that hides the seeded secret", async () => {
		const rig = await buildRig();
		rig.hooks.failReserve = true;
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(text).not.toContain(SECRET_A);
		expect(text).not.toContain("budget store down");
		expect(rig.dispatches).toHaveLength(0);
	});

	test("an admitted search call returns the tool response unchanged", async () => {
		const rig = await buildRig();
		const response = await post(rig, "/tools/search", await authFor(rig.signer, "a"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ tool: "search:public", ok: true });
	});
});
