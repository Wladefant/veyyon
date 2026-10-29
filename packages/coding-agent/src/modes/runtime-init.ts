/**
 * Shared extension runtime wiring for print and RPC modes.
 *
 * Both modes initialize the extension runner with the session-backed action set
 * every non-interactive host shares. Only error reporting, shutdown behavior,
 * and UI context differ between callers — those stay as caller-supplied hooks.
 */

import { toError } from "@veyyon/utils/type-guards";
import { sessionCommandActions, sessionExtensionActions } from "../extensibility/extensions/session-actions";
import type { ExtensionError, ExtensionUIContext } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";

/** Action name for an extension-originated send failure. */
export type ExtensionSendAction = "extension_send" | "extension_send_user";

export interface InitializeExtensionsOptions {
	/** Reports an error thrown by an extension-initiated send. */
	reportSendError: (action: ExtensionSendAction, error: Error) => void;
	/** Reports a runtime error surfaced through {@link ExtensionRunner.onError}. */
	reportRuntimeError: (error: ExtensionError) => void;
	/** Optional shutdown hook (rpc mode signals its loop; print mode is a no-op). */
	onShutdown?: () => void;
	/** Optional UI context (rpc supplies one; print runs headless). */
	uiContext?: ExtensionUIContext;
	/** Optional lifecycle hook for extension-originated messages that can start an agent turn. */
	markAgentInvokingMessage?: () => void;
	/** Optional lifecycle hook for extension-originated sends whose success/failure determines turn ownership. */
	trackAgentInvokingMessage?: (task: Promise<unknown>) => void;
}

/**
 * Initialize the session's extension runner with the standard action set
 * shared by non-interactive modes, then emit `session_start`.
 *
 * No-op when the session was constructed without an extension runner.
 */
export async function initializeExtensions(session: AgentSession, options: InitializeExtensionsOptions): Promise<void> {
	const runner = session.extensionRunner;
	if (!runner) return;

	const {
		reportSendError,
		reportRuntimeError,
		onShutdown,
		uiContext,
		markAgentInvokingMessage,
		trackAgentInvokingMessage,
	} = options;
	const { actions, contextActions } = sessionExtensionActions(session, {
		sendMessage: (message, sendOptions) => {
			const sendTask = session.sendCustomMessage(message, sendOptions);
			if (sendOptions?.triggerTurn) {
				if (trackAgentInvokingMessage) {
					trackAgentInvokingMessage(sendTask);
				} else {
					markAgentInvokingMessage?.();
				}
			}
			sendTask.catch(e => {
				reportSendError("extension_send", toError(e));
			});
		},
		sendUserMessage: (content, sendOptions) => {
			const sendTask = session.sendUserMessage(content, sendOptions);
			if (trackAgentInvokingMessage) {
				trackAgentInvokingMessage(sendTask);
			} else {
				markAgentInvokingMessage?.();
			}
			sendTask.catch(e => {
				reportSendError("extension_send_user", toError(e));
			});
		},
		shutdown: onShutdown ?? (() => {}),
		abortSite: "runtime-init.extension.abort",
	});
	runner.initialize(actions, contextActions, sessionCommandActions(session), uiContext);

	runner.onError(reportRuntimeError);
	await runner.emit({ type: "session_start" });
}
