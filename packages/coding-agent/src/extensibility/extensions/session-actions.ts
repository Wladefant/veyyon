/**
 * The extension actions of a host whose extensions act on one {@link AgentSession}: print, RPC,
 * ACP and a spawned agent. Every member reads that session, so a host supplies only what it does
 * differently: how it delivers an extension's send and how it shuts down.
 *
 * The interactive host builds its own set. Each of its members redraws the screen, and each reads
 * whichever session is displayed when it is called rather than the one it was built with.
 */
import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import type { AgentSession } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { runExtensionCompact, runExtensionSetModel } from "./compact-handler";
import { getSessionSlashCommands } from "./get-commands-handler";
import type { ExtensionActions, ExtensionCommandContextActions, ExtensionContextActions } from "./types";

/** What one host does differently from every other host acting on a session. */
export interface SessionActionHost {
	sendMessage: ExtensionActions["sendMessage"];
	sendUserMessage: ExtensionActions["sendUserMessage"];
	shutdown: ExtensionContextActions["shutdown"];
	/** The call site a failed abort is logged under. */
	abortSite: string;
	/** Whether an extension may activate a tool. Every tool when absent. */
	activatable?: (toolName: string) => boolean;
}

/** The two action sets {@link ExtensionRunner.initialize} requires. */
export interface SessionExtensionActions {
	actions: ExtensionActions;
	contextActions: ExtensionContextActions;
}

export function sessionExtensionActions(session: AgentSession, host: SessionActionHost): SessionExtensionActions {
	const { activatable } = host;
	return {
		actions: {
			sendMessage: host.sendMessage,
			sendUserMessage: host.sendUserMessage,
			appendEntry: (customType, data) => {
				session.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId, label) => {
				session.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => session.getActiveToolNames(),
			getAllTools: () => session.getAllToolNames(),
			setActiveTools: toolNames =>
				session.setActiveToolsByName(activatable ? toolNames.filter(activatable) : toolNames),
			getCommands: () => getSessionSlashCommands(session),
			setModel: (model, options) => runExtensionSetModel(session, model, options),
			getThinkingLevel: () => session.thinkingLevel,
			setThinkingLevel: (level, persist) => session.setThinkingLevel(level, persist),
			getSessionName: () => session.sessionManager.getSessionName(),
			setSessionName: async name => {
				await session.sessionManager.setSessionName(name, "user");
			},
		},
		contextActions: {
			getModel: () => session.model,
			isIdle: () => !session.isStreaming,
			// `abort` is `() => void`: a returned promise would float, and a rejecting abort would
			// reach the process-level unhandled-rejection hook, which exits.
			abort: () => abortDetached(session, host.abortSite, USER_INTERRUPT_LABEL),
			hasPendingMessages: () => session.queuedMessageCount > 0,
			shutdown: host.shutdown,
			getContextUsage: () => session.getContextUsage(),
			getSystemPrompt: () => session.systemPrompt,
			compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
			obfuscateProviderText: text => session.obfuscateProviderText(text),
		},
	};
}

/** The command actions of a host whose extension commands may replace or rewind its session. */
export function sessionCommandActions(session: AgentSession): ExtensionCommandContextActions {
	return {
		waitForIdle: () => session.agent.waitForIdle(),
		newSession: async options => {
			const success = await session.newSession({ parentSession: options?.parentSession });
			if (success && options?.setup) {
				await options.setup(session.sessionManager);
			}
			return { cancelled: !success };
		},
		branch: async entryId => {
			const result = await session.branch(entryId);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, options) => {
			const result = await session.navigateTree(targetId, { summarize: options?.summarize });
			return { cancelled: result.cancelled };
		},
		switchSession: async sessionPath => {
			const success = await session.switchSession(sessionPath);
			return { cancelled: !success };
		},
		reload: async () => {
			await session.reload();
		},
	};
}
