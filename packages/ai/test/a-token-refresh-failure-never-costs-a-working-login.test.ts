/**
 * WHY: eight ways a refresh that did not succeed cost the operator a login that still worked.
 *
 * 1. A refresh that answered after its caller stopped waiting was dropped. The 10 s bound ended the
 *    whole flight, released the lease and the in-flight entry, and nobody persisted the rotation
 *    that arrived a moment later. The provider had already spent the old refresh token, so the next
 *    request refreshed with a dead token (reuse detection revokes the grant) and the row was disabled.
 * 2. The account health probe marked a row auth-dead on ANY refresh failure, its own deadline
 *    included. The card showed "refresh failed" and the resolver moved the session to a sibling
 *    because a token endpoint was slow.
 * 3. A transient refresh failure inside the skew window, while the access token was still valid,
 *    blocked the row for five minutes and served a sibling instead of the token the provider accepts.
 * 4. ESC during a refresh blocked the row for five minutes and served the aborted request from a
 *    sibling, which recorded the session there: the abort moved the session.
 * 5. A token endpoint answering 200 without a usable access token either crashed the refresher with a
 *    TypeError (Cursor) or stored an empty bearer (Anthropic, Antigravity, Gemini CLI), which the
 *    provider then refused with a 401 that disabled the login.
 * 6. An MCP server's refresh aborted the token request itself after 10 s. A token endpoint that
 *    answered later had already spent the old refresh token, and the abort discarded the new one,
 *    so the next connection refreshed with a dead token and the server was signed out.
 * 7. A token endpoint answering 200 with JSON `null`, a string or a number crashed ten refreshers
 *    with a TypeError whose message was the crash text.
 * 8. A flight that reached its ceiling released the lease and the in-flight entry with its token
 *    request still open, and no refresher was handed a signal to stop it. The next request started a
 *    second flight beside it, spending the same single-use refresh token twice.
 *
 * Class closed: a refresh outcome that is not the provider refusing the grant never disables, marks
 * dead, blocks or moves off the row, and a rotation the provider minted is always persisted. The probe
 * sweep derives its verdict from `isDefinitiveOAuthFailure`, the one classifier the request path uses,
 * over a corpus holding both kinds, so the probe and the request path cannot disagree. The malformed
 * body sweep and the abort sweep read `PROVIDER_REGISTRY` at run time, so a new refresher is covered
 * by default.
 *
 * Not caught: a refresher whose aborted request never settles holds its row, and the cross-process
 * lease, for as long as that request stays open; each caller times out its own wait meanwhile. The
 * holding of the lease across processes is not driven here, since its renewal runs on real time. The
 * late commit only refuses to overwrite a newer row. The abort sweep drives each refresher's
 * first token request only, so a refresher's identity lookup (Anthropic's bootstrap) and an xAI OIDC
 * discovery stay bounded by their own timers.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialDisabledEvent,
	type OAuthCredential,
} from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as AIError from "@veyyon/ai/error";
import { isDefinitiveOAuthFailure } from "@veyyon/ai/error/flags";
import { type OAuthCredentials, registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/registry/oauth";
import { removeWithRetries } from "../../utils/src/temp";
import { getHashedIndex } from "../src/auth-storage/credentials";
import { PROVIDER_REGISTRY } from "../src/registry/registry";

const PROVIDER = "anthropic";
const SESSION = "refresh-failure-session";
/** The caller wait and flight ceiling in `oauth-refresh.ts`, restated so a change to either is a decision. */
const CALLER_WAIT_MS = 10_000;
const FLIGHT_CEILING_MS = 120_000;

let tempDir = "";
let store: SqliteAuthCredentialStore | undefined;
let disabled: CredentialDisabledEvent[] = [];

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-refresh-failure-"));
	store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
	disabled = [];
});

afterEach(async () => {
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	store?.close();
	store = undefined;
	if (tempDir) {
		await removeWithRetries(tempDir);
		tempDir = "";
	}
});

function oauth(suffix: string, expires: number): OAuthCredential {
	return {
		type: "oauth",
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

/** A storage whose refresh is `refresh`, holding the given rows in order; returns their ids. */
async function storageWith(
	rows: OAuthCredential[],
	refresh: (credentialId: number, signal: AbortSignal | undefined) => Promise<OAuthCredentials>,
	loadBalancing = false,
	viewStore: (target: SqliteAuthCredentialStore) => AuthCredentialStore = target => target,
): Promise<{ storage: AuthStorage; ids: number[] }> {
	for (const row of rows) store!.saveOAuth(PROVIDER, row);
	const storage = new AuthStorage(viewStore(store!), {
		loadBalancing,
		refreshOAuthCredential: (_provider, credentialId, _credential, signal) => refresh(credentialId, signal),
		// Load balancing ranks accounts by usage. This suite drives refresh outcomes, not ranking, and
		// the default strategy and usage provider would read the real endpoint and process-wide caches.
		usageProviderResolver: () => undefined,
		rankingStrategyResolver: () => undefined,
		onCredentialDisabled: event => {
			disabled.push(event);
		},
	});
	await storage.reload();
	return { storage, ids: store!.listAuthCredentials(PROVIDER).map(row => row.id) };
}

/**
 * A refresh the test answers by hand, counting how many times the token endpoint was asked and keeping
 * the signal of the latest request. `honoursAbort` makes it reject when that signal aborts, as a
 * refresher passing it to `fetch` does; otherwise it ignores the abort.
 */
function heldRefresh(honoursAbort = false) {
	const answer = Promise.withResolvers<OAuthCredentials>();
	const started = Promise.withResolvers<void>();
	let calls = 0;
	let signal: AbortSignal | undefined;
	return {
		answer,
		started: started.promise,
		get calls() {
			return calls;
		},
		get signal() {
			return signal;
		},
		refresh: (_credentialId?: number, requestSignal?: AbortSignal): Promise<OAuthCredentials> => {
			calls += 1;
			signal = requestSignal;
			started.resolve();
			if (honoursAbort && requestSignal) {
				const aborted = Promise.withResolvers<never>();
				requestSignal.addEventListener("abort", () => aborted.reject(requestSignal.reason), { once: true });
				return Promise.race([answer.promise, aborted.promise]);
			}
			return answer.promise;
		},
	};
}

const ROTATED: OAuthCredentials = { access: "access-rotated", refresh: "refresh-rotated", expires: 4_102_444_800_000 };

function storedRefresh(id: number): string | undefined {
	const row = store!.readAuthCredentialById(id);
	return row?.credential.type === "oauth" ? row.credential.refresh : undefined;
}

/** Drain the promise chains a settled refresh schedules. No timer is involved. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
}

describe("a refresh flight outlives the caller that started it", () => {
	it("persists a rotation that answers after the caller stopped waiting", async () => {
		const held = heldRefresh();
		const { storage, ids } = await storageWith([oauth("home", 0)], held.refresh);
		vi.useFakeTimers();

		const caller = storage.refreshCredentialById(ids[0]!).catch((error: unknown) => error);
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		expect(String(await caller)).toContain("timed out");

		held.answer.resolve(ROTATED);
		await settle();
		expect(storedRefresh(ids[0]!)).toBe("refresh-rotated");
		expect(disabled).toEqual([]);
	});

	it("spends the old refresh token once while the first flight is still running", async () => {
		const held = heldRefresh();
		const { storage, ids } = await storageWith([oauth("home", 0)], held.refresh);
		vi.useFakeTimers();

		const first = storage.refreshCredentialById(ids[0]!).catch((error: unknown) => error);
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		await first;

		const second = storage.refreshCredentialById(ids[0]!);
		held.answer.resolve(ROTATED);
		expect((await second).credential.type).toBe("oauth");
		expect(held.calls).toBe(1);
		expect(storedRefresh(ids[0]!)).toBe("refresh-rotated");
	});

	it("persists a rotation that answers after the flight's ceiling", async () => {
		const held = heldRefresh();
		const { storage, ids } = await storageWith([oauth("home", 0)], held.refresh);
		vi.useFakeTimers();

		const caller = storage.refreshCredentialById(ids[0]!).catch((error: unknown) => error);
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		await caller;
		vi.advanceTimersByTime(FLIGHT_CEILING_MS);
		await settle();
		expect(storedRefresh(ids[0]!)).toBe("refresh-home");

		held.answer.resolve(ROTATED);
		await settle();
		expect(storedRefresh(ids[0]!)).toBe("refresh-rotated");
	});

	it("aborts the token request at the flight ceiling, not at the caller wait", async () => {
		const held = heldRefresh();
		const { storage, ids } = await storageWith([oauth("home", 0)], held.refresh);
		vi.useFakeTimers();

		const caller = storage.refreshCredentialById(ids[0]!).catch((error: unknown) => error);
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		await caller;
		await settle();
		expect(held.signal?.aborted).toBe(false);

		vi.advanceTimersByTime(FLIGHT_CEILING_MS - CALLER_WAIT_MS);
		await settle();
		expect(held.signal?.aborted).toBe(true);
	});

	/**
	 * The store as one without the durable-lease surface sees it: the flight is fenced in this process
	 * only. The methods are bound to the store, whose private fields a proxy receiver cannot read.
	 */
	function withoutDurableLease(target: SqliteAuthCredentialStore): AuthCredentialStore {
		const lease = new Set<PropertyKey>([
			"tryAcquireCredentialRefreshLease",
			"getCredentialRefreshLeaseExpiresAt",
			"releaseCredentialRefreshLease",
			"renewCredentialRefreshLease",
		]);
		return new Proxy(target, {
			get(store, property) {
				if (lease.has(property)) return undefined;
				const value: unknown = Reflect.get(store, property, store);
				return typeof value === "function" ? value.bind(store) : value;
			},
		});
	}

	it.each([
		["a durable lease", false],
		["no durable lease", true],
	])(
		"holds the flight until its aborted request settles, so a second request never spends the token again (%s)",
		async (_label, leaseless) => {
			const held = heldRefresh();
			const { storage, ids } = await storageWith(
				[oauth("home", 0)],
				held.refresh,
				false,
				leaseless ? withoutDurableLease : undefined,
			);
			vi.useFakeTimers();

			const first = storage.refreshCredentialById(ids[0]!).catch((error: unknown) => error);
			await held.started;
			vi.advanceTimersByTime(FLIGHT_CEILING_MS);
			await first;
			await settle();
			vi.advanceTimersByTime(FLIGHT_CEILING_MS * 10);
			await settle();

			const second = storage.refreshCredentialById(ids[0]!);
			await settle();
			held.answer.resolve(ROTATED);
			expect((await second).credential.type).toBe("oauth");
			expect(held.calls).toBe(1);
			expect(storedRefresh(ids[0]!)).toBe("refresh-rotated");
		},
	);

	it("ends the flight at the ceiling when the aborted request settles", async () => {
		const held = heldRefresh(true);
		const { storage, ids } = await storageWith([oauth("home", 0)], held.refresh);
		vi.useFakeTimers();

		const first = storage.refreshCredentialById(ids[0]!).catch((error: unknown) => error);
		await held.started;
		vi.advanceTimersByTime(FLIGHT_CEILING_MS);
		expect(String(await first)).toContain("timed out");
		await settle();

		const second = storage.refreshCredentialById(ids[0]!).catch((error: unknown) => error);
		await settle();
		expect(held.calls).toBe(2);
		vi.advanceTimersByTime(FLIGHT_CEILING_MS);
		await second;
		expect(storedRefresh(ids[0]!)).toBe("refresh-home");
		expect(disabled).toEqual([]);
	});
});

describe("an MCP credential refresh outlives the caller that started it", () => {
	const MCP = "mcp-late-server";

	async function mcpRow(refresh: (signal: AbortSignal | undefined) => Promise<OAuthCredentials>) {
		store!.saveOAuth(MCP, oauth("mcp", 0));
		const storage = new AuthStorage(store!, {
			usageProviderResolver: () => undefined,
			onCredentialDisabled: event => {
				disabled.push(event);
			},
		});
		await storage.reload();
		const id = store!.listAuthCredentials(MCP)[0]!.id;
		const failures: unknown[] = [];
		const resolve = () =>
			storage.refreshStoredOAuthCredential(MCP, {
				credentialFromRow: row => row,
				refresh: (_current, signal) => refresh(signal),
				isDefinitiveFailure: error => isDefinitiveOAuthFailure(String(error)),
				keepCredentialOnRefreshFailure: true,
				onRefreshFailure: error => failures.push(error),
			});
		return { id, resolve, failures };
	}

	it("serves the held credential after the caller wait and persists the rotation that answers later", async () => {
		const held = heldRefresh();
		let signal: AbortSignal | undefined;
		const { id, resolve, failures } = await mcpRow(requestSignal => {
			signal = requestSignal;
			return held.refresh();
		});
		vi.useFakeTimers();

		const caller = resolve();
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		const result = await caller;
		expect(result.refreshed).toBe(false);
		expect(result.credential?.refresh).toBe("refresh-mcp");
		expect(failures).toHaveLength(1);
		expect(String(failures[0])).toContain("timed out");
		expect(signal?.aborted).toBe(false);

		held.answer.resolve(ROTATED);
		await settle();
		expect(storedRefresh(id)).toBe("refresh-rotated");
		expect(store!.tryAcquireCredentialRefreshLease(id, "peer", Date.now() + 1_000)).toBe(true);
	});

	it("aborts the token request at the flight ceiling, not at the caller wait", async () => {
		const held = heldRefresh();
		let signal: AbortSignal | undefined;
		const { resolve } = await mcpRow(requestSignal => {
			signal = requestSignal;
			return held.refresh();
		});
		vi.useFakeTimers();

		const caller = resolve();
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		await caller;
		vi.advanceTimersByTime(FLIGHT_CEILING_MS - CALLER_WAIT_MS - 1);
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(signal?.aborted).toBe(true);
		held.answer.reject(signal?.reason);
		await settle();
	});

	it("reports a transient failure that answers after the caller left once, and keeps the row", async () => {
		const held = heldRefresh();
		const { id, resolve, failures } = await mcpRow(() => held.refresh());
		vi.useFakeTimers();

		const caller = resolve();
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		await caller;
		held.answer.reject(new Error("fetch failed: ECONNRESET"));
		await settle();
		expect(failures).toHaveLength(1);
		expect(storedRefresh(id)).toBe("refresh-mcp");
		expect(disabled).toEqual([]);
	});

	it("signs the row out on a refusal that answers after the caller left", async () => {
		const refusal = "OAuth token refresh failed: 400 invalid_grant";
		expect(isDefinitiveOAuthFailure(refusal)).toBe(true);
		const held = heldRefresh();
		const { resolve } = await mcpRow(() => held.refresh());
		vi.useFakeTimers();

		const caller = resolve();
		await held.started;
		vi.advanceTimersByTime(CALLER_WAIT_MS);
		await caller;
		held.answer.reject(new Error(refusal));
		await settle();
		expect(store!.listAuthCredentials(MCP)).toEqual([]);
		expect(disabled.map(event => event.provider)).toEqual([MCP]);
	});

	it("stops waiting for a peer's lease at the caller wait and serves the held credential", async () => {
		const held = heldRefresh();
		const { id, resolve, failures } = await mcpRow(() => held.refresh());
		expect(store!.tryAcquireCredentialRefreshLease(id, "peer", Date.now() + FLIGHT_CEILING_MS)).toBe(true);
		// Each poll of the peer's lease advances the clock by its sleep instead of sleeping. The bound
		// turns a wait that never ends into a failure rather than a microtask loop no timeout can stop.
		let polls = 0;
		vi.spyOn(Bun, "sleep").mockImplementation(async ms => {
			polls += 1;
			if (polls > 10_000) throw new Error("the wait for the peer's lease never ended");
			setSystemTime(new Date(Date.now() + Number(ms)));
		});

		const result = await resolve();
		expect(result).toMatchObject({ refreshed: false, credential: { refresh: "refresh-mcp" } });
		expect(String(failures[0])).toContain("timed out");
		expect(held.calls).toBe(0);
	});
});

/**
 * Failure messages a refresh can end in. Both kinds must be present, or the sweep below could pass
 * with a probe that always answers one way.
 */
const REFRESH_FAILURES = [
	"OAuth token refresh timed out for provider: anthropic",
	"The operation timed out.",
	"credential refresh aborted",
	"fetch failed: ECONNRESET",
	"Token refresh failed: 503 Service Unavailable",
	"Token refresh failed: 429 Too Many Requests",
	"OAuth token refresh for anthropic returned no usable access token",
	"invalid_grant: refresh token revoked",
	"Token refresh failed: 401 Unauthorized",
];

describe("the account health probe", () => {
	it("holds a corpus with both a refusal and a transient failure", () => {
		const verdicts = new Set(REFRESH_FAILURES.map(message => isDefinitiveOAuthFailure(message)));
		expect([...verdicts].sort()).toEqual([false, true]);
	});

	it.each(REFRESH_FAILURES)("reads %p the way the request path reads it", async message => {
		const definitive = isDefinitiveOAuthFailure(message);
		const { storage, ids } = await storageWith([oauth("home", 0), oauth("sibling", 4_102_444_800_000)], () =>
			Promise.reject(new Error(message)),
		);
		const [homeId, siblingId] = ids;

		const [result] = await storage.checkCredentials({ credentialIds: [homeId!] });

		expect(result!.ok).toBe(definitive ? false : null);
		expect(result!.reason?.startsWith("oauth refresh failed")).toBe(definitive);
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION)?.activeCredentialId).toBe(
			definitive ? siblingId : homeId,
		);
		expect(disabled).toEqual([]);
	});

	it("keeps serving a row whose refresh outlived the probe's own deadline", async () => {
		const held = heldRefresh();
		const { storage, ids } = await storageWith([oauth("home", 0), oauth("sibling", 4_102_444_800_000)], held.refresh);
		vi.useFakeTimers();

		const probe = storage.checkCredentials({ credentialIds: [ids[0]!], timeoutMs: 5_000 });
		await held.started;
		vi.advanceTimersByTime(5_000);
		const [result] = await probe;

		expect(result!.ok).toBeNull();
		expect(storage.sessionCredentialRouting(PROVIDER, SESSION)?.activeCredentialId).toBe(ids[0]);
	});

	it("writes a refreshed token onto the row it refreshed when no row carries an identity", async () => {
		const anonymous = (suffix: string, expires: number): OAuthCredential => ({
			type: "oauth",
			access: `access-${suffix}`,
			refresh: `refresh-${suffix}`,
			expires,
		});
		const { storage, ids } = await storageWith([anonymous("first", 4_102_444_800_000), anonymous("second", 0)], () =>
			Promise.resolve(ROTATED),
		);

		await storage.checkCredentials({ credentialIds: [ids[1]!] });

		expect(storedRefresh(ids[0]!)).toBe("refresh-first");
		expect(storedRefresh(ids[1]!)).toBe("refresh-rotated");
	});
});

describe("a request whose refresh did not complete", () => {
	it("serves the access token the provider still accepts inside the skew window", async () => {
		const { storage } = await storageWith(
			[oauth("home", Date.now() + 30_000), oauth("sibling", 4_102_444_800_000)],
			() => Promise.reject(new Error("fetch failed: ECONNRESET")),
		);

		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("access-home");
		expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("access-home");
		expect(storage.credentialBlockedUntil(PROVIDER, `${PROVIDER}:oauth`, 0)).toBeUndefined();
	});

	it("persists a rotation whose access token is unusable, keeping the new refresh token", async () => {
		// The first refresh (the resolver's preflight) fails on the network; the second rotates the
		// grant and returns an access token that is already expired, so no key can be derived from it.
		// Later attempts fail on the network again.
		const networkFailure = () => Promise.reject(new Error("fetch failed: ECONNRESET"));
		const answers = [networkFailure, () => Promise.resolve({ ...ROTATED, expires: Date.now() - 1_000 })];
		let calls = 0;
		const { storage, ids } = await storageWith([oauth("home", 0)], () => (answers[calls++] ?? networkFailure)());

		expect(await storage.getApiKey(PROVIDER, SESSION)).toBeUndefined();
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(storedRefresh(ids[0]!)).toBe("refresh-rotated");
		expect(disabled).toEqual([]);
	});

	it.each([false, true])(
		"does not move the session when the caller aborts mid-refresh (load balancing %p)",
		async loadBalancing => {
			const held = heldRefresh();
			const startedAt = Date.now();
			// The selector starts at storage order with movement off and at the session's hash with it on;
			// the home row goes where the selector starts, so the first request settles the session on it.
			const homeIndex = loadBalancing ? getHashedIndex(SESSION, 2) : 0;
			const home = oauth("home", startedAt + 3_600_000);
			const sibling = oauth("sibling", 4_102_444_800_000);
			const { storage, ids } = await storageWith(
				homeIndex === 0 ? [home, sibling] : [sibling, home],
				held.refresh,
				loadBalancing,
			);
			const homeId = ids[homeIndex]!;
			expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("access-home");
			setSystemTime(new Date(startedAt + 2 * 3_600_000));

			const controller = new AbortController();
			const aborted = storage.getApiKey(PROVIDER, SESSION, { signal: controller.signal });
			await held.started;
			controller.abort();
			expect(await aborted).toBeUndefined();
			expect(storage.credentialBlockedUntil(PROVIDER, `${PROVIDER}:oauth`, homeIndex)).toBeUndefined();

			held.answer.resolve(ROTATED);
			await settle();
			expect(storedRefresh(homeId)).toBe("refresh-rotated");
			expect(await storage.getApiKey(PROVIDER, SESSION)).toBe("access-rotated");
			expect(held.calls).toBe(1);
		},
	);
});

/** Registry ids with a refresher, read at run time. */
const REFRESHERS = PROVIDER_REGISTRY.filter(provider => provider.login && provider.refreshToken).map(
	provider => provider.id,
);

/** 200 answers a token endpoint can give that carry no usable access token. */
const MALFORMED_BODIES = {
	empty: "{}",
	blank: JSON.stringify({ access_token: "", accessToken: "", expires_in: 3600, expiresIn: 3600 }),
	array: "[]",
	html: "<html>ok</html>",
	null: "null",
	string: JSON.stringify("ok"),
	number: "42",
};

describe("a token endpoint answering 200 without a usable token", () => {
	it.each(REFRESHERS.flatMap(provider => Object.keys(MALFORMED_BODIES).map(body => [provider, body] as const)))(
		"%s with a %s body keeps the login and stores no empty token",
		async (provider, bodyName) => {
			const body = MALFORMED_BODIES[bodyName as keyof typeof MALFORMED_BODIES];
			vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async (): Promise<Response> =>
						new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
					{ preconnect: (): void => {} },
				),
			);
			store!.saveOAuth(provider, {
				access: "access-token",
				refresh: "refresh-token",
				expires: 0,
				projectId: "project",
				accountId: "account",
				email: "someone@example.com",
			});
			const storage = new AuthStorage(store!, {
				onCredentialDisabled: event => {
					disabled.push(event);
				},
			});
			await storage.reload();
			const id = store!.listAuthCredentials(provider)[0]!.id;

			const outcome = await storage.refreshCredentialById(id).then(
				() => undefined,
				(error: unknown) => error,
			);

			const row = store!.readAuthCredentialById(id);
			expect(row?.disabledCause).toBeNull();
			if (row?.credential.type !== "oauth") throw new Error(`${provider} row is not OAuth`);
			if (outcome === undefined) {
				expect(row.credential.access.length).toBeGreaterThan(0);
				return;
			}
			// An unparsable body fails in `response.json()`; every other malformed answer is a validation
			// error. A TypeError, ReferenceError or any other class is a crash inside the refresher.
			const failure = outcome instanceof AIError.OAuthError || outcome instanceof SyntaxError ? "handled" : outcome;
			expect(failure, `${provider} ${bodyName}`).toBe("handled");
			expect(isDefinitiveOAuthFailure(String(outcome))).toBe(false);
			expect(row.credential.access).toBe("access-token");
			expect(disabled).toEqual([]);
		},
	);
});

describe("a refresher aborted by its flight", () => {
	/**
	 * The flight aborts the token request at its ceiling and holds the lease until the request
	 * settles. A refresher that drops the signal leaves the request open beside the next flight, which
	 * then spends the same single-use refresh token. Every registry refresher is driven: its token
	 * request must carry the signal and settle once it aborts. The one refresher that makes no request
	 * is pinned by name, so a new refresher with no request is a decision, not a silent pass.
	 */
	it("passes the signal to the token request and settles when it aborts", async () => {
		const unsignalled: string[] = [];
		const noRequest: string[] = [];
		for (const provider of REFRESHERS) {
			const definition = PROVIDER_REGISTRY.find(entry => entry.id === provider)!;
			const posted = Promise.withResolvers<"posted">();
			let tokenRequestSignal: AbortSignal | undefined;
			const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
						if (String(input).includes("/.well-known/")) {
							return Response.json({ token_endpoint: "https://auth.x.ai/oauth2/token" });
						}
						const signal = init?.signal ?? undefined;
						tokenRequestSignal = signal;
						posted.resolve("posted");
						// An unsignalled request answers a 503 so the sweep ends and reports it.
						if (!signal) return new Response("unavailable", { status: 503 });
						const aborted = Promise.withResolvers<never>();
						signal.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
						return aborted.promise;
					},
					{ preconnect: (): void => {} },
				),
			);
			const controller = new AbortController();
			const refresh = definition.refreshToken!(
				{
					access: "access-token",
					refresh: "refresh-token",
					expires: 0,
					projectId: "project",
					accountId: "account",
					email: "someone@example.com",
				},
				controller.signal,
			).then(
				() => "resolved",
				() => "rejected",
			);
			const first = await Promise.race([posted.promise, refresh]);
			if (first !== "posted") {
				noRequest.push(provider);
			} else if (tokenRequestSignal === undefined) {
				unsignalled.push(provider);
				await refresh;
			} else {
				controller.abort(new Error("flight ceiling"));
				// A request bounded only by the refresher's own timer is not the caller's: it stays open.
				if (!tokenRequestSignal.aborted) {
					unsignalled.push(provider);
				} else {
					expect(await refresh, provider).toBe("rejected");
				}
			}
			fetchSpy.mockRestore();
		}
		expect(unsignalled).toEqual([]);
		expect(noRequest).toEqual(["github-copilot"]);
	});

	/** A refresh that hangs until `signal` aborts, recording the signal it was handed. */
	interface HangingRefresh {
		started: Promise<AbortSignal | undefined>;
		run(signal: AbortSignal | undefined): Promise<never>;
	}

	function hangingUntilAborted(): HangingRefresh {
		const started = Promise.withResolvers<AbortSignal | undefined>();
		return {
			started: started.promise,
			run: (signal: AbortSignal | undefined): Promise<never> => {
				started.resolve(signal);
				const aborted = Promise.withResolvers<never>();
				signal?.addEventListener("abort", () => aborted.reject(signal.reason), { once: true });
				return aborted.promise;
			},
		};
	}

	async function abortedAtCeiling(provider: string, hang: HangingRefresh) {
		store!.saveOAuth(provider, { ...oauth("flight", 0), projectId: "project" });
		const storage = new AuthStorage(store!, { onCredentialDisabled: event => void disabled.push(event) });
		await storage.reload();
		vi.useFakeTimers();
		const caller = storage
			.refreshCredentialById(store!.listAuthCredentials(provider)[0]!.id)
			.catch((error: unknown) => error);
		const signal = await hang.started;
		await settle();
		expect(signal?.aborted).toBe(false);
		vi.advanceTimersByTime(FLIGHT_CEILING_MS);
		await caller;
		await settle();
		expect(signal?.aborted).toBe(true);
		expect(disabled).toEqual([]);
	}

	it("hands the flight's signal to a registry refresher's token request", async () => {
		const hang = hangingUntilAborted();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => hang.run(init?.signal ?? undefined),
				{
					preconnect: (): void => {},
				},
			),
		);
		await abortedAtCeiling("cursor", hang);
	});

	it("hands the flight's signal to a custom provider's refresher", async () => {
		const hang = hangingUntilAborted();
		registerOAuthProvider({
			id: "custom-refresh-signal",
			name: "Custom",
			sourceId: "custom-refresh-signal-test",
			login: async () => "unused",
			refreshToken: (_credentials, signal) => hang.run(signal),
		});
		try {
			await abortedAtCeiling("custom-refresh-signal", hang);
		} finally {
			unregisterOAuthProviders("custom-refresh-signal-test");
		}
	});
});
