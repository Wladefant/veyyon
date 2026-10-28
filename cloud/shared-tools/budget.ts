import type {
	BudgetAuthorityBinding,
	BudgetLimits,
	BudgetNamespace,
	BudgetRefusal,
	BudgetState,
	DurableStorage,
	Reservation,
	ToolBudget,
	ToolScope,
} from "./contracts";
import { isOpaqueId } from "./ids";

/**
 * Durable, server-only tool budget.
 *
 * One Durable Object instance (`idFromName("pilot")`) holds every counter for every user and
 * scope, so the shared-total caps are enforced by a single serial transaction. Each reservation
 * runs inside `transactionSync`: duplicate check, clock read, cap check and charge commit
 * together or not at all.
 *
 * A charge is final. A refused request is not charged. A request whose response is lost after
 * commit stays charged, because the caller cannot prove the work did not happen.
 */

const TOOL_SCOPES: readonly ToolScope[] = ["fetch:public", "search:public"];
const INSTANCE_NAME = "pilot";
const RESERVE_URL = "https://budget.internal/reservations";
const RESERVE_PATH = "/reservations";
const MINUTE_MS = 60_000;
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_RETENTION_MS = AUDIT_RETENTION_MS;
const SHARED_SUBJECT = "";
const REQUEST_KEYS = ["costMicrousd", "nowMs", "requestId", "scope", "userId"];
const MAX_REQUEST_BYTES = 4096;
const BUDGET_REFUSALS: readonly BudgetRefusal[] = ["minute_limit", "month_limit", "cost_limit", "expired"];

/** Server configuration. Callers of `createToolBudget` never supply these. */
export interface BudgetAuthorityEnv {
	limits: Record<ToolScope, BudgetLimits>;
	/** Test seam for the server clock. Production omits it and uses `Date.now`. */
	now?: () => number;
}

/** Thrown by the adapter for every failure. The message is generic and carries no request data. */
export class BudgetUnavailableError extends Error {
	constructor() {
		super("tool budget unavailable");
		this.name = "BudgetUnavailableError";
	}
}

interface ReservationRequest {
	userId: string;
	scope: ToolScope;
	requestId: string;
	nowMs: number;
	costMicrousd: number;
}

type Outcome = "allowed" | "duplicate" | BudgetRefusal;
type CounterRow = { started_ms: number; requests: number; cost_microusd: number };
type ClockRow = { last_ms: number };

const EMPTY_COUNTER: CounterRow = { started_ms: 0, requests: 0, cost_microusd: 0 };

const SCHEMA: readonly string[] = [
	"CREATE TABLE IF NOT EXISTS clock (id INTEGER PRIMARY KEY CHECK (id = 1), last_ms INTEGER NOT NULL)",
	"CREATE TABLE IF NOT EXISTS seen_requests (request_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL)",
	"CREATE INDEX IF NOT EXISTS seen_requests_created_ms ON seen_requests (created_ms)",
	"CREATE TABLE IF NOT EXISTS counters (scope TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL, period TEXT NOT NULL, started_ms INTEGER NOT NULL, requests INTEGER NOT NULL, cost_microusd INTEGER NOT NULL, PRIMARY KEY (scope, subject, kind, period))",
	"CREATE TABLE IF NOT EXISTS minute_events (scope TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, created_ms INTEGER NOT NULL, PRIMARY KEY (scope, user_id, request_id))",
	"CREATE INDEX IF NOT EXISTS minute_events_created_ms ON minute_events (scope, user_id, created_ms)",
	"CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL, decision TEXT NOT NULL, created_ms INTEGER NOT NULL)",
	"CREATE INDEX IF NOT EXISTS audit_created_ms ON audit (created_ms)",
];

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isScope(value: unknown): value is ToolScope {
	return typeof value === "string" && (TOOL_SCOPES as readonly string[]).includes(value);
}

function isRefusal(value: unknown): value is BudgetRefusal {
	return typeof value === "string" && (BUDGET_REFUSALS as readonly string[]).includes(value);
}

function checkedLimits(scope: ToolScope, limits: BudgetLimits): BudgetLimits {
	const fields: unknown[] = [
		limits.minute,
		limits.month,
		limits.costMicrousd,
		limits.totalMonth,
		limits.totalCostMicrousd,
		limits.expiresAt,
	];
	if (!fields.every(isNonNegativeSafeInteger)) throw new Error(`invalid budget limits for ${scope}`);
	return Object.freeze({ ...limits });
}

async function readBoundedBody(request: Request): Promise<string | null> {
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_REQUEST_BYTES) {
				await reader.cancel();
				return null;
			}
			chunks.push(value);
		}
	} catch {
		return null;
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function parseRequest(text: string | null): ReservationRequest | null {
	if (text === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join() !== REQUEST_KEYS.join()) return null;
	const { userId, scope, requestId, nowMs, costMicrousd } = record;
	if (!isOpaqueId(userId) || !isOpaqueId(requestId)) return null;
	if (!isScope(scope)) return null;
	if (!isNonNegativeSafeInteger(nowMs) || !isNonNegativeSafeInteger(costMicrousd)) return null;
	return { userId, scope, requestId, nowMs, costMicrousd };
}

function json(body: unknown, status: number): Response {
	return Response.json(body, { status });
}

/**
 * Durable Object authority. Only the Worker binding reaches it, and it serves one route:
 * `POST /reservations`. The client-supplied `nowMs` is validated and then ignored, because
 * only the server clock may decide windows and expiry.
 */
export class SharedToolBudgetAuthority implements BudgetAuthorityBinding {
	readonly #storage: DurableStorage;
	readonly #limits: Record<ToolScope, BudgetLimits>;
	readonly #now: () => number;

	constructor(state: BudgetState, env: BudgetAuthorityEnv) {
		const limits = {} as Record<ToolScope, BudgetLimits>;
		for (const scope of TOOL_SCOPES) limits[scope] = checkedLimits(scope, env.limits[scope]);
		this.#storage = state.storage;
		this.#limits = Object.freeze(limits);
		this.#now = env.now ?? Date.now;
		this.#storage.transactionSync(() => {
			for (const statement of SCHEMA) this.#storage.sql.exec(statement);
		});
	}
	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname !== RESERVE_PATH) return json({ error: "not_found" }, 404);
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
		const parsed = parseRequest(await readBoundedBody(request));
		if (!parsed) return json({ error: "invalid_request" }, 400);
		try {
			const outcome = this.#reserve(parsed);
			await this.#scheduleAuditExpiry();
			if (outcome === "duplicate") return json({ error: "duplicate_request" }, 409);
			if (outcome === "allowed") return json({ allowed: true }, 200);
			return json({ allowed: false, reason: outcome }, 200);
		} catch {
			return json({ error: "internal_error" }, 500);
		}
	}

	async alarm(): Promise<void> {
		if (!this.#storage.setAlarm) return;
		const now = this.#now();
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("server clock out of range");
		this.#storage.transactionSync(() => {
			this.#storage.sql.exec("DELETE FROM audit WHERE created_ms < ?", now - AUDIT_RETENTION_MS);
			this.#storage.sql.exec("DELETE FROM seen_requests WHERE created_ms < ?", now - SEEN_RETENTION_MS);
			this.#storage.sql.exec("DELETE FROM minute_events WHERE created_ms <= ?", now - MINUTE_MS);
		});
		await this.#scheduleAuditExpiry();
	}

	async #scheduleAuditExpiry(): Promise<void> {
		if (!this.#storage.setAlarm) return;
		const next = this.#storage.sql.exec<{ next_ms: number | null }>(
			"SELECT MIN(created_ms) AS next_ms FROM (SELECT created_ms FROM audit UNION ALL SELECT created_ms FROM seen_requests)",
		).toArray()[0]?.next_ms;
		if (next !== null && next !== undefined) await this.#storage.setAlarm(next + AUDIT_RETENTION_MS + 1);
	}

	#reserve(request: ReservationRequest): Outcome {
		return this.#storage.transactionSync(() => {
			const sql = this.#storage.sql;
			if (sql.exec("SELECT 1 AS found FROM seen_requests WHERE request_id = ?", request.requestId).toArray().length > 0) {
				return "duplicate";
			}
			const now = this.#clock();
			sql.exec("INSERT INTO seen_requests (request_id, created_ms) VALUES (?, ?)", request.requestId, now);
			const outcome = this.#decide(request, now);
			sql.exec(
				"INSERT INTO audit (request_id, user_id, scope, decision, created_ms) VALUES (?, ?, ?, ?, ?)",
				request.requestId,
				request.userId,
				request.scope,
				outcome,
				now,
			);
			sql.exec("DELETE FROM audit WHERE created_ms < ?", now - AUDIT_RETENTION_MS);
			sql.exec("DELETE FROM seen_requests WHERE created_ms < ?", now - SEEN_RETENTION_MS);
			return outcome;
		});
	}

	/** Server clock, clamped so it never moves backwards. A rewound clock cannot reopen a window. */
	#clock(): number {
		const sql = this.#storage.sql;
		const raw = this.#now();
		if (!Number.isSafeInteger(raw) || raw < 0) throw new Error("server clock out of range");
		const last = sql.exec<ClockRow>("SELECT last_ms FROM clock WHERE id = 1").toArray()[0]?.last_ms ?? 0;
		const now = Math.max(raw, last);
		sql.exec(
			"INSERT INTO clock (id, last_ms) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_ms = excluded.last_ms",
			now,
		);
		return now;
	}

	#decide(request: ReservationRequest, now: number): Outcome {
		const limits = this.#limits[request.scope];
		if (now >= limits.expiresAt) return "expired";

		const month = new Date(now).toISOString().slice(0, 7);
		const sql = this.#storage.sql;
		sql.exec("DELETE FROM minute_events WHERE created_ms <= ?", now - MINUTE_MS);
		const minuteUsed = sql.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM minute_events WHERE scope = ? AND user_id = ? AND created_ms > ?",
			request.scope,
			request.userId,
			now - MINUTE_MS,
		).toArray()[0]?.n ?? 0;
		const userMonth = this.#counter(request.scope, request.userId, "user_month", month);
		const shared = this.#counter(request.scope, SHARED_SUBJECT, "shared_month", month);

		if (minuteUsed >= limits.minute) return "minute_limit";
		if (userMonth.requests >= limits.month || shared.requests >= limits.totalMonth) return "month_limit";
		const costRoom = Math.min(
			limits.costMicrousd - userMonth.cost_microusd,
			limits.totalCostMicrousd - shared.cost_microusd,
		);
		if (request.costMicrousd > costRoom) return "cost_limit";

		sql.exec(
			"INSERT INTO minute_events (scope, user_id, request_id, created_ms) VALUES (?, ?, ?, ?)",
			request.scope,
			request.userId,
			request.requestId,
			now,
		);
		this.#write(request.scope, request.userId, "user_month", month, {
			started_ms: now,
			requests: userMonth.requests + 1,
			cost_microusd: userMonth.cost_microusd + request.costMicrousd,
		});
		this.#write(request.scope, SHARED_SUBJECT, "shared_month", month, {
			started_ms: now,
			requests: shared.requests + 1,
			cost_microusd: shared.cost_microusd + request.costMicrousd,
		});
		return "allowed";
	}
	#counter(scope: ToolScope, subject: string, kind: string, period: string): CounterRow {
		return (
			this.#storage.sql
				.exec<CounterRow>(
					"SELECT started_ms, requests, cost_microusd FROM counters WHERE scope = ? AND subject = ? AND kind = ? AND period = ?",
					scope,
					subject,
					kind,
					period,
				)
				.toArray()[0] ?? EMPTY_COUNTER
		);
	}

	#write(scope: ToolScope, subject: string, kind: string, period: string, row: CounterRow): void {
		this.#storage.sql.exec(
			"INSERT INTO counters (scope, subject, kind, period, started_ms, requests, cost_microusd) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, subject, kind, period) DO UPDATE SET started_ms = excluded.started_ms, requests = excluded.requests, cost_microusd = excluded.cost_microusd",
			scope,
			subject,
			kind,
			period,
			row.started_ms,
			row.requests,
			row.cost_microusd,
		);
	}
}

function parseReservation(value: unknown): Reservation {
	if (typeof value !== "object" || value === null) throw new BudgetUnavailableError();
	const record = value as Record<string, unknown>;
	if (record.allowed === true) return { allowed: true };
	if (record.allowed === false && isRefusal(record.reason)) return { allowed: false, reason: record.reason };
	throw new BudgetUnavailableError();
}

/**
 * Server-side `ToolBudget` for one scope and caller request. The request ID is opaque and
 * stable across retries; the authority derives a private reservation ID from user, scope and ID.
 * A transport failure, non-200 status or malformed body throws, and the call is never retried.
 */
export function createToolBudget(
	namespace: BudgetNamespace,
	scope: ToolScope,
	clientRequestId: string,
): ToolBudget {
	if (!isOpaqueId(clientRequestId)) throw new BudgetUnavailableError();
	const id = namespace.idFromName(INSTANCE_NAME);
	return {
		async reserve(userId: string, _clientNowMs: number, costMicrousd: number): Promise<Reservation> {
			if (!isOpaqueId(userId) || !isNonNegativeSafeInteger(costMicrousd)) throw new BudgetUnavailableError();
			const requestId = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(JSON.stringify([userId, scope, clientRequestId])),
			);
			const body: ReservationRequest = {
				userId,
				scope,
				requestId: [...new Uint8Array(requestId)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
				nowMs: Date.now(),
				costMicrousd,
			};
			let response: Response;
			try {
				response = await namespace.get(id).fetch(
					new Request(RESERVE_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
				);
			} catch {
				throw new BudgetUnavailableError();
			}
			if (response.status !== 200) throw new BudgetUnavailableError();
			return parseReservation(await response.json().catch(() => null));
		},
	};
}
