import * as crypto from "node:crypto";
import { type AgentKind, type AgentRef, AgentRegistry, type AgentStatus } from "../registry/agent-registry";
import { IrcBus, type IrcDeliveryReceipt } from "../task/irc-bus";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_RESULT_CHARS = 16_000;

export interface NativeControlBinding {
	authToken: string;
	actorId: string;
	chatId: string;
	sessionId: string;
}

export interface NativeControlAuth {
	authToken: string;
	actorId: string;
	chatId: string;
	sessionId: string;
}

export interface AgentListRequest extends NativeControlAuth {
	cursor?: string;
	limit?: number;
}

export interface AgentDetailRequest extends NativeControlAuth {
	agentId: string;
}

export interface WorkerRosterRequest extends NativeControlAuth {}

export interface SendWorkerMessageRequest extends NativeControlAuth {
	to: string;
	message: string;
}

export interface WorkerMessageReceipt {
	to: string;
	outcome: IrcDeliveryReceipt["outcome"];
	error?: string;
	formatted: string;
}

export interface NativeAgentSummary {
	id: string;
	name: string;
	status: AgentRef["status"];
	summary?: string;
	updatedAt: number;
	kind?: AgentRef["kind"];
	model?: string;
}

export interface NativeAgentDetail extends NativeAgentSummary {
	progress?: string;
	result?: string;
}

export interface NativeSessionIdentity {
	id: string;
	actorId: string;
	chatId: string;
}

export interface NativeControlBridgeOptions {
	binding: NativeControlBinding;
	registry?: AgentRegistry;
	bus?: IrcBus;
	now?: () => number;
}

export class NativeControlDeniedError extends Error {
	constructor(
		readonly code:
			| "UNAUTHORIZED"
			| "ACTOR_MISMATCH"
			| "CHAT_MISMATCH"
			| "SESSION_MISMATCH"
			| "SESSION_NOT_ACTIVE"
			| "AGENT_NOT_FOUND"
			| "INVALID_CURSOR",
		message: string,
	) {
		super(message);
		this.name = "NativeControlDeniedError";
	}
}

export interface TelegramControlCommandResult {
	handled: boolean;
	command: "workers" | "msg" | string;
	text: string;
	receipt?: IrcDeliveryReceipt;
}

export interface HandleTelegramCommandOptions {
	registry?: AgentRegistry;
	bus?: IrcBus;
	scope?: string;
	sender?: string;
	now?: () => number;
}

export interface TelegramExtensionPort {
	send(html: string): Promise<void> | void;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function formatAge(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

export interface RenderWorkerOptions {
	now?: number;
	scope?: string;
	includeAdvisors?: boolean;
}

/**
 * The one predicate deciding whether a ref is a worker this caller may see.
 *
 * Shared by the rendered roster and the structured one so the two can never
 * disagree about who is in the session.
 */
function isVisibleWorker(ref: AgentRef, options: { scope?: string; includeAdvisors?: boolean }): boolean {
	if (!options.includeAdvisors && ref.kind === "advisor") return false;
	if (options.scope !== undefined && ref.scope !== options.scope) return false;
	return true;
}

export function renderWorkerRoster(refs: readonly AgentRef[], options: RenderWorkerOptions = {}): string {
	const now = options.now ?? Date.now();
	const workers = refs.filter(ref => isVisibleWorker(ref, options));

	if (workers.length === 0) {
		return "<b>Live Workers (0):</b>\n<i>No active workers registered.</i>";
	}

	const lines = [`<b>Live Workers (${workers.length}):</b>`];
	for (const worker of workers) {
		const id = escapeHtml(worker.id);
		const type = escapeHtml(worker.kind);
		const model = escapeHtml(worker.model ?? "default");
		const state = escapeHtml(worker.status);
		const age = formatAge(now - worker.createdAt);
		const stateFormatted = worker.status === "running" ? `<b>${state}</b>` : state;
		lines.push(
			`• <code>${id}</code> (type: <code>${type}</code>, model: <code>${model}</code>, state: ${stateFormatted}, age: ${age})`,
		);
	}
	return lines.join("\n");
}

/**
 * A live worker as an extension sees it: structured, not rendered.
 *
 * `renderWorkerRoster` answers the Telegram case by emitting HTML, and an
 * extension that wants its own presentation (a different chat surface, a status
 * line, a filter) cannot un-render that string. So the same filter is exposed
 * once more as data, and both go through {@link workersInScope} rather than
 * repeating the predicate, because a worker that appears in one and is missing
 * from the other is the bug this shape exists to prevent.
 */
export interface WorkerSummary {
	id: string;
	name: string;
	kind: AgentKind;
	status: AgentStatus;
	model?: string;
	/** Display-only gist of current work, present only while running. */
	activity?: string;
	createdAt: number;
	lastActivity: number;
	/** False exactly when the worker holds no live session (parked or aborted). */
	live: boolean;
}

export interface WorkersInScopeOptions {
	scope?: string;
	includeAdvisors?: boolean;
	registry?: AgentRegistry;
}

/**
 * The workers a caller bound to `scope` may see, newest activity first.
 *
 * Advisors are excluded by default because they are read-only transcripts that
 * cannot be messaged: listing one invites a steer that `sendWorkerMessage` then
 * refuses. An undefined `scope` means "every conversation in this process" and
 * is for a caller that has no session of its own; a session-bound caller passes
 * its scope or it lists every other conversation's workers as if they were its.
 */
export function workersInScope(options: WorkersInScopeOptions = {}): AgentRef[] {
	const registry = options.registry ?? AgentRegistry.global();
	return registry
		.list()
		.filter(ref => isVisibleWorker(ref, options))
		.sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
}

export function toWorkerSummary(ref: AgentRef): WorkerSummary {
	const activity = sanitized(ref.activity, MAX_SUMMARY_CHARS);
	return {
		id: ref.id,
		name: sanitized(ref.displayName, MAX_SUMMARY_CHARS) ?? ref.id,
		kind: ref.kind,
		status: ref.status,
		...(ref.model ? { model: ref.model } : {}),
		...(activity ? { activity } : {}),
		createdAt: ref.createdAt,
		lastActivity: ref.lastActivity,
		live: ref.session !== null,
	};
}

/** Structured roster for a caller bound to `scope`. */
export function listWorkersInScope(options: WorkersInScopeOptions = {}): WorkerSummary[] {
	return workersInScope(options).map(toWorkerSummary);
}

export interface SendWorkerMessageOptions {
	sender?: string;
	registry?: AgentRegistry;
	scope?: string;
}

export async function sendWorkerMessage(
	bus: IrcBus,
	to: string,
	text: string,
	senderOrOptions: string | SendWorkerMessageOptions = "Telegram",
	extraOptions: { registry?: AgentRegistry; scope?: string } = {},
): Promise<IrcDeliveryReceipt> {
	const sender = typeof senderOrOptions === "string" ? senderOrOptions : (senderOrOptions.sender ?? "Telegram");
	const registry = typeof senderOrOptions === "object" ? senderOrOptions.registry : extraOptions.registry;
	const scope = typeof senderOrOptions === "object" ? senderOrOptions.scope : extraOptions.scope;
	const target = to.trim();

	if (scope !== undefined) {
		const reg = registry ?? AgentRegistry.global();
		const ref = reg.get(target);
		if (!ref || ref.scope !== scope || ref.kind === "advisor") {
			const error = !ref
				? `Unknown agent "${target}" — check \`irc list\` for live peers.`
				: ref.kind === "advisor"
					? `Agent "${target}" is a read-only advisor transcript and cannot be messaged.`
					: `Agent "${target}" is not available in the bound session.`;
			return {
				to: target,
				outcome: "failed",
				error,
			};
		}
	}

	return await bus.send({
		from: sender,
		to: target,
		body: text.trim(),
	});
}

/**
 * The conversation an agent belongs to, or undefined when nothing claims it.
 *
 * A subagent's scope is its root conversation, not its own session id, so a
 * host wiring extension actions for a spawned agent resolves it through the
 * registry instead of reading the session it happens to be driving.
 */
export function scopeOfAgent(agentId: string, registry?: AgentRegistry): string | undefined {
	return (registry ?? AgentRegistry.global()).get(agentId)?.scope;
}

/**
 * Session-scoped worker reads and steers, for a host wiring extension actions.
 *
 * The scope is read through a callback rather than captured, because `/new`,
 * `/resume` and `/move` re-root the driving conversation while the same
 * extension stays loaded: a captured id would keep answering for the session
 * the extension was loaded in, which is how a roster outlives its conversation.
 */
export interface SessionWorkerAccess {
	listWorkers(options?: { includeAdvisors?: boolean }): WorkerSummary[];
	steerWorker(workerId: string, message: string): Promise<IrcDeliveryReceipt>;
}

export interface SessionWorkerAccessOptions {
	/** Origin recorded on a steer, so a worker can tell who moved it. */
	sender?: string;
	registry?: AgentRegistry;
	bus?: IrcBus;
}

export function sessionWorkerAccess(
	currentScope: () => string | undefined,
	options: SessionWorkerAccessOptions = {},
): SessionWorkerAccess {
	return {
		listWorkers: (listOptions = {}) => {
			const scope = currentScope();
			// An unresolved scope lists NOTHING, where `listWorkersInScope`
			// would read undefined as "every conversation in this process". The
			// difference matters on a host holding several conversations: the
			// permissive reading hands one extension another operator's roster.
			if (scope === undefined) return [];
			return listWorkersInScope({
				scope,
				...(listOptions.includeAdvisors ? { includeAdvisors: true } : {}),
				...(options.registry ? { registry: options.registry } : {}),
			});
		},
		steerWorker: async (workerId, message) => {
			// Refused here rather than sent, because an empty body reaches the
			// worker as a turn with nothing in it: it pays for a turn, reads no
			// instruction, and the receipt would have said "delivered".
			if (!message.trim()) {
				return {
					to: workerId.trim(),
					outcome: "failed",
					error: "Refusing to steer with an empty message.",
				};
			}
			const scope = currentScope();
			if (scope === undefined) {
				return {
					to: workerId.trim(),
					outcome: "failed",
					error: "This session has no registered conversation, so its workers cannot be addressed.",
				};
			}
			return await sendWorkerMessage(options.bus ?? IrcBus.global(), workerId, message, {
				sender: options.sender ?? "Extension",
				...(options.registry ? { registry: options.registry } : {}),
				scope,
			});
		},
	};
}

export function formatWorkerMessageReceipt(receipt: IrcDeliveryReceipt): string {
	const escapedTo = escapeHtml(receipt.to);
	if (receipt.outcome === "failed") {
		const detail = receipt.error ? escapeHtml(receipt.error) : "Agent not found or unreachable.";
		return `<b>Message delivery failed to <code>${escapedTo}</code>.</b> ${detail}`;
	}
	return `<b>Message delivered to <code>${escapedTo}</code>.</b> (outcome: <code>${receipt.outcome}</code>)`;
}

export async function handleTelegramControlCommand(
	text: string,
	options: HandleTelegramCommandOptions = {},
): Promise<TelegramControlCommandResult | null> {
	const trimmed = text.trim();
	const workersMatch = /^\/workers(?:@\w+)?(?:\s|$)/i.exec(trimmed);
	if (workersMatch) {
		const registry = options.registry ?? AgentRegistry.global();
		const refs = registry.list();
		const rendered = renderWorkerRoster(refs, {
			now: options.now?.() ?? Date.now(),
			scope: options.scope,
		});
		return {
			handled: true,
			command: "workers",
			text: rendered,
		};
	}

	const msgMatch = /^\/msg(?:@\w+)?(?:\s+(\S+)(?:\s+([\s\S]+))?)?$/i.exec(trimmed);
	if (msgMatch) {
		const targetId = msgMatch[1];
		const body = msgMatch[2];
		if (!targetId || !body?.trim()) {
			return {
				handled: true,
				command: "msg",
				text: "<b>Usage:</b> <code>/msg &lt;id&gt; &lt;text&gt;</code>",
			};
		}
		const bus = options.bus ?? IrcBus.global();
		const receipt = await sendWorkerMessage(bus, targetId, body, {
			sender: options.sender ?? "Telegram",
			registry: options.registry,
			scope: options.scope,
		});
		const formatted = formatWorkerMessageReceipt(receipt);
		return {
			handled: true,
			command: "msg",
			text: formatted,
			receipt,
		};
	}

	return null;
}

export async function handleTelegramExtensionCommand(
	text: string,
	port: TelegramExtensionPort,
	options: HandleTelegramCommandOptions = {},
): Promise<boolean> {
	const result = await handleTelegramControlCommand(text, options);
	if (!result?.handled) {
		return false;
	}
	await port.send(result.text);
	return true;
}

function tokenMatches(expected: string, candidate: string): boolean {
	const expectedBytes = Buffer.from(expected, "utf8");
	const candidateBytes = Buffer.from(candidate, "utf8");
	return expectedBytes.length === candidateBytes.length && crypto.timingSafeEqual(expectedBytes, candidateBytes);
}

function sanitized(value: string | undefined, maxChars: number): string | undefined {
	if (!value) return undefined;
	const clean = value
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
	return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function boundedLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_PAGE_SIZE;
	if (!Number.isInteger(limit) || limit < 1) return 1;
	return Math.min(limit, MAX_PAGE_SIZE);
}

function cursorOffset(cursor: string | undefined): number {
	if (cursor === undefined) return 0;
	if (!/^(0|[1-9]\d*)$/.test(cursor)) {
		throw new NativeControlDeniedError("INVALID_CURSOR", "Cursor must be a non-negative decimal offset");
	}
	const offset = Number(cursor);
	if (!Number.isSafeInteger(offset)) {
		throw new NativeControlDeniedError("INVALID_CURSOR", "Cursor exceeds the safe pagination range");
	}
	return offset;
}

export class TelegramNativeControlBridge {
	readonly #binding: NativeControlBinding;
	readonly #registry: AgentRegistry;
	readonly #bus: IrcBus;
	readonly #now: () => number;

	constructor(options: NativeControlBridgeOptions) {
		if (options.binding.authToken.length < 32) {
			throw new Error("Native control authToken must contain at least 32 characters");
		}
		this.#binding = { ...options.binding };
		this.#registry = options.registry ?? AgentRegistry.global();
		this.#bus = options.bus ?? IrcBus.global();
		this.#now = options.now ?? (() => Date.now());
	}

	getSessionIdentity(auth: NativeControlAuth): NativeSessionIdentity {
		this.#authorize(auth);
		return { id: this.#binding.sessionId, actorId: this.#binding.actorId, chatId: this.#binding.chatId };
	}

	async listAgents(request: AgentListRequest): Promise<{ items: NativeAgentSummary[]; nextCursor?: string }> {
		this.#authorize(request);
		const offset = cursorOffset(request.cursor);
		const limit = boundedLimit(request.limit);
		const refs = this.#registry
			.list()
			.filter(ref => ref.scope === this.#binding.sessionId && ref.kind !== "advisor")
			.sort((a, b) => b.lastActivity - a.lastActivity || a.id.localeCompare(b.id));
		const items = refs.slice(offset, offset + limit).map(ref => this.#summary(ref));
		const nextOffset = offset + items.length;
		return { items, ...(nextOffset < refs.length ? { nextCursor: String(nextOffset) } : {}) };
	}

	async getAgentDetail(request: AgentDetailRequest): Promise<NativeAgentDetail> {
		this.#authorize(request);
		const ref = this.#registry.get(request.agentId);
		if (!ref || ref.scope !== this.#binding.sessionId || ref.kind === "advisor") {
			throw new NativeControlDeniedError("AGENT_NOT_FOUND", "Agent is not available in the bound session");
		}
		const progress = sanitized(ref.activity, MAX_SUMMARY_CHARS);
		const result = sanitized(ref.session?.getLastAssistantText(), MAX_RESULT_CHARS);
		return { ...this.#summary(ref), ...(progress ? { progress } : {}), ...(result ? { result } : {}) };
	}

	async renderWorkers(request: WorkerRosterRequest): Promise<string> {
		this.#authorize(request);
		const refs = this.#registry.list();
		return renderWorkerRoster(refs, {
			now: this.#now(),
			scope: this.#binding.sessionId,
		});
	}

	async sendMessage(request: SendWorkerMessageRequest): Promise<WorkerMessageReceipt> {
		this.#authorize(request);
		const receipt = await sendWorkerMessage(this.#bus, request.to, request.message, {
			sender: `Telegram:${this.#binding.actorId}`,
			registry: this.#registry,
			scope: this.#binding.sessionId,
		});
		return {
			to: receipt.to,
			outcome: receipt.outcome,
			...(receipt.error ? { error: receipt.error } : {}),
			formatted: formatWorkerMessageReceipt(receipt),
		};
	}

	async handleCommand(text: string, auth: NativeControlAuth): Promise<TelegramControlCommandResult | null> {
		this.#authorize(auth);
		return await handleTelegramControlCommand(text, {
			registry: this.#registry,
			bus: this.#bus,
			scope: this.#binding.sessionId,
			sender: `Telegram:${this.#binding.actorId}`,
			now: this.#now,
		});
	}

	#authorize(auth: NativeControlAuth): void {
		if (!tokenMatches(this.#binding.authToken, auth.authToken)) {
			throw new NativeControlDeniedError("UNAUTHORIZED", "Invalid native control credential");
		}
		if (auth.actorId !== this.#binding.actorId) {
			throw new NativeControlDeniedError("ACTOR_MISMATCH", "Actor is not bound to this native control bridge");
		}
		if (auth.chatId !== this.#binding.chatId) {
			throw new NativeControlDeniedError("CHAT_MISMATCH", "Chat is not bound to this native control bridge");
		}
		if (auth.sessionId !== this.#binding.sessionId) {
			throw new NativeControlDeniedError("SESSION_MISMATCH", "Session is not bound to this native control bridge");
		}
	}

	#summary(ref: AgentRef): NativeAgentSummary {
		const summary = sanitized(ref.activity, MAX_SUMMARY_CHARS);
		return {
			id: ref.id,
			name: sanitized(ref.displayName, MAX_SUMMARY_CHARS) ?? ref.id,
			status: ref.status,
			...(summary ? { summary } : {}),
			updatedAt: ref.lastActivity,
			kind: ref.kind,
			...(ref.model ? { model: ref.model } : {}),
		};
	}
}
