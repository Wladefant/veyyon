import { serveTerminalControl } from "../../launch/terminal-control";
import type { InteractiveMode } from "./interactive-mode";

/** Deliver to the existing REPL, never create a second AgentSession or transcript writer. */
export function startTerminalControl(mode: InteractiveMode): Promise<() => void> {
	let revision = "";
	let entries: { entryId: string; text: string }[] = [];
	const history = (): { entryId: string; text: string }[] => {
		const next = `${mode.sessionManager.getSessionId()}:${mode.sessionManager.getLeafId()}`;
		if (revision === next) return entries;
		revision = next;
		entries = mode.sessionManager.getEntries().flatMap(entry => {
			if (entry.type !== "message" || entry.message.role !== "assistant") return [];
			const content = mode.session.displayAssistantContent(entry.message.content);
			const text = content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("\n")
				.trim();
			return text ? [{ entryId: entry.id, text }] : [];
		});
		return entries;
	};
	return serveTerminalControl({
		identity: () => ({
			sessionId: mode.sessionManager.getSessionId(),
			cwd: mode.sessionManager.getCwd(),
			sessionFile: mode.sessionManager.getSessionFile() ?? "",
		}),
		history,
		async deliver(text, behavior) {
			if (mode.isShuttingDown || !mode.isInitialized) throw new Error("Terminal is shutting down");
			if (mode.session.isStreaming) {
				if (behavior === "followUp") {
					await mode.session.followUp(text);
					return "queued";
				}
				await mode.session.steer(text);
				return "steered";
			}
			const submit = mode.onInputCallback;
			if (!submit) throw new Error("Terminal is not ready for input; delivery not accepted");
			// A promise resolver accepts only one input. Reserve it synchronously before acknowledging.
			mode.onInputCallback = undefined;
			submit(mode.startPendingSubmission({ text }));
			return "started";
		},
		async abort() {
			if (!mode.session.isStreaming) return false;
			await mode.session.abort();
			return true;
		},
		subscribe(listener) {
			let sessionId = mode.sessionManager.getSessionId();
			let previous = history();
			let seen = new Set(previous.map(entry => entry.entryId));
			let active = mode.session.isStreaming;
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
			return () => clearInterval(timer);
		},
	});
}
