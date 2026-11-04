import { createPublicFetchService, type PublicFetchAdmission } from "./public-fetch";
import type { PublicFetchTransport } from "./public-fetch-transport";

/**
 * Worker-compatible HTTP boundary for the public fetch service.
 *
 * WHY: the service trusts the userId it is given. An HTTP caller must never
 * name that userId. This handler takes the identity only from `authorize`,
 * which the host supplies and which reads the request's credentials. A header,
 * a query parameter or a body field can never set the identity, because the
 * handler never reads them for that purpose.
 *
 * Every refusal is a fixed status with a fixed message. The body never echoes
 * the supplied URL, a credential or an upstream error. One deadline covers
 * authorization and the service, so a stalled dependency settles the call.
 *
 * LIMITATIONS:
 * - The handler owns no quota, no counter and no credential store. The caller
 *   supplies `authorize` and `admission`. Neither is implemented here.
 * - Without `transport`, the service dials through the Node TLS transport.
 *   A runtime without `node:net` and `node:tls` must inject a transport.
 * - The deadline cannot interrupt synchronous CPU work inside the service.
 * - The 504 for a deadline is the handler's own response. The 429 for an
 *   admission denial is detected by the service's exact message, so a change
 *   to that message needs an edit here.
 */

export interface PublicFetchIdentity {
	userId: string;
}

/**
 * Decides who the caller is from the request. Returns `null` for an
 * unauthenticated caller. A thrown error also denies the request.
 */
export type PublicFetchAuthorize = (request: Request, scope: "fetch:public") => Promise<PublicFetchIdentity | null>;

export interface PublicFetchHandlerDeps {
	authorize: PublicFetchAuthorize;
	admission: PublicFetchAdmission;
	/** Defaults to the pinned Node TLS transport. */
	transport?: PublicFetchTransport;
	/** Whole-request deadline in milliseconds. Above 0 and at most 15000. Defaults to 15000. */
	timeoutMs?: number;
}

export type PublicFetchHandler = (request: Request) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 15_000;
const FORBIDDEN = "forbidden";
const BAD_URL = "url must appear exactly once and must be an https URL";
const QUOTA_EXHAUSTED = "public fetch quota exhausted";
const TIMED_OUT = "public fetch timed out";
const FAILED = "public fetch failed";
/** The service's own deadline message. Matched whole, never as a substring. */
const SERVICE_DEADLINE = /^public fetch exceeded its [0-9]+ ms deadline$/;
/** The service's admission denial message. Matched whole. */
const ADMISSION_DENIED = "public fetch admission was denied";
const NO_STORE_JSON = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

class Refusal extends Error {
	readonly status: number;
	readonly headers: Record<string, string>;

	constructor(status: number, message: string, headers: Record<string, string> = {}) {
		super(message);
		this.status = status;
		this.headers = headers;
	}
}

/**
 * Builds the HTTP handler. The authorize function and the admission object are
 * required. The handler fails closed at creation when either is missing.
 */
export function createPublicFetchHandler(deps: PublicFetchHandlerDeps): PublicFetchHandler {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!(timeoutMs > 0 && timeoutMs <= DEFAULT_TIMEOUT_MS)) {
		throw new Error(`public fetch timeout must be above 0 and at most ${DEFAULT_TIMEOUT_MS} ms`);
	}
	if (typeof deps.authorize !== "function") throw new Error("public fetch handler needs an authorize function");
	if (!deps.admission || typeof deps.admission.reserve !== "function") {
		throw new Error("public fetch handler needs an admission object");
	}
	const { authorize, admission, transport } = deps;
	return async (request) => {
		const deadlineAt = performance.now() + timeoutMs;
		try {
			return await untilDeadline(timeoutMs, serve(request, { authorize, admission, transport }, deadlineAt));
		} catch (error) {
			const refusal = refusalFor(error);
			return new Response(JSON.stringify({ error: refusal.message }), {
				status: refusal.status,
				headers: { ...refusal.headers, ...NO_STORE_JSON },
			});
		}
	};
}

interface Collaborators {
	authorize: PublicFetchAuthorize;
	admission: PublicFetchAdmission;
	transport: PublicFetchTransport | undefined;
}

/** Method, then authorization, then the URL, then the service. Authorization precedes URL parsing. */
async function serve(request: Request, deps: Collaborators, deadlineAt: number): Promise<Response> {
	if (request.method !== "GET") throw new Refusal(405, "method not allowed", { allow: "GET" });
	const userId = await authorizeCaller(request, deps.authorize);
	const url = targetOf(request);
	// The service gets the time that is left, so its own timer ends at the same deadline.
	const remaining = Math.floor(deadlineAt - performance.now());
	if (remaining < 1) throw new Refusal(504, TIMED_OUT);
	const service = createPublicFetchService({
		admission: deps.admission,
		timeoutMs: remaining,
		...(deps.transport === undefined ? {} : { transport: deps.transport }),
	});
	const result = await service.fetchPublic(userId, url);
	return new Response(JSON.stringify(result), { status: 200, headers: NO_STORE_JSON });
}

/** Returns the authorized user id. Every null, missing, empty or thrown outcome denies. */
async function authorizeCaller(request: Request, authorize: PublicFetchAuthorize): Promise<string> {
	let identity: PublicFetchIdentity | null | undefined;
	try {
		identity = await authorize(request, "fetch:public");
	} catch {
		throw new Refusal(403, FORBIDDEN);
	}
	const userId = identity?.userId;
	if (typeof userId !== "string" || userId === "") throw new Refusal(403, FORBIDDEN);
	return userId;
}

/** Reads the single `url` parameter. A missing, repeated, empty or non-https value is a 400. */
function targetOf(request: Request): string {
	const values = new URL(request.url).searchParams.getAll("url");
	const value = values[0];
	if (values.length !== 1 || value === undefined || !isHttpsUrl(value)) throw new Refusal(400, BAD_URL);
	return value;
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

/** Maps any failure to a fixed refusal. Nothing from the failure's message reaches the response except the two exact matches. */
function refusalFor(error: unknown): Refusal {
	if (error instanceof Refusal) return error;
	if (error instanceof Error) {
		if (SERVICE_DEADLINE.test(error.message)) return new Refusal(504, TIMED_OUT);
		if (error.message === ADMISSION_DENIED) return new Refusal(429, QUOTA_EXHAUSTED);
	}
	return new Refusal(502, FAILED);
}

/** Settles the call at its deadline, even when authorize or the service never returns. */
async function untilDeadline<T>(ms: number, work: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(() => deadline.reject(new Refusal(504, TIMED_OUT)), ms);
	try {
		return await Promise.race([work, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}
