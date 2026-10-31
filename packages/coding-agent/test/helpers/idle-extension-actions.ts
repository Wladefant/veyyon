import type { ExtensionActions, ExtensionContextActions } from "@veyyon/coding-agent/extensibility/extensions/types";

/**
 * The `ExtensionActions` of a host that offers nothing: every getter returns empty and every setter is ignored.
 * `overrides` replaces the members a test reads back.
 */
export function idleExtensionActions(overrides: Partial<ExtensionActions> = {}): ExtensionActions {
	return {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
		...overrides,
	};
}

/**
 * The `ExtensionContextActions` of an idle session with no model, no queue and no secrets to redact.
 * `overrides` replaces the members a test reads back.
 */
export function idleContextActions(overrides: Partial<ExtensionContextActions> = {}): ExtensionContextActions {
	return {
		getModel: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
		obfuscateProviderText: text => text,
		...overrides,
	};
}
