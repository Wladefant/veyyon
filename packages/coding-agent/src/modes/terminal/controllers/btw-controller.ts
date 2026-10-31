import type { AssistantMessage } from "@veyyon/ai";
import { errorMessage, prompt } from "@veyyon/utils";
import { sideChannelPrompts } from "../../../prompts/side-channel/rows";
import { copyToClipboard } from "../../../utils/clipboard";
import { BtwPanelComponent } from "../components/dialogs/btw-panel";
import type { InteractiveModeContext } from "../types";
import { SidePanelSlot } from "./side-panel-slot";

/**
 * The slice of the interactive context this controller uses: 7 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
export type BtwControllerContext = Pick<
	InteractiveModeContext,
	"btwContainer" | "handleBtwBranch" | "session" | "sessionManager" | "showError" | "showStatus" | "ui"
>;

interface BtwRequest {
	component: BtwPanelComponent;
	abortController: AbortController;
	question: string;
	leafId: string | null;
	sessionId: string;
	/** Set when the turn finished with an answer the panel can copy and branch; dropped with the request. */
	answer?: { copyText: string; assistantMessage: AssistantMessage };
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

export class BtwController {
	readonly #slot = new SidePanelSlot<BtwRequest>({
		container: () => this.ctx.btwContainer,
		requestRender: () => this.ctx.ui.requestRender(),
	});
	#branchInFlight = false;
	#copyInFlight = false;

	constructor(private readonly ctx: BtwControllerContext) {}

	hasActiveRequest(): boolean {
		return this.#slot.open !== undefined;
	}

	canBranch(): boolean {
		return this.#branchUnavailableReason() === undefined;
	}

	handlesBranchKey(): boolean {
		return this.#branchInFlight || this.#slot.open?.component.isBranchable() === true;
	}

	#branchUnavailableReason(): string | undefined {
		if (this.#branchInFlight) return "a branch is already in progress";
		const request = this.#slot.open;
		if (request?.component.isBranchable() !== true) return "the answer is not ready";
		if (!request.answer) return "the answer is unavailable";
		if (!request.leafId) return "the session has no branch point";
		if (
			request.sessionId !== this.ctx.sessionManager.getSessionId() ||
			request.leafId !== this.ctx.sessionManager.getLeafId()
		) return "the session changed since /btw started";
		if (this.ctx.session.isStreaming) return "a turn is still running";
		return undefined;
	}

	canCopy(): boolean {
		const request = this.#slot.open;
		return !this.#copyInFlight && request?.component.isCopyable() === true && request.answer !== undefined;
	}

	async handleCopy(): Promise<boolean> {
		const answer = this.#slot.open?.answer;
		if (!this.canCopy() || !answer) return false;
		this.#copyInFlight = true;
		try {
			await copyToClipboard(answer.copyText);
			this.ctx.showStatus("Copied /btw answer to clipboard");
			return true;
		} catch (error) {
			this.ctx.showError(errorMessage(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	async handleBranch(): Promise<boolean> {
		const unavailableReason = this.#branchUnavailableReason();
		if (unavailableReason) {
			this.ctx.showStatus(`/btw branch unavailable: ${unavailableReason}`, { dim: true });
			return false;
		}
		const request = this.#slot.open;
		if (!request?.answer) return false;
		this.#branchInFlight = true;
		request.component.markBranching();
		try {
			await this.ctx.handleBtwBranch(
				request.question,
				request.answer.assistantMessage,
				request.leafId!,
				request.sessionId,
			);
			return true;
		} finally {
			this.#branchInFlight = false;
			if (this.#slot.isOpen(request)) request.component.markComplete();
		}
	}

	handleEscape(): boolean {
		if (this.#branchInFlight) {
			this.ctx.showStatus("/btw branch is in progress", { dim: true });
			return true;
		}
		return this.#slot.escape();
	}

	dispose(): void {
		this.#slot.close({ abort: true });
	}

	async start(question: string): Promise<void> {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.ctx.showStatus("Usage: /btw <question>");
			return;
		}

		const model = this.ctx.session.model;
		if (!model) {
			this.ctx.showError("No active model available for /btw.");
			return;
		}

		const request: BtwRequest = {
			component: new BtwPanelComponent({
				question: trimmedQuestion,
				tui: this.ctx.ui,
				canBranch: () => this.canBranch(),
			}),
			abortController: new AbortController(),
			question: trimmedQuestion,
			leafId: this.ctx.sessionManager.getLeafId(),
			sessionId: this.ctx.sessionManager.getSessionId(),
		};
		this.#slot.show(request);
		void this.#slot.run(request, () => this.#ask(request));
	}

	async #ask(request: BtwRequest): Promise<void> {
		const promptText = prompt.render(sideChannelPrompts["side-channel/btw-user"].text, {
			question: request.question,
		});
		const { replyText, assistantMessage } = await this.ctx.session.runEphemeralTurn({
			promptText,
			onTextDelta: delta => {
				if (this.#slot.isOpen(request)) {
					request.component.appendText(delta);
				}
			},
			signal: request.abortController.signal,
		});

		if (!this.#slot.isOpen(request)) {
			return;
		}
		request.component.setAnswer(replyText);
		request.component.markComplete();
		const copyText = request.component.getCopyText();
		if (copyText !== undefined) {
			request.answer = { copyText, assistantMessage: assistantMessageWithReplyText(assistantMessage, replyText) };
		}

	}
}
