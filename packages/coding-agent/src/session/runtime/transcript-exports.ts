/**
 * What a reader takes out of the session's transcript: the HTML export, the last assistant text and
 * the handoff a copy picks up, the plain-text dump, and the snapshot of the request the model would be
 * sent, written to a file.
 *
 * This is a session collaborator. It holds no state and reads the session only through
 * {@link TranscriptExportsHost}.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage, AgentState, ThinkingLevel } from "@veyyon/agent-core";
import type { Message, Model, ServiceTierByFamily } from "@veyyon/ai";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { privateTempDir, Snowflake } from "@veyyon/utils";
import type { SecretObfuscator } from "../../secrets/obfuscator";
import { lastCopyCandidateAssistantMessage } from "../agent-session-message-shapes";
import type { CustomMessage } from "../messages";
import { formatSessionDumpText } from "../session-dump-format";

/** What {@link TranscriptExports} needs from the session that holds it. */
export interface TranscriptExportsHost {
	readonly agent: { readonly state: AgentState };
	/** The transcript file an HTML export reads. */
	readonly sessionStore: SessionManager;
	/** The thinking level the session's requests carry. */
	thinkingLevel(): ThinkingLevel | undefined;
	/** The service tier the session's requests carry, per provider family. */
	serviceTierEntry(): ServiceTierByFamily | null;
	/** Whether the request for `model` leaves tool descriptions out of the tool definitions. */
	pruneToolDescriptions(model: Model): boolean;
	/** `messages` as the session's request pipeline converts them for the provider. */
	convertMessagesToLlm(messages: AgentMessage[]): Promise<Message[]>;
	/** The redactor an HTML export runs, or `undefined` when shares keep secrets as they are. */
	shareRedactor(): SecretObfuscator | undefined;
}

/** The text blocks of `content` joined, trimmed, and `undefined` when that leaves nothing. */
function joinedText(content: CustomMessage["content"]): string | undefined {
	if (typeof content === "string") return content.trim() || undefined;
	let text = "";
	for (const block of content) {
		if (block.type === "text") text += block.text;
	}
	return text.trim() || undefined;
}

export class TranscriptExports {
	readonly #host: TranscriptExportsHost;

	constructor(host: TranscriptExportsHost) {
		this.#host = host;
	}

	/** Write the session as HTML in the veyyon web palette and return the file it wrote. */
	async toHtml(outputPath: string | undefined): Promise<string> {
		const host = this.#host;
		// Public HTML export ships in the veyyon brand palette (collab-web
		// pink/purple), matching share.veyyon.dev — not the host's terminal theme.
		// Callers who want a themed export can pass `palette: "theme"` with
		// `themeName` directly to `exportSessionToHtml`.
		// Lazy by necessity, not by oversight. `export/html` text-imports the
		// gitignored `tool-views.generated.js`, and Bun resolves that text import
		// when an importer merely parses, so a static import here turns a missing
		// generated file into a boot failure rather than an export failure
		// (source-install launch failure, 2026-07-24). This is the one carve-out
		// from the no-inline-import rule and it stays.
		const { exportSessionToHtml } = await import("../../export/html");
		return exportSessionToHtml(host.sessionStore, host.agent.state, {
			outputPath,
			cwd: host.sessionStore.getCwd(),
			palette: "web",
			obfuscator: host.shareRedactor(),
		});
	}

	/** The text of the last assistant message a copy picks up, or `undefined` when none has text. */
	lastAssistantText(): string | undefined {
		const lastAssistant = lastCopyCandidateAssistantMessage(this.#host.agent.state.messages);
		if (!lastAssistant) return undefined;
		let text = "";
		for (const content of lastAssistant.content) {
			if (content.type === "text") text += content.text;
		}
		return text.trim() || undefined;
	}

	/** Whether the transcript holds an assistant message a copy picks up. */
	hasCopyCandidateAssistantMessage(): boolean {
		return lastCopyCandidateAssistantMessage(this.#host.agent.state.messages) !== undefined;
	}

	/**
	 * The text of the most recent visible handoff message. A fresh handoff session stores the handoff
	 * as a custom message, not an assistant message, so a copy falls back to it before the new session
	 * has an assistant response.
	 */
	lastVisibleHandoffText(): string | undefined {
		const messages = this.#host.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "custom") continue;
			const customMessage = message as CustomMessage;
			if (customMessage.customType !== "handoff" || !customMessage.display) continue;
			return joinedText(customMessage.content);
		}
		return undefined;
	}

	/**
	 * The session as plain text for the clipboard: system prompt, model and thinking configuration,
	 * tool inventory, and the transcript under markdown role headings (`## User`, `## Assistant`,
	 * `### Tool Call`/`### Tool Result`).
	 */
	asText(): string {
		const host = this.#host;
		const state = host.agent.state;
		return formatSessionDumpText({
			messages: state.messages,
			systemPrompt: state.systemPrompt,
			model: state.model,
			thinkingLevel: host.thinkingLevel(),
			tools: state.tools,
			inlineToolDescriptors: state.model ? host.pruneToolDescriptions(state.model) : false,
		});
	}

	/**
	 * Write the request the session would send next, as JSON, to an auto-named file in the user's private
	 * temp directory (`privateTempDir()`):
	 * system prompt, tools (wire schemas), thinking and service tier, and the converted messages. No
	 * network round trip runs and no flag is armed, so an advisor or side request cannot intercept it.
	 * The file holds the same raw context and secrets as `/dump`.
	 *
	 * @returns the written file path, or `undefined` when the transcript holds no messages.
	 */
	async writeRequestSnapshot(): Promise<string | undefined> {
		const host = this.#host;
		const state = host.agent.state;
		const messages = state.messages;
		if (messages.length === 0) return undefined;
		const llmMessages = await host.convertMessagesToLlm(messages);
		const payload = {
			model: state.model ?? null,
			thinkingLevel: host.thinkingLevel() ?? null,
			serviceTier: host.serviceTierEntry(),
			systemPrompt: state.systemPrompt,
			tools: state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: toolWireSchema(tool),
				...(tool.strict !== undefined ? { strict: tool.strict } : {}),
				...(tool.customWireName ? { customWireName: tool.customWireName } : {}),
			})),
			messages: llmMessages,
		};
		const filePath = path.join(privateTempDir(), `veyyon-llm-request-${Snowflake.next()}.json`);
		await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return filePath;
	}
}
