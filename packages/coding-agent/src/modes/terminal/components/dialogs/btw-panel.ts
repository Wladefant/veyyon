import { type Component, Container, Markdown, Text, type TUI } from "@veyyon/tui";
import { getMarkdownTheme } from "../../../../theme/markdown-theme";
import { theme } from "../../../../theme/theme";
import { replaceTabs, sanitizeErrorLine } from "../../../../tools/core/render-utils";
import { COMPOSER_INSET_COLS } from "../composer/composer-chrome";
import { mountTranscriptBlock } from "../transcript/transcript-block-chrome";

/** Exported so a caller (and the rail suite) can enumerate every state the panel paints. */
export type BtwPanelState = "running" | "complete" | "branching" | "aborted" | "error";

interface BtwPanelComponentOptions {
	question: string;
	tui: TUI;
	/** Whether the controller would accept `b` now. Read at paint time, so the hint tracks the main turn. */
	canBranch?: () => boolean;
	/** Whether the controller would accept `f` now; read at paint time like {@link canBranch}. */
	canFollowUp?: () => boolean;
}

export class BtwPanelComponent extends Container {
	#question: string;
	#tui: TUI;
	#canBranch: (() => boolean) | undefined;
	#canFollowUp: (() => boolean) | undefined;
	#state: BtwPanelState = "running";
	#answer = "";
	#errorMessage: string | undefined;
	#visibleAnswer = "";
	#closed = false;

	constructor(options: BtwPanelComponentOptions) {
		super();
		this.#question = options.question;
		this.#tui = options.tui;
		this.#canBranch = options.canBranch;
		this.#canFollowUp = options.canFollowUp;
		this.#rebuild();
	}

	appendText(delta: string): void {
		if (!delta || this.#closed) return;
		this.#answer += delta;
		this.#visibleAnswer = replaceTabs(this.#answer).trim();
		this.#rebuild();
	}

	setAnswer(text: string): void {
		if (this.#closed) return;
		this.#answer = text;
		this.#visibleAnswer = replaceTabs(text).trim();
		this.#rebuild();
	}

	markComplete(): void {
		this.#settle("complete");
	}

	/** Shows that the completed answer is being promoted into the chat session. */
	markBranching(): void {
		this.#settle("branching");
	}

	markAborted(): void {
		this.#settle("aborted");
	}

	markError(message: string): void {
		this.#settle("error", message);
	}

	#settle(state: BtwPanelState, errorMessage?: string): void {
		if (this.#closed) return;
		this.#state = state;
		this.#errorMessage = errorMessage;
		this.#rebuild();
	}

	isBranchable(): boolean {
		return this.isCopyable();
	}

	isCopyable(): boolean {
		return this.#state === "complete" && this.#visibleAnswer.length > 0;
	}

	getCopyText(): string | undefined {
		if (!this.isCopyable()) return undefined;
		return this.#visibleAnswer;
	}

	close(): void {
		this.#closed = true;
	}

	#rebuild(): void {
		mountTranscriptBlock(this, {
			header: theme.bold(theme.fg("accent", replaceTabs(`/btw ${this.#question}`))),
			body: this.#contentComponent(),
			footer: () => this.#footerLine(),
		});
		// Component-scoped: a rebuild replaces only this panel's own children
		// (streaming deltas arrive per token, and a full compose would re-walk
		// the whole transcript each time). Before the panel is mounted the TUI
		// cannot resolve it and falls back to a full compose on its own.
		this.#tui.requestComponentRender(this);
	}

	#footerLine(): string {
		switch (this.#state) {
			case "running":
				return theme.fg("muted", "Esc cancel /btw");
			case "complete": {
				const actions: string[] = [];
				if (this.isCopyable()) actions.push("c copy");
				if (this.#canFollowUp?.()) actions.push("f follow up");
				if (this.isCopyable() && (this.#canBranch?.() ?? this.isBranchable())) actions.push("b branch to chat");
				actions.push("Esc dismiss");
				return theme.fg("muted", actions.join(" · "));
			}
			case "branching":
				return theme.fg("muted", `${theme.status.pending} Branching to chat…`);
			case "aborted":
				return theme.fg("warning", `${theme.status.warning} Cancelled · Esc dismiss`);
			case "error":
				return theme.fg("error", `${theme.status.error} Error · Esc dismiss`);
		}
	}

	#contentComponent(): Component {
		if (this.#state === "error") {
			return new Text(theme.fg("error", sanitizeErrorLine(this.#errorMessage ?? "Unknown error")), COMPOSER_INSET_COLS, 0);
		}
		const text = this.#visibleAnswer;
		if (!text) {
			const waiting =
				this.#state === "running" ? `${theme.status.pending} Waiting for response…` : "No text returned.";
			return new Text(theme.fg("dim", waiting), COMPOSER_INSET_COLS, 0);
		}
		return new Markdown(text, COMPOSER_INSET_COLS, 0, getMarkdownTheme());
	}
}
