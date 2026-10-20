import { createAdmission, type AdmissionConfig, type ResolvedKey } from "./admission";
import { createToolBudget } from "./budget";
import type { AdmissionIdentity, AdmissionPolicy, BudgetNamespace, ToolScope } from "./contracts";

export interface ToolContext {
	identity: AdmissionIdentity;
	braveKey: ResolvedKey | null;
}
export interface SharedToolsConfig {
	policy: AdmissionPolicy;
	authentication: AdmissionConfig;
	budget: BudgetNamespace;
	/** Trusted bounded tool implementations, not a caller-selected proxy target. */
	tools: Record<ToolScope, (request: Request, context: ToolContext) => Promise<Response>>;
}

const ROUTES = { "/tools/fetch": "fetch:public", "/tools/search": "search:public" } satisfies Record<string, ToolScope>;
const MAX_BODY_BYTES = 64 * 1024;
const BODY_DEADLINE_MS = 2_000;

// WHY: an unbounded arrayBuffer lets one caller hold memory and a dispatch slot for as long as it
// likes. The body is read before reservation, so an oversized or stalled body never spends budget.
// The reader is cancelled on every early exit so the caller's connection is released, and the
// refusal carries a generic error, never the stream's own error text.
async function readBoundedBody(request: Request): Promise<Uint8Array | Response> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isSafeInteger(declared) && declared > MAX_BODY_BYTES) {
		void request.body?.cancel().catch(() => {});
		return Response.json({ error: "payload_too_large" }, { status: 413 });
	}
	const stream = request.body;
	if (stream === null) return new Uint8Array(0);
	const reader = stream.getReader();
	const { promise: expired, resolve } = Promise.withResolvers<Response>();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void reader.cancel().catch(() => {});
		resolve(Response.json({ error: "request_timeout" }, { status: 408 }));
	}, BODY_DEADLINE_MS);
	const consume = async (): Promise<Uint8Array | Response> => {
		const bytes = new Uint8Array(MAX_BODY_BYTES);
		let length = 0;
		try {
			while (!timedOut) {
				const next = await reader.read();
				if (next.done) return bytes.subarray(0, length);
				if (length + next.value.byteLength > MAX_BODY_BYTES) {
					void reader.cancel().catch(() => {});
					return Response.json({ error: "payload_too_large" }, { status: 413 });
				}
				bytes.set(next.value, length);
				length += next.value.byteLength;
			}
			return Response.json({ error: "request_timeout" }, { status: 408 });
		} catch {
			void reader.cancel().catch(() => {});
			return Response.json({ error: "invalid_request" }, { status: 400 });
		}
	};
	try {
		return await Promise.race([consume(), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** The only HTTP surface is scoped discovery and the two public tool calls. */
export function createSharedToolsWorker(config: SharedToolsConfig): { fetch(request: Request): Promise<Response> } {
	const admission = createAdmission(config.policy, config.authentication);
	const budgets = {
		"fetch:public": createToolBudget(config.budget, "fetch:public"),
		"search:public": createToolBudget(config.budget, "search:public"),
	};
	return {
		async fetch(request: Request): Promise<Response> {
			try {
				const path = new URL(request.url).pathname;
				if (path === "/tools" && request.method === "GET") {
					const scopes = await admission.discover(request);
					return scopes.length ? Response.json({ tools: scopes }) : Response.json({ error: "forbidden" }, { status: 403 });
				}
				const scope = ROUTES[path as keyof typeof ROUTES];
				if (!scope) return Response.json({ error: "not_found" }, { status: 404 });
				if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
				const identity = await admission.authorize(request, scope);
				if (!identity) return Response.json({ error: "forbidden" }, { status: 403 });
				const body = await readBoundedBody(request);
				if (body instanceof Response) return body;
				const braveKey = scope === "search:public" ? await admission.resolveBraveKey(identity) : null;
				if (scope === "search:public" && !braveKey) return Response.json({ error: "unavailable" }, { status: 503 });
				const cost = scope === "fetch:public" ? 0 : braveKey!.costMicrousdPerRequest;
				const reserved = await budgets[scope].reserve(identity.userId, Date.now(), cost);
				if (!reserved.allowed) return Response.json({ error: "budget_refused", reason: reserved.reason }, { status: 429 });
				// The reservation awaited a network hop. Admission can change during it: the global switch,
				// the device, the user, the scope or the key binding. Re-admit the same device and user, and
				// re-resolve the key at its live cost. A refusal here does not refund the charge: it is final.
				const admitted = await admission.authorize(request, scope);
				if (!admitted || admitted.userId !== identity.userId || admitted.deviceId !== identity.deviceId) {
					return Response.json({ error: "forbidden" }, { status: 403 });
				}
				const dispatchKey = scope === "search:public" ? await admission.resolveBraveKey(identity) : null;
				if (scope === "search:public" && (dispatchKey === null || dispatchKey.costMicrousdPerRequest !== braveKey?.costMicrousdPerRequest)) {
					return Response.json({ error: "forbidden" }, { status: 403 });
				}
				// Do not give tool implementations the device credentials or caller identity headers.
				const cleanRequest = new Request(`https://tools.internal${path}`, {
					method: "POST",
					headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
					body,
				});
				return await config.tools[scope](cleanRequest, { identity, braveKey: dispatchKey });
			} catch {
				// A lost budget response can mean a committed reservation. Never retry or refund.
				return Response.json({ error: "unavailable" }, { status: 503 });
			}
		},
	};
}
