/**
 * WHY: ChatGPT accounts of different tiers are listed different Codex models: a Daybreak Blue account is
 * listed models a standard account is not. Discovery lists every signed-in account and records, per
 * model, whether each account is listed it ({@link Model.accountAccess}). Credential selection read none
 * of it, so a session on a standard account sent a Daybreak-only model's turn from that account and the
 * endpoint refused it, although a signed-in Blue account could serve it.
 *
 * Class closed: an account whose listing leaves out the requested model sorts after every account that
 * may use it, with load balancing on or off, for a fresh session and for a session already on that
 * account. A plan refusal does not count such an account as an idle sibling. An account discovery did
 * not list is not excluded, and a model no account is listed is still sent from an account.
 *
 * Not caught: a credential whose stored account id differs from the id its listing was keyed by.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { type AuthCredentialStore, AuthStorage, type CredentialFailoverEvent } from "@veyyon/ai/auth-storage";
import { SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage-sqlite";
import * as oauthUtils from "@veyyon/ai/registry/oauth";
import type { ModelAccountAccess } from "@veyyon/ai/types";
import { parseConnectEndStream } from "../src/providers/cursor";

const PROVIDER = "unit-account-listing";
const SESSION_ID = "session-on-a-standard-account";
const BLUE_ONLY = "blue-only-model";
const SHARED = "shared-model";
const HOUR_MS = 60 * 60_000;
/** After any real clock, as SQLite stamps a persisted block with its own time. */
const NOW_MS = 4_000_000_000_000;

/** A plan refusal on the Cursor wire, reduced to the fields the classifier reads. */
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
						detail: "Free plans can only use Auto.",
						isRetryable: false,
					},
				},
			},
		],
	},
};

/** The listing discovery recorded: the Blue-only model is listed to the Blue account only. */
const LISTED: Record<string, Readonly<Record<string, ModelAccountAccess>>> = {
	[BLUE_ONLY]: {
		"account-standard": { listed: false },
		"account-blue": { listed: true, cyber: ["daybreak_blue"] },
	},
	[SHARED]: {
		"account-standard": { listed: true, cyber: ["standard"] },
		"account-blue": { listed: true, cyber: ["standard", "daybreak_blue"] },
	},
};

describe("an account whose listing leaves out a model is chosen for it last", () => {
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

	async function storageWith(
		loadBalancing: boolean,
		names: string[],
		listed: Record<string, Readonly<Record<string, ModelAccountAccess>>> = LISTED,
	): Promise<{ storage: AuthStorage; ids: number[]; events: CredentialFailoverEvent[] }> {
		if (!store) throw new Error("test setup failed");
		const events: CredentialFailoverEvent[] = [];
		const storage = new AuthStorage(store, { loadBalancing, onCredentialFailover: event => void events.push(event) });
		storage.setModelAccountAccessResolver((provider, modelId) =>
			provider === PROVIDER ? listed[modelId] : undefined,
		);
		await storage.set(PROVIDER, names.map(oauth));
		return { storage, ids: storage.listStoredCredentials(PROVIDER).map(row => row.id), events };
	}

	async function servedFresh(storage: AuthStorage, modelId: string): Promise<string[]> {
		const served: string[] = [];
		for (const session of ["fresh-a", "fresh-b", "fresh-c", "fresh-d"]) {
			served.push((await storage.getApiKey(PROVIDER, `${modelId}-${session}`, { modelId })) ?? "none");
		}
		return served;
	}

	/** A session the shared model was first served from `access`, so the session is on that account. */
	async function sessionOn(storage: AuthStorage, access: string): Promise<string> {
		for (const session of ["s-1", "s-2", "s-3", "s-4", "s-5", "s-6"]) {
			if ((await storage.getApiKey(PROVIDER, session, { modelId: SHARED })) === access) return session;
		}
		throw new Error(`no session was served from ${access}`);
	}

	for (const loadBalancing of [false, true]) {
		const mode = `load balancing ${loadBalancing ? "on" : "off"}`;

		test(`${mode}: every fresh session sends the model from the account listed it`, async () => {
			const { storage } = await storageWith(loadBalancing, ["standard", "blue"]);

			expect(await servedFresh(storage, BLUE_ONLY)).toEqual(Array(4).fill("access-blue"));
		});

		test(`${mode}: a session on the account its listing leaves out sends the model from the other`, async () => {
			const { storage } = await storageWith(loadBalancing, ["standard", "blue"]);
			const session = await sessionOn(storage, "access-standard");

			expect(await storage.getApiKey(PROVIDER, session, { modelId: BLUE_ONLY })).toBe("access-blue");
		});

		test(`${mode}: an account listed the model is not passed over for it`, async () => {
			const { storage } = await storageWith(loadBalancing, ["standard", "blue"]);

			expect(await servedFresh(storage, SHARED)).toContain("access-standard");
		});

		test(`${mode}: a model no account is listed is still sent from an account`, async () => {
			const { storage } = await storageWith(loadBalancing, ["standard", "other-standard"], {
				[BLUE_ONLY]: { "account-standard": { listed: false }, "account-other-standard": { listed: false } },
			});

			for (const served of await servedFresh(storage, BLUE_ONLY)) {
				expect(["access-standard", "access-other-standard"]).toContain(served);
			}
		});

		test(`${mode}: an account discovery did not list is not excluded`, async () => {
			const { storage } = await storageWith(loadBalancing, ["standard", "blue"], {
				[BLUE_ONLY]: { "account-blue": { listed: true } },
			});

			expect(await servedFresh(storage, BLUE_ONLY)).toContain("access-standard");
		});
	}

	test("a plan refusal counts no account the model's listing leaves out as an idle sibling", async () => {
		const { storage, ids, events } = await storageWith(true, ["blue", "standard"]);
		const refusal = parseConnectEndStream(new TextEncoder().encode(JSON.stringify(PLAN_REFUSAL_END_STREAM)));
		if (!refusal) throw new Error("the end stream parsed as success");
		expect(await storage.getApiKey(PROVIDER, SESSION_ID, { modelId: BLUE_ONLY })).toBe("access-blue");

		const switched = await storage.rotateSessionCredential(PROVIDER, SESSION_ID, {
			credentialId: ids[0],
			modelId: BLUE_ONLY,
			error: refusal,
		});

		expect(switched).toBe(false);
		expect(events).toEqual([]);
	});
});
