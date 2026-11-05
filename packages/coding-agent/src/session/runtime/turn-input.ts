/**
 * Turn input: the context a prompt carries beside its own message, built from what the session holds
 * when the prompt is sent.
 *
 * This is a session collaborator with no state of its own. It reaches the session only through
 * {@link TurnInputHost}.
 *
 * - **The mode blocks** ({@link TurnInput.modeBlocks}) restate, on every prompt while each applies,
 *   the approved plan's reference, the plan-mode rules, the active goal with the todo board, and vibe
 *   mode. {@link TurnInput.goalBlock} and {@link TurnInput.vibeBlock} build the last two alone for a
 *   caller that delivers one outside a prompt.
 * - **The file mentions** ({@link TurnInput.fileMentions}) read each `@path` the prompt text names,
 *   priced, anchored and snapshotted the way a `read` tool result is.
 * - **The extension input** ({@link TurnInput.beforeAgentStart}) runs the `before_agent_start`
 *   handlers, returns the messages they add with the prompt's attribution, and installs the system
 *   prompt the turn runs with.
 */
import type { Agent, AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, Model } from "@veyyon/ai";
import { prompt } from "@veyyon/utils";
// The owning module, not the `../../edit` barrel, which `export *`s the streaming applier, the hashline
// engine and the EditTool and pulls in 44 modules nothing else here reaches.
import { type FileSnapshotStoreOwner, getFileSnapshotStore } from "../../edit/file-snapshot-store";
import { goalsPrompts } from "../../prompts/goals/rows";
import { sessionPrompts } from "../../prompts/session/rows";
import type { InlinePricingSource } from "../../tools/core/output-artifact";
import { type FileDisplayModeSession, resolveFileDisplayMode } from "../../utils/file-display-mode";
import { extractFileMentions, generateFileMentionMessages } from "../../utils/file-mentions";
import { webpExclusionForModel } from "../../utils/image-loading";
import type { AgentSessionConfig } from "../agent-session-types";
import { type CustomMessage, normalizeCustomMessagePayload } from "../messages";
import type { ImageAttachments } from "./image-attachments";
import type { PlanModeRuntime } from "./plan-mode-runtime";

/**
 * The session as reading a mentioned file uses it, passed through wholesale: the turn and settings
 * that price the inline budget, the edit tool and edit mode that decide hashline anchors, and the
 * snapshot store that records what the model saw.
 */
export type MentionSource = InlinePricingSource & FileDisplayModeSession & FileSnapshotStoreOwner;

/** What {@link TurnInput} needs from the session that holds it. */
export interface TurnInputHost {
	/** Plan mode, which builds the approved plan's reference and the plan-mode rules. */
	readonly planMode: Pick<PlanModeRuntime, "buildReferenceMessage" | "buildContextMessage">;
	/** Normalizes the images an extension's message carries for the active model. */
	readonly images: Pick<ImageAttachments, "normalizeMessage">;
	/** The extension runner whose `before_agent_start` handlers a prompt runs. */
	readonly config: Pick<AgentSessionConfig, "extensionRunner">;
	/** The agent the turn's system prompt is installed on. */
	readonly agent: Pick<Agent, "setSystemPrompt">;
	/** The session a mentioned file is read against. */
	readonly mentionSource: MentionSource;
	/** The active goal's prompt, or undefined when no goal is active. */
	activeGoalPrompt(): string | undefined;
	/** The todo board as a goal block states it, or undefined when it has nothing to state. */
	goalTodoContext(): string | undefined;
	/** Whether vibe mode is on. */
	vibeModeEnabled(): boolean;
	/** The working directory a mentioned path resolves against. */
	cwd(): string;
	/** The model the turn goes to; a model that cannot decode WebP gets mentioned images re-encoded. */
	model(): Model | undefined;
	/** Whether mentioned images are resized to the provider's limits (`images.autoResize`). */
	autoResizeImages(): boolean;
	/** The system prompt the tools and settings built, which extensions may replace for one turn. */
	baseSystemPrompt(): string[];
}

export class TurnInput {
	readonly #host: TurnInputHost;

	constructor(host: TurnInputHost) {
		this.#host = host;
	}

	/** The mode blocks a prompt opens with, in order: plan reference, plan rules, goal, vibe mode. */
	async modeBlocks(): Promise<AgentMessage[]> {
		const blocks: AgentMessage[] = [];
		const planReference = await this.#host.planMode.buildReferenceMessage();
		if (planReference) blocks.push(planReference);
		const planRules = await this.#host.planMode.buildContextMessage();
		if (planRules) blocks.push(planRules);
		const goal = this.goalBlock();
		if (goal) blocks.push(goal);
		const vibe = this.vibeBlock();
		if (vibe) blocks.push(vibe);
		return blocks;
	}

	/** The active goal with the todo board, or null when no goal is active. */
	goalBlock(): CustomMessage | null {
		const goalContext = this.#host.activeGoalPrompt();
		if (!goalContext) return null;
		const todoContext = this.#host.goalTodoContext();
		return {
			role: "custom",
			customType: "goal-mode-context",
			content: prompt.render(goalsPrompts["goals/goal-mode-context"].text, { goalContext, todoContext }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** The vibe-mode rules, or null when vibe mode is off. */
	vibeBlock(): CustomMessage | null {
		if (!this.#host.vibeModeEnabled()) return null;
		return {
			role: "custom",
			customType: "vibe-mode-context",
			content: prompt.render(sessionPrompts["session/vibe-mode-active"].text),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** The files `text` mentions as `@path`; empty when it mentions none or none could be read. */
	async fileMentions(text: string): Promise<AgentMessage[]> {
		const paths = extractFileMentions(text);
		if (paths.length === 0) return [];
		const host = this.#host;
		const source = host.mentionSource;
		return generateFileMentionMessages(paths, host.cwd(), source, {
			autoResizeImages: host.autoResizeImages(),
			excludeWebP: webpExclusionForModel(host.model()),
			useHashLines: resolveFileDisplayMode(source).hashLines,
			snapshotStore: getFileSnapshotStore(source),
		});
	}

	/**
	 * Run the `before_agent_start` handlers for a prompt and return the messages they add.
	 *
	 * A message a handler returns without its own `user` or `agent` attribution takes the prompt's:
	 * the attribution `message` carries, else `user` for a user message and `agent` for anything
	 * else. Once the messages are normalized, the system prompt the handlers settled on is installed
	 * on the agent, or the base system prompt when none replaced it or no extension is loaded.
	 */
	async beforeAgentStart(
		text: string,
		images: ImageContent[] | undefined,
		message: AgentMessage,
	): Promise<AgentMessage[]> {
		const host = this.#host;
		const baseSystemPrompt = host.baseSystemPrompt();
		const runner = host.config.extensionRunner;
		if (!runner) {
			host.agent.setSystemPrompt(baseSystemPrompt);
			return [];
		}
		const result = await runner.emitBeforeAgentStart(text, images, baseSystemPrompt);
		const added: AgentMessage[] = [];
		if (result?.messages) {
			const promptAttribution = "attribution" in message ? message.attribution : undefined;
			const fallbackAttribution = promptAttribution ?? (message.role === "user" ? "user" : "agent");
			for (const msg of result.messages) {
				const normalized = normalizeCustomMessagePayload(msg);
				const hasExplicitAttribution =
					msg !== null &&
					typeof msg === "object" &&
					!Array.isArray(msg) &&
					(msg.attribution === "user" || msg.attribution === "agent");
				added.push(
					await host.images.normalizeMessage({
						role: "custom",
						customType: normalized.customType,
						content: normalized.content,
						display: normalized.display,
						details: normalized.details,
						attribution: hasExplicitAttribution ? normalized.attribution : fallbackAttribution,
						timestamp: Date.now(),
					}),
				);
			}
		}
		host.agent.setSystemPrompt(result?.systemPrompt ?? baseSystemPrompt);
		return added;
	}
}
