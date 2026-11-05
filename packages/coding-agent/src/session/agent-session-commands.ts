/**
 * Slash commands an extension or a custom command module registers: resolving the typed text to
 * one, running it, and the command context a session hands it when no extension runner builds
 * one. Reads the session through {@link SessionCommandHost}, which the session satisfies
 * structurally.
 */
import type { Model } from "@veyyon/ai";
import type { DetachedAbortTarget } from "@veyyon/kernel/session/detached-abort";
import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import type { NewSessionOptions } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, logger, settleWithin } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands/types";
import type { ExtensionCommandContext, ExtensionRunner } from "../extensibility/extensions";
import { createExtensionModelQuery } from "../extensibility/extensions/model-api";
import { noOpUIContext } from "../extensibility/extensions/runner";
import type { CompactOptions, ContextUsage } from "../extensibility/extensions/types";
import type { HookCommandContext } from "../extensibility/hooks/types";
import { parseSlashCommand, resolveSlashCommand } from "../slash-commands/helpers/parse";
import { parseCommandArgs } from "../utils/command-args";
import { SHUTDOWN_DISPOSE_TIMEOUT_MS } from "./agent-session-types";
import { USER_INTERRUPT_LABEL } from "./messages";

/** What a command's context reads from and drives on the session. */
export interface SessionCommandHost extends DetachedAbortTarget {
	readonly extensionRunner: ExtensionRunner | undefined;
	readonly modelRegistry: ModelRegistry;
	readonly sessionManager: SessionManager;
	readonly settings: Settings;
	readonly model: Model | undefined;
	readonly isStreaming: boolean;
	readonly queuedMessageCount: number;
	readonly systemPrompt: string[];
	dispose(): Promise<void>;
	getContextUsage(): ContextUsage | undefined;
	waitForIdle(): Promise<void>;
	newSession(options?: NewSessionOptions): Promise<boolean>;
	branch(entryId: string): Promise<{ cancelled: boolean }>;
	navigateTree(targetId: string, options: { summarize?: boolean }): Promise<{ cancelled: boolean }>;
	compact(customInstructions?: string, options?: CompactOptions): Promise<unknown>;
	switchSession(sessionPath: string): Promise<boolean>;
	reload(): Promise<void>;
	obfuscateProviderText(text: string): string;
}

/**
 * Try to execute an extension command. Returns true if command was found and executed.
 *
 * A plugin command is registered as `<plugin>:<name>`; `resolveSlashCommand` matches it from
 * either `/<plugin>:<name>` or `/<plugin> <name>`.
 */
export async function tryExecuteExtensionCommand(runner: ExtensionRunner | undefined, text: string): Promise<boolean> {
	if (!runner) return false;

	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const resolved = resolveSlashCommand(parsed, name => runner.getCommand(name));
	if (!resolved) return false;
	const { command, args } = resolved;
	const commandName = command.name;

	// Get command context from extension runner (includes session control methods)
	const ctx = runner.createCommandContext();

	try {
		await command.handler(args, ctx);
		return true;
	} catch (err) {
		// Emit error via extension runner
		runner.emitError({
			extensionPath: `command:${commandName}`,
			event: "command",
			error: errorMessage(err),
		});
		return true;
	}
}

/**
 * Throw an error if the text is an extension command.
 */
export function throwIfExtensionCommand(runner: ExtensionRunner | undefined, text: string): void {
	if (!runner) return;

	const parsed = parseSlashCommand(text);
	if (!parsed) return;
	const resolved = resolveSlashCommand(parsed, name => runner.getCommand(name));
	const commandName = resolved?.command.name ?? parsed.name;
	const command = resolved?.command;

	if (command) {
		throw new Error(
			`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
		);
	}
}

function createSessionCommandContext(host: SessionCommandHost): ExtensionCommandContext {
	if (host.extensionRunner) {
		return host.extensionRunner.createCommandContext();
	}

	return {
		ui: noOpUIContext,
		hasUI: false,
		cwd: host.sessionManager.getCwd(),
		sessionManager: host.sessionManager,
		modelRegistry: host.modelRegistry,
		model: host.model ?? undefined,
		models: createExtensionModelQuery(host.modelRegistry, host.settings, () => host.model ?? undefined),
		isIdle: () => !host.isStreaming,
		// `ExtensionContextActions.abort` is `() => void`, so the promise from
		// `host.abort()` was discarded with no rejection handler and a failing
		// abort floated to postmortem, which exits the process. `abortDetached`
		// is the shared helper for aborts no caller can await.
		abort: () => {
			abortDetached(host, "agent-session.commandContext.abort", USER_INTERRUPT_LABEL);
		},
		hasPendingMessages: () => host.queuedMessageCount > 0,
		shutdown: () => {
			// `dispose()` flushes session state. This used to fire it and call
			// `process.exit(0)` on the very next line, so the flush was
			// abandoned at its first await and anything not yet written was
			// lost. Wait for it, but bound the wait so a wedged teardown still
			// exits instead of hanging the caller forever.
			void settleWithin(host.dispose(), SHUTDOWN_DISPOSE_TIMEOUT_MS, undefined)
				.catch(error => {
					logger.error("Session dispose failed during shutdown", { error: errorMessage(error) });
				})
				.finally(() => process.exit(0));
		},
		getContextUsage: () => host.getContextUsage(),
		waitForIdle: () => host.waitForIdle(),
		newSession: async options => {
			const success = await host.newSession({ parentSession: options?.parentSession });
			if (!success) {
				return { cancelled: true };
			}
			if (options?.setup) {
				await options.setup(host.sessionManager);
			}
			return { cancelled: false };
		},
		branch: async entryId => {
			const result = await host.branch(entryId);
			return { cancelled: result.cancelled };
		},
		navigateTree: async (targetId, options) => {
			const result = await host.navigateTree(targetId, { summarize: options?.summarize });
			return { cancelled: result.cancelled };
		},
		compact: async instructionsOrOptions => {
			const instructions = typeof instructionsOrOptions === "string" ? instructionsOrOptions : undefined;
			const options =
				instructionsOrOptions && typeof instructionsOrOptions === "object" ? instructionsOrOptions : undefined;
			await host.compact(instructions, options);
		},
		switchSession: async sessionPath => {
			const success = await host.switchSession(sessionPath);
			return { cancelled: !success };
		},
		reload: async () => {
			await host.reload();
		},
		getSystemPrompt: () => host.systemPrompt,
	};
}

/**
 * Try to execute a custom command. Returns the prompt string if found, null otherwise.
 * If the command returns void, returns empty string to indicate it was handled.
 *
 * A plugin command is registered as `<plugin>:<name>`; `resolveSlashCommand` matches it from
 * either `/<plugin>:<name>` or `/<plugin> <name>`.
 *
 * A command that produced a prompt gets its declared agents granted, through `grantAgent`, for
 * the turn that prompt starts, so `/review` still spawns `reviewer` on a stock install where every
 * bundled specialist is disabled. Granted only for a real prompt: a fire-and-forget command starts
 * no turn, so a grant would have nothing to scope it and would sit open until the next settle.
 */
export async function tryExecuteCustomCommand(
	host: SessionCommandHost,
	commands: ReadonlyArray<LoadedCustomCommand>,
	text: string,
	grantAgent: (agent: string) => void,
): Promise<string | null> {
	if (commands.length === 0) return null;

	const parsed = parseSlashCommand(text);
	if (!parsed) return null;

	const resolved = resolveSlashCommand(parsed, name => commands.find(c => c.command.name === name));
	if (!resolved) return null;
	const { command: loaded, args: argsString } = resolved;
	const commandName = loaded.command.name;

	// Get command context from extension runner (includes session control methods)
	const baseCtx = createSessionCommandContext(host);
	const ctx: HookCommandContext = {
		...baseCtx,
		hasQueuedMessages: baseCtx.hasPendingMessages,
		// Optional on the extension context, required on the hook one: a session built without an
		// extension runner has no runner transform, and the session's own is the same boundary.
		obfuscateProviderText: baseCtx.obfuscateProviderText ?? (text => host.obfuscateProviderText(text)),
	};

	try {
		const args = parseCommandArgs(argsString);
		const result = await loaded.command.execute(args, ctx);
		// If result is a string, it's a prompt to send to LLM
		// If void/undefined, command handled everything
		if (typeof result === "string" && result.length > 0) {
			const agents = loaded.command.spawnsAgents;
			if (agents) for (const agent of agents) grantAgent(agent);
		}
		return result ?? "";
	} catch (err) {
		// Emit error via extension runner
		if (host.extensionRunner) {
			host.extensionRunner.emitError({
				extensionPath: `custom-command:${commandName}`,
				event: "command",
				error: errorMessage(err),
			});
		} else {
			const message = errorMessage(err);
			logger.error("Custom command failed", { commandName, error: message });
		}
		return ""; // Command was handled (with error)
	}
}
