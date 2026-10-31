import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SecretIntakeResult } from "../../secrets/intake-broker";
import { serveTerminalControl, TerminalNotReadyError, type TerminalDeliveryOptions } from "../../launch/terminal-control";
import { logTelegramDeliveryTrace } from "@veyyon/utils";
import { OperatorAnswerInbox, operatorAnswerQuestionId } from "../../session/operator-answer-inbox";
import { isTerminalYieldToolResult } from "../../session/runtime/yield-tracker";
import type { InteractiveMode } from "./interactive-mode";
import { getSessionSecretIntake, getSessionSecretIntakeContext, registerSessionSecretIntakeActor } from "../../secrets/intake-session";
import { parseSecretSubmission } from "../../secrets/intake-wire";
import type { TerminalSecretRequest } from "../../launch/terminal-control";

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
					isTerminalYieldToolResult({
						toolName: message.toolName,
						isError: message.isError,
						result: { details: message.details },
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

/** Deliver to the existing REPL, never create a second AgentSession or transcript writer. */
export async function startTerminalControl(mode: InteractiveMode): Promise<() => void> {
	let revision = "";
	let entries: TerminalTranscriptText[] = [];
	// Cursor into the journal: how many entries were converted and the id of the last one. A leaf
	// change then costs the new entries only. A shorter journal or a different id at the cursor
	// means entries were rewritten or removed, and one full pass rebuilds the list.
	let converted = 0;
	let lastConvertedId: string | undefined;
	const projector = createTerminalTranscriptProjector();
	const convert = (entry: SessionEntry): TerminalTranscriptText[] => {
		const turn = projector.observe(entry);
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		const content = mode.session.displayAssistantContent(entry.message.content);
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
	return serveTerminalControl({
		identity: () => ({
			sessionId: mode.sessionManager.getSessionId(),
			cwd: mode.sessionManager.getCwd(),
			sessionFile: mode.sessionManager.getSessionFile() ?? "",
		}),
		history,
		async deliver(text, behavior, options?: TerminalDeliveryOptions) {
			if (mode.isShuttingDown || !mode.isInitialized) throw new Error("Terminal is shutting down");
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
}
