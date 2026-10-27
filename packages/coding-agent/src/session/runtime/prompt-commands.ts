/**
 * Prompt commands: the commands and templates a typed prompt resolves through before it reaches the
 * model, and the agents a command grants for the turn it starts.
 *
 * This is a session collaborator. It holds the command registries and reaches the session only
 * through {@link SessionCommandHost}, the slice a command's context reads.
 *
 * - **Resolution** ({@link PromptCommands.resolve}) runs an extension command, then a custom command
 *   (TypeScript or MCP prompt), then a file-based slash command, then the prompt templates, and
 *   rejects a `/name` none of them resolved.
 * - **Queued text** ({@link PromptCommands.expandQueued}) is a steer or a follow-up: an extension
 *   command is rejected there, and the templates expand.
 * - **The registries** change at run time: file-based commands through
 *   {@link PromptCommands.setSlashCommands}, MCP prompts through
 *   {@link PromptCommands.setMCPPromptCommands}, which notifies the command-metadata listeners.
 * - **Agent grants** ({@link PromptCommands.agentGranted}) are the agent types a custom command
 *   declared, held for the turn it started and cleared when that turn settles.
 */
import { logger } from "@veyyon/utils";
import { expandPromptTemplate, type PromptTemplate } from "../../config/prompt-templates";
import type { LoadedCustomCommand } from "../../extensibility/custom-commands/types";
import { expandSlashCommand, type FileSlashCommand } from "../../extensibility/slash-commands";
import {
	parseSlashCommand,
	unknownSlashCommandMessage,
	unresolvedSlashCommandName,
} from "../../slash-commands/helpers/parse";
import {
	type SessionCommandHost,
	throwIfExtensionCommand,
	tryExecuteCustomCommand,
	tryExecuteExtensionCommand,
} from "../agent-session-commands";
import type { CommandMetadataChangedListener } from "../agent-session-types";

/** The registries a session starts with. */
export interface PromptCommandsInit {
	promptTemplates?: PromptTemplate[];
	slashCommands?: FileSlashCommand[];
	customCommands?: LoadedCustomCommand[];
}

/** How {@link PromptCommands.resolve} treats one prompt. */
export interface PromptResolveOptions {
	/** False sends the text as typed: no command runs and no template expands. */
	expandPromptTemplates: boolean;
	/** An agent-authored prompt, which is never refused as an unknown command. */
	synthetic: boolean;
}

export class PromptCommands {
	readonly #host: SessionCommandHost;
	readonly #promptTemplates: PromptTemplate[];
	#slashCommands: FileSlashCommand[];
	/** TypeScript slash commands. */
	readonly #customCommands: LoadedCustomCommand[];
	/** MCP prompt commands, replaced whenever the servers' prompts (re)load. */
	#mcpPromptCommands: LoadedCustomCommand[] = [];
	readonly #metadataListeners: CommandMetadataChangedListener[] = [];
	/**
	 * Agent types a `/` command declared for the turn it just started.
	 *
	 * Granted from the command's static `spawnsAgents` list, never from anything a handler computed
	 * while running, so "which commands can reach a disabled agent" is answerable by reading the
	 * command definitions. Empty except between a command returning a prompt and that prompt's run
	 * settling: cleared on BOTH settle paths, the normal one and the reset an abort takes, because a
	 * grant that survived an aborted turn would leave a disabled agent open to the model's next
	 * unrelated spawn.
	 */
	readonly #grantedAgents = new Set<string>();

	constructor(host: SessionCommandHost, init: PromptCommandsInit) {
		this.#host = host;
		this.#promptTemplates = init.promptTemplates ?? [];
		this.#slashCommands = init.slashCommands ?? [];
		this.#customCommands = init.customCommands ?? [];
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this.#promptTemplates;
	}

	/** Replace the file-based slash commands a prompt expands through. */
	setSlashCommands(slashCommands: FileSlashCommand[]): void {
		this.#slashCommands = [...slashCommands];
	}

	/** Custom commands: the TypeScript slash commands, then the MCP prompts. */
	get customCommands(): ReadonlyArray<LoadedCustomCommand> {
		if (this.#mcpPromptCommands.length === 0) return this.#customCommands;
		return [...this.#customCommands, ...this.#mcpPromptCommands];
	}

	/** MCP prompt commands only, for command-list metadata. */
	get mcpPromptCommands(): ReadonlyArray<LoadedCustomCommand> {
		return this.#mcpPromptCommands;
	}

	/** Replace the MCP prompt commands and notify the command-metadata listeners. */
	setMCPPromptCommands(commands: LoadedCustomCommand[]): void {
		this.#mcpPromptCommands = commands;
		this.#notifyMetadataChanged();
	}

	subscribeMetadataChanged(listener: CommandMetadataChangedListener): () => void {
		this.#metadataListeners.push(listener);
		return () => {
			const index = this.#metadataListeners.indexOf(listener);
			if (index !== -1) {
				this.#metadataListeners.splice(index, 1);
			}
		};
	}

	/** Whether a `/` command has granted this agent type for the turn in flight. */
	agentGranted(agentName: string): boolean {
		return this.#grantedAgents.has(agentName);
	}

	/** Drop the turn's grants; the turn they were given for has settled. */
	clearGrantedAgents(): void {
		this.#grantedAgents.clear();
	}

	/**
	 * The text a prompt sends once its commands and templates resolve, or `undefined` when a command
	 * handled it without the model. Throws on a `/name` nothing resolved.
	 */
	async resolve(text: string, options: PromptResolveOptions): Promise<string | undefined> {
		if (!options.expandPromptTemplates) return text;
		if (text.startsWith("/")) {
			// Extension commands first; they run immediately, even during streaming.
			if (await tryExecuteExtensionCommand(this.#host.extensionRunner, text)) return undefined;

			const customResult = await tryExecuteCustomCommand(this.#host, this.customCommands, text, agent =>
				this.#grantedAgents.add(agent),
			);
			if (customResult === "") return undefined;
			if (customResult !== null) text = customResult;

			// File-based slash commands (markdown files from commands/ directories). The invocation is
			// rewritten as `/name args` first, so `/name:args` also reaches a prompt template named
			// `name` below. Text a custom command rewrote into prose parses to nothing and passes.
			const parsed = parseSlashCommand(text);
			if (parsed !== null) {
				const invocation = `/${parsed.name}${parsed.args.length > 0 ? ` ${parsed.args}` : ""}`;
				text = expandSlashCommand(invocation, this.#slashCommands);
			}
		}

		const expandedText = expandPromptTemplate(text, this.#promptTemplates);

		// Every resolver has now had its turn: builtins upstream in the dispatcher, then extension,
		// custom, file-based commands and prompt templates above. A text that STILL reads as `/name` is
		// a command this build does not have, and forwarding it to the model is the wrong answer to a
		// typo. It is also the bug this refusal was written for: `/secret list`, typed into a build
		// that predated the command, was sent as prose and the model began grepping the filesystem for
		// secrets files. Synthetic prompts are exempt because an agent-authored turn is never a user
		// reaching for a command.
		if (!options.synthetic && expandedText === text) {
			const unresolved = unresolvedSlashCommandName(text);
			// The name only. The argument tail of a miss on `/secret add` is a credential.
			if (unresolved !== undefined) throw new Error(unknownSlashCommandMessage(unresolved));
		}
		return expandedText;
	}

	/**
	 * The text of a steer or a follow-up. An extension command throws, since it cannot be queued; the
	 * templates expand unless `expandTemplates` is false.
	 */
	expandQueued(text: string, expandTemplates = true): string {
		if (text.startsWith("/")) {
			throwIfExtensionCommand(this.#host.extensionRunner, text);
		}
		return expandTemplates ? expandPromptTemplate(text, this.#promptTemplates) : text;
	}

	#notifyMetadataChanged(): void {
		const listeners = this.#metadataListeners.slice();
		for (const listener of listeners) {
			// `CommandMetadataChangedListener` is `() => void | Promise<void>`, so the published contract
			// INVITES an async listener, but a `catch` only ever observes a SYNCHRONOUS throw. A
			// discarded promise let a rejecting async subscriber reach postmortem's global
			// `unhandledRejection` hook, which prints a crash report and calls `process.exit(1)`.
			// `setMCPPromptCommands` runs on every MCP prompt (re)load, reconnects included, so one bad
			// subscriber killed a working session at a moment the user did not act. Both arms land in
			// the SAME sink with the SAME message: a rejection and a throw are one greppable failure.
			try {
				// `unknown` so `instanceof` narrows cleanly off the `void` arm. Only a listener that
				// returned a promise allocates.
				const result: unknown = listener();
				if (result instanceof Promise) {
					result.catch((err: unknown) => {
						logger.error("Command metadata listener threw", { err });
					});
				}
			} catch (err) {
				logger.error("Command metadata listener threw", { err });
			}
		}
	}
}
