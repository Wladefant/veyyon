import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BudgetAuthorityBinding,
	BudgetLimits,
	BudgetNamespace,
	DurableStorage,
	SqlCursor,
	SqlStorage,
	ToolScope,
} from "./contracts";
import { BudgetUnavailableError, SharedToolBudgetAuthority, createToolBudget } from "./budget";

// WHY: the budget must survive a restart and enforce quotas exactly, because a lost counter
// or an off-by-one cap lets a user spend past the pilot's money limit. These tests run the real
// authority over a real bun:sqlite file, so a reopen proves the durable state, not a fake.

const FAR_FUTURE = Date.UTC(2100, 0, 1);
const T0 = Date.UTC(2026, 9, 1); // 2026-10-01T00:00:00Z
const DAY_MS = 24 * 60 * 60 * 1000;
const ENDPOINT = "https://budget.internal/reservations";
const ALLOWED = { status: 200, json: { allowed: true } };

const LIMITS: Record<ToolScope, BudgetLimits> = {
	"fetch:public": {
		minute: 10,
		month: 1000,
		costMicrousd: 1_000_000_000,
		totalMonth: 1000,
		totalCostMicrousd: 1_000_000_000,
		expiresAt: FAR_FUTURE,
	},
	"search:public": {
		minute: 5,
		month: 500,
		costMicrousd: 2_500_000,
		totalMonth: 500,
		totalCostMicrousd: 2_500_000,
		expiresAt: FAR_FUTURE,
	},
};

const tempRoot = mkdtempSync(join(tmpdir(), "tool-budget-"));
let fileCount = 0;
const freshPath = (): string => join(tempRoot, `budget-${fileCount++}.sqlite`);
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

interface Store {
	db: Database;
	alarms: number[];
	storage: DurableStorage;
	close(): void;
}

function openStore(path: string): Store {
	const db = new Database(path, { create: true });
	let closed = false;
	const alarms: number[] = [];
	const sql: SqlStorage = {
		exec<T extends Record<string, unknown> = Record<string, unknown>>(
			query: string,
			...bindings: (string | number | null)[]
		): SqlCursor<T> {
			const statement = db.query(query);
			if (statement.columnNames.length > 0) {
				const rows = statement.all(...bindings) as T[];
				return { toArray: () => rows };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	};
	return {
		db,
		alarms,
		storage: {
			sql,
			transactionSync: <T>(callback: () => T): T => db.transaction(callback)(),
			setAlarm: async (date: number): Promise<void> => {
				alarms.push(date);
			},
		},
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

type Clock = { now: number };

function startAuthority(
	path: string,
	clock: Clock,
	limits: Record<ToolScope, BudgetLimits> = LIMITS,
): { store: Store; authority: SharedToolBudgetAuthority } {
	const store = openStore(path);
	opened.push(store);
	const authority = new SharedToolBudgetAuthority({ storage: store.storage }, { limits, now: () => clock.now });
	return { store, authority };
}

interface Body {
	userId: string;
	scope: ToolScope;
	requestId: string;
	nowMs: number;
	costMicrousd: number;
}

function body(userId: string, overrides: Partial<Body> = {}): Body {
	return {
		userId,
		scope: "fetch:public",
		requestId: crypto.randomUUID(),
		nowMs: 0,
		costMicrousd: 1000,
		...overrides,
	};
}

async function send(
	authority: BudgetAuthorityBinding,
	payload: unknown,
	method = "POST",
): Promise<{ status: number; json: unknown }> {
	const response = await authority.fetch(
		new Request(ENDPOINT, {
			method,
			headers: { "content-type": "application/json" },
			body: method === "POST" ? JSON.stringify(payload) : undefined,
		}),
	);
	return { status: response.status, json: await response.json() };
}

const refused = (reason: string) => ({ status: 200, json: { allowed: false, reason } });

describe("SharedToolBudgetAuthority survives restart and enforces quotas", () => {
	test("minute quota spent before a restart stays spent after the database reopens", async () => {
		const path = freshPath();
		const clock: Clock = { now: T0 };
		let current = startAuthority(path, clock);
		for (let i = 0; i < 10; i++) expect(await send(current.authority, body("user-a"))).toEqual(ALLOWED);
		current.store.close();

		current = startAuthority(path, clock);
		expect(await send(current.authority, body("user-a"))).toEqual(refused("minute_limit"));
	});

	test("monthly quota is exact across a restart and resets at the UTC month boundary", async () => {
		const clock: Clock = { now: T0 };
		const path = freshPath();
		let current = startAuthority(path, clock);
		// One request per minute keeps the minute quota out of the way.
		for (let i = 0; i < 600; i++) {
			clock.now = T0 + i * 60_000;
			expect(await send(current.authority, body("user-a"))).toEqual(ALLOWED);
		}
		current.store.close();
		current = startAuthority(path, clock);
		for (let i = 600; i < 1000; i++) {
			clock.now = T0 + i * 60_000;
			expect(await send(current.authority, body("user-a"))).toEqual(ALLOWED);
		}
		clock.now = T0 + 1000 * 60_000;
		expect(await send(current.authority, body("user-a"))).toEqual(refused("month_limit"));

		clock.now = Date.UTC(2026, 10, 1, 0, 0, 0);
		expect(await send(current.authority, body("user-a"))).toEqual(ALLOWED);
	}, 60_000);

	test("one user's exhausted quota does not block another user", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		for (let i = 0; i < 10; i++) await send(authority, body("user-a"));
		expect(await send(authority, body("user-a"))).toEqual(refused("minute_limit"));
		expect(await send(authority, body("user-b"))).toEqual(ALLOWED);
	});

	test("the shared monthly total caps all users together", async () => {
		const clock: Clock = { now: T0 };
		const limits = {
			...LIMITS,
			"fetch:public": { ...LIMITS["fetch:public"], totalMonth: 3 },
		};
		const { authority } = startAuthority(freshPath(), clock, limits);
		expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		expect(await send(authority, body("user-b"))).toEqual(ALLOWED);
		expect(await send(authority, body("user-c"))).toEqual(ALLOWED);
		expect(await send(authority, body("user-d"))).toEqual(refused("month_limit"));
		expect(await send(authority, body("user-a"))).toEqual(refused("month_limit"));
	});

	test("cost caps are exact per user and shared", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		expect(await send(authority, body("user-a", { scope: "search:public", costMicrousd: 1_000_000 }))).toEqual(
			ALLOWED,
		);
		expect(await send(authority, body("user-a", { scope: "search:public", costMicrousd: 1_500_000 }))).toEqual(
			ALLOWED,
		);
		expect(await send(authority, body("user-a", { scope: "search:public", costMicrousd: 1 }))).toEqual(
			refused("cost_limit"),
		);
		// The shared cost total is now exactly at its cap, so another user is refused too.
		expect(await send(authority, body("user-b", { scope: "search:public", costMicrousd: 1 }))).toEqual(
			refused("cost_limit"),
		);
	});

	test("a duplicate requestId is refused and charges nothing extra", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		const requestId = crypto.randomUUID();
		expect(await send(authority, body("user-a", { requestId }))).toEqual(ALLOWED);
		expect(await send(authority, body("user-a", { requestId }))).toEqual({
			status: 409,
			json: { error: "duplicate_request" },
		});
		expect(await send(authority, body("user-b", { requestId }))).toEqual({
			status: 409,
			json: { error: "duplicate_request" },
		});
		for (let i = 0; i < 9; i++) expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		expect(await send(authority, body("user-a"))).toEqual(refused("minute_limit"));
	});

	test("the minute window reopens exactly 60 seconds after its first request", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		for (let i = 0; i < 10; i++) expect(await send(authority, body("user-a", { nowMs: 0 }))).toEqual(ALLOWED);
		clock.now = T0 + 59_999;
		// The client-supplied nowMs is ignored: sending the old time does not reopen the window.
		expect(await send(authority, body("user-a", { nowMs: T0 + 60_000 }))).toEqual(refused("minute_limit"));
		clock.now = T0 + 60_000;
		expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
	});

	test("a rolling minute window frees each slot when its own request ages out", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		clock.now = T0 + 59_000;
		for (let i = 0; i < 9; i++) expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		// The request at T0 ages out at T0 + 60s: one slot opens, and the nine at T0 + 59s still count.
		clock.now = T0 + 60_000;
		expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		expect(await send(authority, body("user-a"))).toEqual(refused("minute_limit"));
		// The nine requests at T0 + 59s age out at T0 + 119s; the grant at T0 + 60s still holds one slot.
		clock.now = T0 + 119_000;
		for (let i = 0; i < 9; i++) expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		expect(await send(authority, body("user-a"))).toEqual(refused("minute_limit"));
	});

	test("a rewound server clock cannot reopen a spent minute window, even after a restart", async () => {
		const path = freshPath();
		const clock: Clock = { now: T0 + 120_000 };
		let current = startAuthority(path, clock);
		for (let i = 0; i < 10; i++) await send(current.authority, body("user-a"));
		clock.now = T0 + 60_000;
		expect(await send(current.authority, body("user-a"))).toEqual(refused("minute_limit"));

		current.store.close();
		clock.now = T0;
		current = startAuthority(path, clock);
		expect(await send(current.authority, body("user-a"))).toEqual(refused("minute_limit"));
	});

	test("limits expire on the server clock", async () => {
		const clock: Clock = { now: T0 };
		const limits = {
			...LIMITS,
			"fetch:public": { ...LIMITS["fetch:public"], expiresAt: T0 + 5_000 },
		};
		const { authority } = startAuthority(freshPath(), clock, limits);
		clock.now = T0 + 4_999;
		expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		clock.now = T0 + 5_000;
		expect(await send(authority, body("user-a"))).toEqual(refused("expired"));
	});

	test("concurrent reservations grant exactly the quota", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		const results = await Promise.all(Array.from({ length: 15 }, () => send(authority, body("user-a"))));
		const granted = results.filter((result) => JSON.stringify(result) === JSON.stringify(ALLOWED));
		expect(granted).toHaveLength(10);
		expect(results.filter((result) => JSON.stringify(result) === JSON.stringify(refused("minute_limit")))).toHaveLength(5);
	});

	test("a reservation whose response is lost after commit stays charged", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		const names: string[] = [];
		let calls = 0;
		const namespace: BudgetNamespace = {
			idFromName: (name: string) => {
				names.push(name);
				return name;
			},
			get: () => ({
				async fetch(request: Request): Promise<Response> {
					calls++;
					const response = await authority.fetch(request);
					if (calls === 1) throw new TypeError("connection reset after commit");
					return response;
				},
			}),
		};
		const budget = createToolBudget(namespace, "fetch:public", "lost-response");

		await expect(budget.reserve("user-a", 0, 1000)).rejects.toBeInstanceOf(BudgetUnavailableError);
		expect(calls).toBe(1);
		expect(names).toEqual(["pilot"]);
		await expect(budget.reserve("user-a", 0, 1000)).rejects.toBeInstanceOf(BudgetUnavailableError);
		for (let i = 0; i < 9; i++) {
			expect(await createToolBudget(namespace, "fetch:public", `fresh-request-${i}`).reserve("user-a", 0, 1000)).toEqual({
				allowed: true,
			});
		}
		expect(await createToolBudget(namespace, "fetch:public", "over-limit").reserve("user-a", 0, 1000)).toEqual({
			allowed: false,
			reason: "minute_limit",
		});
	});

	test("malformed requests get generic errors and charge nothing", async () => {
		const clock: Clock = { now: T0 };
		const { authority } = startAuthority(freshPath(), clock);
		const invalid: unknown[] = [
			body("bad id!"),
			body("user-a", { scope: "admin" as ToolScope }),
			body("user-a", { costMicrousd: -1 }),
			body("user-a", { costMicrousd: 1.5 }),
			{ ...body("user-a"), extra: true },
			{ userId: "user-a", scope: "fetch:public", requestId: "r1", costMicrousd: 1 },
		];
		for (const payload of invalid) {
			expect(await send(authority, payload)).toEqual({ status: 400, json: { error: "invalid_request" } });
		}
		expect(await send(authority, body("user-a"), "GET")).toEqual({
			status: 405,
			json: { error: "method_not_allowed" },
		});
		for (let i = 0; i < 10; i++) expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		expect(await send(authority, body("user-a"))).toEqual(refused("minute_limit"));
	});

	test("audit rows older than seven days are removed and never hold URLs", async () => {
		const clock: Clock = { now: T0 };
		const { store, authority } = startAuthority(freshPath(), clock);
		for (let i = 0; i < 3; i++) await send(authority, body("user-a"));
		clock.now = T0 + 8 * 24 * 60 * 60 * 1000;
		await send(authority, body("user-a"));
		const count = store.db.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
		expect(count.n).toBe(1);
		const columns = (store.db.query("PRAGMA table_info(audit)").all() as { name: string }[]).map((c) => c.name);
		expect(columns.sort()).toEqual(["created_ms", "decision", "id", "request_id", "scope", "user_id"]);
	});

	test("invalid limits fail at construction", () => {
		const store = openStore(freshPath());
		opened.push(store);
		const invalid = {
			...LIMITS,
			"fetch:public": { ...LIMITS["fetch:public"], minute: -1 },
		};
		expect(() => new SharedToolBudgetAuthority({ storage: store.storage }, { limits: invalid, now: () => T0 })).toThrow(
			"invalid budget limits for fetch:public",
		);
	});

	test("the alarm deletes expired audit rows without a reserve, and the spend stays charged", async () => {
		const clock: Clock = { now: T0 };
		const limits = {
			...LIMITS,
			"fetch:public": { ...LIMITS["fetch:public"], month: 3 },
		};
		const path = freshPath();
		const first = startAuthority(path, clock, limits);
		for (let i = 0; i < 3; i++) expect(await send(first.authority, body("user-a"))).toEqual(ALLOWED);
		expect(first.store.alarms).toEqual([T0 + 7 * DAY_MS + 1, T0 + 7 * DAY_MS + 1, T0 + 7 * DAY_MS + 1]);
		first.store.close();

		const reopened = startAuthority(path, clock, limits);
		clock.now = T0 + 7 * DAY_MS + 1;
		await reopened.authority.alarm();
		const audit = reopened.store.db.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
		expect(audit.n).toBe(0);
		// The monthly counter survived the restart and the audit purge: the fourth request is refused.
		expect(await send(reopened.authority, body("user-a"))).toEqual(refused("month_limit"));
	});

	test("the alarm is scheduled for seven days after the oldest audit row, and repeated alarms change nothing", async () => {
		const clock: Clock = { now: T0 };
		const { store, authority } = startAuthority(freshPath(), clock);
		expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		expect(store.alarms.at(-1)).toBe(T0 + 7 * DAY_MS + 1);

		clock.now = T0 + DAY_MS;
		expect(await send(authority, body("user-a"))).toEqual(ALLOWED);
		// A newer audit row does not move the schedule: the oldest row still sets it.
		expect(store.alarms.at(-1)).toBe(T0 + 7 * DAY_MS + 1);

		clock.now = T0 + 7 * DAY_MS + 1;
		await authority.alarm();
		// The T0 row is purged; the schedule moves to the next oldest row, at T0 + 1 day.
		expect(store.alarms.at(-1)).toBe(T0 + 8 * DAY_MS + 1);
		expect(store.db.query("SELECT created_ms FROM audit ORDER BY created_ms").all()).toEqual([
			{ created_ms: T0 + DAY_MS },
		]);

		await authority.alarm();
		expect(store.alarms.at(-1)).toBe(T0 + 8 * DAY_MS + 1);
		expect(store.db.query("SELECT created_ms FROM audit ORDER BY created_ms").all()).toEqual([
			{ created_ms: T0 + DAY_MS },
		]);
	});

	// WHY: seen_requests holds one row per request ID forever unless pruned, so a steady caller grows
	// the Durable Object without bound. Retention matches the audit trail; a fresh ID is still a duplicate.
	test("seen request IDs older than seven days are pruned on reserve, and fresh ones still reject a replay", async () => {
		const clock: Clock = { now: T0 };
		const { store, authority } = startAuthority(freshPath(), clock);
		const old = body("user-a", { requestId: "old-request" });
		expect(await send(authority, old)).toEqual(ALLOWED);
		clock.now = T0 + DAY_MS;
		const fresh = body("user-a", { requestId: "fresh-request" });
		expect(await send(authority, fresh)).toEqual(ALLOWED);

		clock.now = T0 + 7 * DAY_MS + 1;
		const trigger = body("user-a", { requestId: "trigger-request" });
		expect(await send(authority, trigger)).toEqual(ALLOWED);
		expect(store.db.query("SELECT request_id FROM seen_requests ORDER BY created_ms").all()).toEqual([
			{ request_id: "fresh-request" },
			{ request_id: "trigger-request" },
		]);
		expect(await send(authority, fresh)).toEqual({ status: 409, json: { error: "duplicate_request" } });
	});

	test("the alarm prunes seen request IDs on its own and schedules itself for them", async () => {
		const clock: Clock = { now: T0 };
		const { store, authority } = startAuthority(freshPath(), clock);
		expect(await send(authority, body("user-a", { requestId: "old-request" }))).toEqual(ALLOWED);
		store.db.query("DELETE FROM audit").run();
		await authority.alarm();
		// Only the seen row remains, and it alone sets the next wake-up.
		expect(store.alarms.at(-1)).toBe(T0 + 7 * DAY_MS + 1);

		clock.now = T0 + 7 * DAY_MS + 1;
		await authority.alarm();
		expect(store.db.query("SELECT COUNT(*) AS n FROM seen_requests").get()).toEqual({ n: 0 });
	});

	// WHY: admission, the Worker and the authority once carried separate id rules, so a user that
	// admission accepted could be one the budget refused (or the reverse). They share ids.ts now.
	test("a user ID outside the shared opaque form is refused by the authority and by the client", async () => {
		const { authority } = startAuthority(freshPath(), { now: T0 });
		for (const userId of ["", "has space", "-leading-dash", "a".repeat(129), "user/a", "usér"]) {
			expect(await send(authority, body(userId))).toEqual({ status: 400, json: { error: "invalid_request" } });
			await expect(
				createToolBudget({ idFromName: () => "id", get: () => authority }, "fetch:public", "req-1").reserve(
					userId,
					T0,
					0,
				),
			).rejects.toBeInstanceOf(BudgetUnavailableError);
		}
	});
});
