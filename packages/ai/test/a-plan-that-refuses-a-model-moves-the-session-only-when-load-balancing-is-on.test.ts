/**
 * WHY: a Cursor Free account answers a request for a named model with a `resource_exhausted` end
 * stream whose top-level message is the bare word `Error`; the refusal itself is in
 * `details[].debug` (`ERROR_RATE_LIMITED_CHANGEABLE`, "Named models unavailable", "Free plans can
 * only use Auto"). The details were dropped and the failure read as an unexplained rate limit.
 *
 * Class closed: a plan refusal is its own classification (`AccountPolicy`, beside `UsageLimit` for
 * Cursor), the end stream keeps the provider's sentence, and the refusal is recorded for that
 * model only. Moving to another account is governed by `accounts.loadBalancing` like every other
 * move that is not auth death: with the setting on the session moves and says so; with it off
 * nothing moves, in this process or a peer reading the same store, and a withheld notice names the
 * account and the idle siblings, once per account and model.
 *
 * Not caught: a provider that refuses a model for the plan with a code this classifier does not
 * know. Such a refusal is still a usage limit and follows the same setting.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import {
	type AuthCredentialStore,
	AuthStorage,
	type CredentialFailoverEvent,
	type UsageLimitWithheldEvent,
} from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import * as AIError from "../src/error";
import { parseConnectEndStream } from "../src/providers/cursor";

const PROVIDER = "unit-plan-refusal";
const SESSION_ID = "session-on-a-free-plan";
const NAMED_MODEL = "named-model";
const OTHER_MODEL = "auto";
const HOUR_MS = 60 * 60_000;
/**
 * After any real clock: SQLite stamps a persisted block with its own time, and a stamp later than the
 * mocked clock reads as a record from a future clock and is dropped.
 */
const NOW_MS = 4_000_000_000_000;

/** A Free plan's refusal of a named model, reduced to the fields the parser reads. */
const PLAN_REFUSAL_END_STREAM = {
	error: {
		code: "resource_exhausted",
		message: "Error",
		details: [
			{
				type: "aiserver.v1.ErrorDetails",
				debug: {
					error: "ERROR_RATE_LIMITED_CHANGEABLE",
					details: {
						title: "Named models unavailable",
						detail: "Free plans can only use Auto. Switch to Auto or upgrade plans to continue.",
						isRetryable: false,
					},
				},
			},
		],
	},
};

/** A spent allowance on the same wire, with no plan code. */
const QUOTA_END_STREAM = { error: { code: "resource_exhausted", message: "You've hit your usage limit" } };

function endStream(payload: unknown): Error {
	const error = parseConnectEndStream(new TextEncoder().encode(JSON.stringify(payload)));
	if (!error) throw new Error("the end stream parsed as success");
	return error;
}

describe("the Cursor end stream keeps the refusal the provider wrote", () => {
	test("the plan refusal reads as the provider's sentence and code, not `Error`", () => {
		const error = endStream(PLAN_REFUSAL_END_STREAM);
		expect(error.message).toContain(
			"Named models unavailable: Free plans can only use Auto. Switch to Auto or upgrade plans to continue.",
		);
		expect(error.message).toContain("ERROR_RATE_LIMITED_CHANGEABLE");
		expect(error.message).not.toMatch(/resource_exhausted: Error\b/);
	});

	test("the plan refusal classifies as a usage limit AND a model the plan lacks", () => {
		const error = endStream(PLAN_REFUSAL_END_STREAM);
		expect(AIError.isUsageLimit(error)).toBe(true);
		expect(AIError.isCursorPlanAccountPolicyError(error, "cursor")).toBe(true);
	});

	test("a spent allowance is a usage limit and nothing more", () => {
		const error = endStream(QUOTA_END_STREAM);
		expect(AIError.isUsageLimit(error)).toBe(true);
		expect(AIError.isCursorPlanAccountPolicyError(error, "cursor")).toBe(false);
	});

	test("a details entry with no debug falls back to the top-level message", () => {
		const error = endStream({ error: { code: "internal", message: "upstream broke", details: [{ type: "x" }] } });
		expect(error.message).toContain("upstream broke");
	});
});

describe("a plan refusal moves the session only when load balancing is on", () => {
	let store: AuthCredentialStore | null = null;

	beforeEach(() => {
		setSystemTime(new Date(NOW_MS));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		setSystemTime();
	});

	function oauth(name: string) {
		return {
			type: "oauth" as const,
			access: `access-${name}`,
			refresh: `refresh-${name}`,
			expires: NOW_MS + HOUR_MS,
			accountId: `account-${name}`,
			email: `${name}@example.com`,
		};
	}

	async function seed(storage: AuthStorage, names: string[]): Promise<number[]> {
		await storage.set(PROVIDER, names.map(oauth));
		return storage.listStoredCredentials(PROVIDER).map(row => row.id);
	}

	function storageWith(loadBalancing: boolean): {
		storage: AuthStorage;
		events: CredentialFailoverEvent[];
		withheld: UsageLimitWithheldEvent[];
	} {
		if (!store) throw new Error("test setup failed");
		const events: CredentialFailoverEvent[] = [];
		const withheld: UsageLimitWithheldEvent[] = [];
		const storage = new AuthStorage(store, {
			loadBalancing,
			onCredentialFailover: event => void events.push(event),
			onUsageLimitWithheld: event => void withheld.push(event),
		});
		return { storage, events, withheld };
	}

	function refuse(storage: AuthStorage, credentialId: number | undefined): Promise<boolean> {
		return storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId,
			modelId: NAMED_MODEL,
			error: endStream(PLAN_REFUSAL_END_STREAM),
		});
	}

	test("load balancing on: the next request for the model goes to the sibling, and the move is announced", async () => {
		const { storage, events, withheld } = storageWith(true);
		const ids = await seed(storage, ["first", "second"]);
		const names = ["first", "second"];
		const served = await storage.getApiKey(PROVIDER, SESSION_ID, { modelId: NAMED_MODEL });
		const refused = served === "access-first" ? 0 : 1;
		const sibling = 1 - refused;

		expect(await refuse(storage, ids[refused])).toBe(true);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID, { modelId: NAMED_MODEL })).toBe(`access-${names[sibling]}`);
		expect(events).toEqual([
			{
				provider: PROVIDER,
				from: { credentialId: ids[refused], label: `${names[refused]}@example.com` },
				to: { credentialId: ids[sibling], label: `${names[sibling]}@example.com` },
				reason: "model-not-in-plan",
				cause: `its plan does not include ${NAMED_MODEL}`,
			},
		]);
		expect(withheld).toEqual([]);
	});

	test("load balancing off: nothing moves, and the idle sibling is announced once", async () => {
		const { storage, events, withheld } = storageWith(false);
		const ids = await seed(storage, ["first", "second"]);
		const names = ["first", "second"];
		const served = await storage.getApiKey(PROVIDER, SESSION_ID, { modelId: NAMED_MODEL });
		const refused = served === "access-first" ? 0 : 1;

		expect(await refuse(storage, ids[refused])).toBe(false);
		expect(await storage.getApiKey(PROVIDER, SESSION_ID, { modelId: NAMED_MODEL })).toBe(`access-${names[refused]}`);
		// The turn's retry hits the same refusal; the notice is not repeated.
		expect(await refuse(storage, ids[refused])).toBe(false);
		expect(events).toEqual([]);
		expect(withheld).toEqual([
			{
				provider: PROVIDER,
				account: { credentialId: ids[refused], label: `${names[refused]}@example.com` },
				idleSiblings: 1,
				reason: "model-not-in-plan",
				modelId: NAMED_MODEL,
			},
		]);
	});

	test("the refused account still serves a model its plan includes", async () => {
		const { storage } = storageWith(true);
		const [freeId] = await seed(storage, ["free", "paid"]);
		await refuse(storage, freeId);

		// Fresh sessions, because the move made `paid` this session's account for every model, and
		// load balancing spreads fresh sessions across accounts.
		const servedFor = async (modelId: string): Promise<Set<string | undefined>> => {
			const served = new Set<string | undefined>();
			for (const session of ["fresh-a", "fresh-b", "fresh-c", "fresh-d"]) {
				served.add(await storage.getApiKey(PROVIDER, `${modelId}-${session}`, { modelId }));
			}
			return served;
		};
		expect([...(await servedFor(NAMED_MODEL))]).toEqual(["access-paid"]);
		expect((await servedFor(OTHER_MODEL)).has("access-free")).toBe(true);
	});

	for (const loadBalancing of [false, true]) {
		const expected = loadBalancing ? "access-paid" : "access-free";
		test(`a second process reading the same store, load balancing ${loadBalancing ? "on" : "off"}, starts on ${expected}`, async () => {
			const { storage } = storageWith(loadBalancing);
			const [freeId] = await seed(storage, ["free", "paid"]);
			await refuse(storage, freeId);

			const peer = storageWith(loadBalancing).storage;
			await peer.reload();
			expect(await peer.getApiKey(PROVIDER, "a-fresh-session", { modelId: NAMED_MODEL })).toBe(expected);
		});
	}

	for (const loadBalancing of [false, true]) {
		test(`load balancing ${loadBalancing ? "on" : "off"}: with no other account the refusal reports no switch and no notice`, async () => {
			const { storage, events, withheld } = storageWith(loadBalancing);
			const [freeId] = await seed(storage, ["free"]);

			expect(await refuse(storage, freeId)).toBe(false);
			expect(events).toEqual([]);
			expect(withheld).toEqual([]);
		});
	}

	test("with every other account refused the same model the refusal reports no switch", async () => {
		const { storage, events } = storageWith(true);
		const [freeId, otherFreeId] = await seed(storage, ["free", "other-free"]);
		await refuse(storage, otherFreeId);
		const before = events.length;

		expect(await refuse(storage, freeId)).toBe(false);
		expect(events.slice(before)).toEqual([]);
	});

	test("a spent allowance with load balancing off moves nothing and is announced as quota", async () => {
		const { storage, events, withheld } = storageWith(false);
		const [freeId] = await seed(storage, ["free", "paid"]);

		const switched = await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: freeId,
			modelId: NAMED_MODEL,
			error: endStream(QUOTA_END_STREAM),
		});

		expect(switched).toBe(false);
		expect(events).toEqual([]);
		expect(withheld.map(event => event.reason)).toEqual(["quota"]);
	});
});
