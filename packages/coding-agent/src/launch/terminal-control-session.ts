import { readColdEntry } from "@veyyon/kernel/session/session-cold-payloads";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger, logTelegramDeliveryTrace, parseTelegramTrace, type TelegramDeliveryTraceData } from "@veyyon/utils";
import type { InteractiveMode } from "../modes/terminal/interactive-mode";
import type { SecretIntakeResult } from "../secrets/intake-broker";
import {
	getSessionSecretIntake,
	getSessionSecretIntakeContext,
	registerSessionSecretIntakeActor,
} from "../secrets/intake-session";
import { parseSecretSubmission } from "../secrets/intake-wire";
import { OperatorAnswerInbox, operatorAnswerQuestionId } from "../session/operator-answer-inbox";
import { isTerminalYieldToolResult } from "../session/runtime/yield-tracker";
import {
	durableTerminalDeliveryId,
	PENDING_TERMINAL_STEERING,
	WITHDRAWN_TERMINAL_STEERING,
} from "../session/terminal-input";
import { TOOL } from "../tools/core/builtin-names";
import {
	serveTerminalControl,
	type TerminalControlHandle,
	type TerminalDeliveryOptions,
	TerminalNotReadyError,
	type TerminalSecretRequest,
} from "./terminal-control";
import { observeTerminalRegistry } from "./terminal-registry-snapshot";

export interface TerminalTurnProvenance {
	hasOperatorMessage: boolean;
	hasSubstantiveToolCall: boolean;
	toolNames: string[];
	isMain: boolean;
}

/**
 * Persisted assistant text carries its turn's operator and tool activity to forwarding clients.
 * A terminal answer or successful terminal yield clears activity. Other tool calls keep it.
 */
export function createTerminalTranscriptProjector() {
	let hasOperatorMessage = false;
	const toolNames = new Set<string>();
	return {
		reset() {
			hasOperatorMessage = false;
			toolNames.clear();
		},
		observe(entry: SessionEntry) {
			if (entry.type === "custom_message") {
				if (entry.attribution === "user") hasOperatorMessage = true;
				return undefined;
			}
			if (entry.type !== "message") return undefined;
			const message = entry.message;
			if (message.role === "user") {
				if (message.attribution !== "agent") hasOperatorMessage = true;
				return undefined;
			}
			if (message.role === "toolResult") {
				if (
					message.toolName === TOOL.yield &&
					!message.isError &&
					isTerminalYieldToolResult({
						toolName: message.toolName,
						isError: message.isError,
						result: message,
					})
				)
					this.reset();
				return undefined;
			}
			if (message.role !== "assistant") return undefined;
			for (const block of message.content) {
				if (block.type === "toolCall") toolNames.add(block.name);
			}
			const turn = {
				hasOperatorMessage,
				hasSubstantiveToolCall: [...toolNames].some(name => name !== "job" && name !== "poll"),
				toolNames: [...toolNames],
				isMain: true,
			};
			if (message.stopReason !== "toolUse") this.reset();
			return turn;
		},
	};
}

type TerminalTranscriptText = {
	entryId: string;
	text: string;
	turn?: TerminalTurnProvenance;
};

const STEERING_ALERT_MS = 60_000;

interface PendingSteering {
	version: 1;
	sessionId: string;
	messageId: string;
	text: string;
	mode: "auto" | "steer" | "followUp";
	acceptedAt: number;
	telegramTrace?: TelegramDeliveryTraceData;
}

function readPendingSteering(journal: SessionManager) {
	const pending = new Map<string, PendingSteering>();
	const withdrawn = new Set<string>();
	const sessionId = journal.getSessionId();
	for (const entry of journal.getEntries()) {
		if (entry.type === "custom" && entry.customType === WITHDRAWN_TERMINAL_STEERING) {
			const record = entry.data as { sessionId?: string; messageId?: string } | null;
			if (record?.sessionId === sessionId && typeof record.messageId === "string") {
				withdrawn.add(record.messageId);
				pending.delete(record.messageId);
			}
		} else if (entry.type === "custom" && entry.customType === PENDING_TERMINAL_STEERING) {
			const record = entry.data as Partial<PendingSteering> | null;
			if (
				record?.version === 1 &&
				record.sessionId === sessionId &&
				typeof record.messageId === "string" &&
				typeof record.text === "string" &&
				durableTerminalDeliveryId(record.text) === record.messageId &&
				(record.mode === "auto" || record.mode === "steer" || record.mode === "followUp") &&
				typeof record.acceptedAt === "number" &&
				Number.isFinite(record.acceptedAt)
			) {
				if (!pending.has(record.messageId) && !withdrawn.has(record.messageId)) {
					pending.set(record.messageId, record as PendingSteering);
				}
			}
		} else if (pending.size && entry.type === "message" && entry.message.role === "user") {
			const readable = readColdEntry(entry) ?? entry;
			if (readable.type !== "message" || readable.message.role !== "user") continue;
			const { content, attribution, synthetic } = readable.message;
			if (synthetic || attribution === "agent") continue;
			const body = typeof content === "string" ? content : content.find(block => block.type === "text")?.text;
			const id = body === undefined ? undefined : durableTerminalDeliveryId(body);
			if (id) pending.delete(id);
		}
	}
	return { pending, withdrawn };
}

function createSteeringInbox(mode: InteractiveMode) {
	let journal = mode.sessionManager;
	let pending = new Map<string, PendingSteering>();
	let withdrawn = new Set<string>();
	let verified = false;
	const replayed = new Set<string>();
	let alertedId: string | undefined;
	const refresh = () => {
		try {
			({ pending, withdrawn } = readPendingSteering(journal));
			verified = true;
		} catch {
			verified = false;
			logger.warn("Cannot read terminal steering custody; leaving input in the journal", {
				sessionId: journal.getSessionId(),
			});
		}
		return verified;
	};
	return {
		async recover() {
			if (!refresh() || !pending.size) return;
			try {
				await journal.assertReplayJournalCurrent();
			} catch {
				verified = false;
				logger.warn("Cannot verify the terminal steering journal; pending input was not replayed");
				return;
			}
			const owner = journal;
			if (!refresh()) return;
			for (const record of pending.values()) {
				if (mode.sessionManager !== owner || mode.isShuttingDown) return;
				const options = { telegramTrace: parseTelegramTrace(record.telegramTrace) };
				try {
					if (record.mode === "followUp") await mode.session.followUp(record.text, undefined, undefined, options);
					else await mode.session.steer(record.text, undefined, undefined, options);
					replayed.add(record.messageId);
				} catch {
					logger.warn("Pending terminal steering did not enter the queue", {
						sessionId: record.sessionId,
						messageId: record.messageId,
					});
					// Do not dispatch a later input ahead of one that could not be queued.
					return;
				}
			}
		},
		async record(
			sessionId: string,
			messageId: string,
			text: string,
			behavior: PendingSteering["mode"],
			options?: TerminalDeliveryOptions,
		): Promise<"recorded" | "duplicate" | "bypass"> {
			if (mode.sessionManager.getSessionId() !== sessionId || mode.isShuttingDown || !mode.isInitialized)
				throw new TerminalNotReadyError("Terminal is not ready to accept steering");
			// Answers have their own journal. Do not replay terminal commands as model input.
			if (operatorAnswerQuestionId(text) || /^[!/]/.test(text.trimStart())) return "bypass";
			const owner = mode.sessionManager;
			if (owner !== journal) {
				journal = owner;
				replayed.clear();
				verified = false;
			}
			if (!verified && !refresh()) throw new TerminalNotReadyError("Cannot verify terminal steering custody");
			if (replayed.has(messageId) || withdrawn.has(messageId)) return "duplicate";
			const previous = pending.get(messageId);
			if (previous && (previous.text !== text || previous.mode !== behavior)) {
				throw new Error("Terminal delivery ID already has a different pending input");
			}
			if (!previous) {
				const record: PendingSteering = {
					version: 1,
					sessionId,
					messageId,
					text,
					mode: behavior,
					acceptedAt: Date.now(),
					telegramTrace: options?.telegramTrace,
				};
				owner.appendCustomEntry(PENDING_TERMINAL_STEERING, record);
				pending.set(messageId, record);
			}
			try {
				await owner.ensureOnDisk();
				await owner.sync();
			} catch {
				throw new TerminalNotReadyError("Terminal could not persist steering");
			}
			return "recorded";
		},
		checkStall() {
			if (mode.sessionManager !== journal || !pending.size || !refresh()) return;
			const oldest = pending.values().next().value;
			if (!oldest || oldest.messageId === alertedId || Date.now() - oldest.acceptedAt < STEERING_ALERT_MS) return;
			alertedId = oldest.messageId;
			const waitReason = mode.session.isRetrying
				? "provider retry"
				: mode.session.hasPostPromptWork
					? "post-turn work"
					: mode.session.heartbeatPhase || "idle without queue consumption";
			logger.warn("Accepted steering has not reached a turn", {
				sessionId: oldest.sessionId,
				messageId: oldest.messageId,
				ageMs: Date.now() - oldest.acceptedAt,
				waitReason,
			});
			mode.session.emitNotice("warning", `Steering ${oldest.messageId} has not reached a turn: ${waitReason}.`);
		},
	};
}

/** Deliver to the existing REPL, never create a second AgentSession or transcript writer. */
export async function startTerminalControl(mode: InteractiveMode): Promise<TerminalControlHandle> {
	let revision = "";
	let entries: TerminalTranscriptText[] = [];
	// Cursor into the journal: how many entries were converted and the id of the last one. A leaf
	// change then costs the new entries only. A shorter journal or a different id at the cursor
	// means entries were rewritten or removed, and one full pass rebuilds the list.
	let converted = 0;
	let lastConvertedId: string | undefined;
	const projector = createTerminalTranscriptProjector();
	const convert = (entry: SessionEntry): TerminalTranscriptText[] => {
		const readable =
			entry.type === "message" &&
			(entry.message.role === "assistant" ||
				(entry.message.role === "toolResult" && entry.message.toolName === TOOL.yield && !entry.message.isError))
				? (readColdEntry(entry) ?? entry)
				: entry;
		const turn = projector.observe(readable);
		if (readable.type !== "message" || readable.message.role !== "assistant") return [];
		const content = mode.session.displayAssistantContent(readable.message.content);
		const text = content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim();
		return text ? [{ entryId: entry.id, text, turn }] : [];
	};
	const history = (): TerminalTranscriptText[] => {
		const next = `${mode.sessionManager.getSessionId()}:${mode.sessionManager.getLeafId()}`;
		if (revision === next) return entries;
		revision = next;
		const journal = mode.sessionManager.getEntries();
		const intact = converted > 0 && journal.length >= converted && journal[converted - 1]?.id === lastConvertedId;
		if (!intact) {
			converted = 0;
			entries = [];
			projector.reset();
		}
		const appended = journal.slice(converted).flatMap(convert);
		converted = journal.length;
		lastConvertedId = journal.at(-1)?.id;
		// An unchanged list keeps its identity: the subscriber compares by reference.
		if (appended.length || !intact) entries = entries.concat(appended);
		return entries;
	};
	const answers = new OperatorAnswerInbox(
		() => mode.sessionManager,
		async (text, behavior, traceOptions) => {
			if (mode.isShuttingDown || !mode.isInitialized) throw new Error("Terminal is shutting down");
			if (mode.session.isStreaming && behavior === "followUp") {
				await mode.session.followUp(text, undefined, undefined, traceOptions);
				return "queued";
			}
			// Steer also drains an idle session. Recovery must not depend on a REPL input callback.
			await mode.session.steer(text, undefined, undefined, traceOptions);
			return mode.session.isStreaming ? "steered" : "queued";
		},
		questionId => {
			const queued = mode.session.getQueuedMessages();
			return [...queued.steering, ...queued.followUp].some(text => operatorAnswerQuestionId(text) === questionId);
		},
	);
	await answers.recover();
	const steering = createSteeringInbox(mode);
	await steering.recover();
	let idleExitReserved = false;
	const control = await serveTerminalControl({
		identity: () => ({
			sessionId: mode.sessionManager.getSessionId(),
			cwd: mode.sessionManager.getCwd(),
			sessionFile: mode.sessionManager.getSessionFile() ?? "",
		}),
		recordSteering: steering.record,
		registrySnapshot: mode.collabGuest
			? undefined
			: sessionId => (mode.collabGuest ? undefined : observeTerminalRegistry(sessionId, mode.session)),
		history,
		isIdle() {
			const queued = mode.session.getQueuedMessages();
			return (
				!idleExitReserved &&
				!mode.isShuttingDown &&
				!mode.session.isStreaming &&
				!mode.session.isCompacting &&
				!mode.session.hasPostPromptWork &&
				queued.steering.length === 0 &&
				queued.followUp.length === 0 &&
				mode.pendingTools.size === 0 &&
				!mode.hasPendingSubmission
			);
		},
		reserveExit() {
			idleExitReserved = true;
			mode.reserveShutdownInput();
		},
		shutdown() {
			return mode.shutdown();
		},
		async deliver(text, behavior, options?: TerminalDeliveryOptions) {
			if (idleExitReserved || mode.isShuttingDown || !mode.isInitialized)
				throw new Error("Terminal is shutting down");
			if (options?.telegramTrace) {
				logTelegramDeliveryTrace(options.telegramTrace, {
					stage: "terminal_delivery_start",
					sessionId: mode.sessionManager.getSessionId(),
				});
			}
			const answer = await answers.accept(
				text,
				behavior,
				options?.telegramTrace ? { telegramTrace: options.telegramTrace } : undefined,
			);
			if (answer !== undefined) return answer;
			if (mode.session.isStreaming) {
				if (behavior === "followUp") {
					await mode.session.followUp(text, undefined, undefined, { telegramTrace: options?.telegramTrace });
					return "queued";
				}
				await mode.session.steer(text, undefined, undefined, { telegramTrace: options?.telegramTrace });
				return "steered";
			}
			const submit = mode.onInputCallback;
			if (!submit) throw new TerminalNotReadyError("Terminal is not ready for input; delivery not accepted");
			// A promise resolver accepts only one input. Reserve it synchronously before acknowledging.
			mode.onInputCallback = undefined;
			submit(mode.startPendingSubmission({ text, telegramTrace: options?.telegramTrace }));
			return "started";
		},
		async abort() {
			if (!mode.session.isStreaming) return false;
			await mode.session.abort();
			return true;
		},
		async registerSecretIntake(registration) {
			try {
				return await registerSessionSecretIntakeActor(
					mode.session,
					registration.actorId,
					registration.ownerSessionId,
				);
			} catch {
				throw new Error("Secret intake registration refused");
			}
		},
		secretIntakeContext() {
			const broker = getSessionSecretIntake(mode.session);
			const context = getSessionSecretIntakeContext(mode.session);
			return broker && context ? context : undefined;
		},
		async secretRequest(request: TerminalSecretRequest) {
			const broker = getSessionSecretIntake(mode.session);
			const bound = getSessionSecretIntakeContext(mode.session);
			if (
				!broker ||
				!bound ||
				request.context.actorId !== bound.actorId ||
				request.context.ownerSessionId !== bound.ownerSessionId ||
				request.context.projectId !== bound.projectId ||
				(request.action === "submit" && request.submission.requestId !== request.requestId)
			) {
				throw new Error("Secret intake request refused");
			}
			try {
				switch (request.action) {
					case "get":
						return broker.get(bound, request.requestId).request;
					case "decline":
						return broker.decline(bound, request.requestId).request;
					case "cancel":
						return broker.cancel(bound, request.requestId).request;
					case "submit":
						return (await broker.submit(bound, parseSecretSubmission(request.submission))).request;
				}
			} catch {
				throw new Error("Secret intake request refused");
			}
		},
		subscribe(listener) {
			let sessionId = mode.sessionManager.getSessionId();
			let previous = history();
			let seen = new Set(previous.map(entry => entry.entryId));
			let active = mode.session.isStreaming;
			const attachSecretEvents = (): (() => void) => {
				const broker = getSessionSecretIntake(mode.session);
				const context = getSessionSecretIntakeContext(mode.session);
				if (!broker || !context) return () => {};
				const publishSecretRequest = (result: SecretIntakeResult): void => {
					const { request } = result;
					if (request.ownerSessionId !== context.ownerSessionId || request.projectId !== context.projectId) return;
					listener({
						kind: request.status === "pending" ? "secret_request_created" : "secret_request_updated",
						sessionId: mode.sessionManager.getSessionId(),
						request,
					});
				};
				const stop = broker.subscribe(publishSecretRequest);
				for (const request of broker.listPending(context)) publishSecretRequest(request);
				return stop;
			};
			let stopSecretEvents = attachSecretEvents();
			if (active) {
				listener({ kind: "streaming", sessionId, active: true });
			}
			// Observe persisted owner entries, never JSONL or uncommitted provider deltas.
			// An unchanged journal costs only two identity reads, not a transcript copy or expansion.
			const timer = setInterval(() => {
				const current = mode.sessionManager.getSessionId();
				const next = history();
				if (current !== sessionId) {
					sessionId = current;
					previous = next;
					seen = new Set(next.map(entry => entry.entryId));
					active = mode.session.isStreaming;
					stopSecretEvents();
					stopSecretEvents = attachSecretEvents();
					return;
				}
				if (next !== previous) {
					previous = next;
					const appended = next.filter(entry => !seen.has(entry.entryId));
					for (const entry of appended) seen.add(entry.entryId);
					if (appended.length) listener({ kind: "appended", sessionId, entries: appended });
				}
				if (active !== mode.session.isStreaming) {
					active = mode.session.isStreaming;
					listener({ kind: "streaming", sessionId, active });
				}
			}, 250);
			timer.unref();
			return () => {
				clearInterval(timer);
				stopSecretEvents();
			};
		},
	});
	const timer = setInterval(steering.checkStall, STEERING_ALERT_MS).unref();
	return Object.assign(
		() => {
			clearInterval(timer);
			control();
		},
		{ refreshIdentity: control.refreshIdentity },
	);
}
