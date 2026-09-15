import * as crypto from "node:crypto";
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
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

export interface WorkerRosterRequest extends NativeControlAuth {
	scope?: string;
}

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

export function renderWorkerRoster(refs: readonly AgentRef[], options: RenderWorkerOptions = {}): string {
	const now = options.now ?? Date.now();
	const workers = refs.filter(ref => {
		if (!options.includeAdvisors && ref.kind === "advisor") return false;
		if (options.scope && ref.scope && ref.scope !== options.scope) return false;
		return true;
	});

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

export async function sendWorkerMessage(
	bus: IrcBus,
	to: string,
	text: string,
	sender = "Telegram",
): Promise<IrcDeliveryReceipt> {
	return await bus.send({
		from: sender,
		to: to.trim(),
		body: text.trim(),
	});
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
		const receipt = await sendWorkerMessage(bus, targetId, body, options.sender ?? "Telegram");
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
			scope: request.scope ?? this.#binding.sessionId,
		});
	}

	async sendMessage(request: SendWorkerMessageRequest): Promise<WorkerMessageReceipt> {
		this.#authorize(request);
		const receipt = await sendWorkerMessage(
			this.#bus,
			request.to,
			request.message,
			`Telegram:${this.#binding.actorId}`,
		);
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
