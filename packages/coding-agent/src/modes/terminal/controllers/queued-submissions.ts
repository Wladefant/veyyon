/**
 * Messages queued for when the agent yields: the `/queue` command and its `->` / `=>` shorthand, the
 * compaction queue, and handing every queued message back to the editor on Alt+Up or Esc.
 */
import type { ImageContent } from "@veyyon/ai";
import { abortDetached } from "@veyyon/kernel/session/detached-abort";
import { errorMessage } from "@veyyon/utils";
import { USER_INTERRUPT_LABEL } from "../../../session/messages";
import { shiftImageMarkers } from "../image-reference-markers";
import { splitQueuedMessages } from "../queue-input";
import type { InputControllerContext } from "./input-controller";
import { nonEmptyCopy, pendingDraftImages, restoreDraft } from "./submitted-input";

/** The context members the queue reads. */
export type QueuedSubmissionsContext = Pick<
	InputControllerContext,
	| "compactionQueuedMessages"
	| "editor"
	| "locallySubmittedUserSignatures"
	| "onInputCallback"
	| "session"
	| "showError"
	| "showStatus"
	| "showWarning"
	| "startPendingSubmission"
	| "ui"
	| "updatePendingMessagesDisplay"
	| "withLocalSubmission"
>;

/** A `/queue` submission split into the messages it sends, with the images that ride on the first. */
interface QueuedBatch {
	readonly messages: readonly string[];
	readonly images: ImageContent[] | undefined;
	readonly imageLinks: (string | undefined)[] | undefined;
	/** What the editor holds again when the first message fails: the line as typed, or the batch as an `=>` queue. */
	readonly draft: string;
	/** The session was idle with nothing queued, so the first message starts a turn. */
	readonly startImmediately: boolean;
}

/** The status once every message of a queued batch went out; `startedTurn` when the first one began a turn. */
function queuedStatus(count: number, startedTurn: boolean): string {
	if (count === 1) return startedTurn ? "Sent queued message" : "Queued message for when the agent yields";
	if (startedTurn) return `Sent first message; queued ${count - 1} for later yields`;
	return `Queued ${count} messages for when the agent yields`;
}

/** The `=>` draft that queues `remaining` again when it is submitted. */
function requeuedDraft(remaining: readonly string[]): string {
	if (remaining.length === 1) return `=> ${remaining[0]}`;
	return `=>\n${remaining.map((message, index) => `${index + 1}. ${message.replaceAll("\n", "\n   ")}`).join("\n")}`;
}

export class QueuedSubmissions {
	constructor(private readonly ctx: QueuedSubmissionsContext) {}

	handleDequeue(): void {
		const restored = this.restoreToEditor();
		if (restored === 0) {
			this.ctx.showStatus("No queued messages to restore");
		} else {
			this.ctx.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	/** Queue `/queue` input behind an active turn, or start it immediately when idle. */
	async handleQueueCommand(text: string): Promise<void> {
		await this.queue(text, pendingDraftImages(this.ctx.editor));
	}

	/** Queues `text`, split into its messages, for when the agent yields; `historyText` is what Up Arrow recalls. */
	async queue(
		text: string,
		options: {
			historyText?: string;
			images?: ImageContent[];
			imageLinks?: (string | undefined)[];
		},
	): Promise<void> {
		const splitMessages = splitQueuedMessages(text);
		if (splitMessages.length === 0 && !options.images?.length) {
			this.ctx.editor.clearDraft();
			this.ctx.showWarning("Usage: /queue <message> (or start a prompt with -> / =>)");
			return;
		}

		const messages = splitMessages.length > 0 ? splitMessages : [""];
		// Enter empties the composer before the submission arrives, so a batch it sent is handed back as
		// the `=>` queue it was; Ctrl+Enter leaves the line in place, and that line is handed back as typed.
		const draft = this.ctx.editor.getText() || (splitMessages.length > 0 ? requeuedDraft(splitMessages) : "");
		const images = nonEmptyCopy(options.images);
		const imageLinks = options.imageLinks ? [...options.imageLinks] : images?.map(() => undefined);
		this.ctx.editor.clearDraft(options.historyText);

		if (this.ctx.session.isCompacting) {
			this.#queueForCompaction(messages, images);
			return;
		}

		const startImmediately = !this.ctx.session.isStreaming && this.ctx.session.queuedMessageCount === 0;
		const sent = await this.#sendQueued({ messages, images, imageLinks, draft, startImmediately });
		this.ctx.updatePendingMessagesDisplay();
		if (sent === messages.length) this.ctx.showStatus(queuedStatus(sent, startImmediately));
		this.ctx.ui.requestRender();
	}

	/** Queues `messages` to send once compaction ends, the images riding on the first. */
	#queueForCompaction(messages: readonly string[], images: ImageContent[] | undefined): void {
		for (let index = 0; index < messages.length; index++) {
			this.ctx.compactionQueuedMessages.push({
				text: messages[index] ?? "",
				mode: "followUp",
				images: index === 0 ? images : undefined,
			});
		}
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus(
			messages.length === 1
				? "Queued message for after compaction"
				: `Queued ${messages.length} messages for after compaction`,
		);
		this.ctx.ui.requestRender();
	}

	/**
	 * Sends a queued batch in order and returns how many messages went out. When the session was idle the first
	 * message starts a turn. A failure puts what did not go out back in the editor: the batch's draft with its
	 * images when nothing went out, else the rest as an `=>` queue.
	 */
	async #sendQueued({ messages, images, imageLinks, draft, startImmediately }: QueuedBatch): Promise<number> {
		let sent = 0;
		try {
			if (startImmediately && this.ctx.onInputCallback) {
				const submission = this.ctx.startPendingSubmission({
					text: messages[0] ?? "",
					images,
					imageLinks,
					streamingBehavior: "followUp",
				});
				this.ctx.onInputCallback(submission);
				sent = 1;
			}
			for (; sent < messages.length; sent++) {
				const message = messages[sent] ?? "";
				const sentImages = sent === 0 ? images : undefined;
				const startsTurn = startImmediately && sent === 0;
				await this.ctx.withLocalSubmission(
					message,
					async () => {
						if (startsTurn)
							await this.ctx.session.prompt(message, { images: sentImages, streamingBehavior: "followUp" });
						else await this.ctx.session.followUp(message, sentImages);
					},
					{ imageCount: sentImages?.length ?? 0 },
				);
			}
		} catch (error) {
			if (sent === 0) restoreDraft(this.ctx.editor, draft, images, imageLinks);
			else this.ctx.editor.setText(requeuedDraft(messages.slice(sent)));
			this.ctx.showError(errorMessage(error));
		}
		return sent;
	}

	/**
	 * Moves every queued message, the agent queue and the compaction queue, back into the editor ahead of
	 * `currentText`, and returns how many came back. `abort` drops internal steers and aborts the turn.
	 */
	restoreToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.ctx.locallySubmittedUserSignatures.clear();
		// On Esc (abort) drop non-user internal steers so the post-abort drain can't
		// auto-resume; plain Alt+Up dequeue preserves them for the continuing stream.
		const { steering, followUp } = this.ctx.session.clearQueue({ forInterrupt: options?.abort });
		// Messages typed while compacting live in `compactionQueuedMessages`, not the
		// agent queue `clearQueue()` drains — but the pending bar shows the same
		// "Alt+Up to edit" hint for them (ui-helpers `updatePendingMessagesDisplay`).
		// Drain them here too so the dequeue restores every message the hint
		// advertises; otherwise a skill/text queued during compaction is stranded and
		// Alt+Up reports "No queued messages to restore".
		const compactionQueued = this.ctx.compactionQueuedMessages;
		this.ctx.compactionQueuedMessages = [];
		const allQueued = [
			...steering,
			...compactionQueued.filter(e => e.mode === "steer").map(e => ({ text: e.text, images: e.images })),
			...followUp,
			...compactionQueued.filter(e => e.mode === "followUp").map(e => ({ text: e.text, images: e.images })),
		];
		if (allQueued.length === 0) {
			this.ctx.updatePendingMessagesDisplay();
			if (options?.abort) {
				abortDetached(this.ctx.session, "queued-submissions.restoreToEditor.empty", USER_INTERRUPT_LABEL);
			}
			return 0;
		}
		// Image markers are positional: `[Image #N]` ↔ `pendingImages[N-1]`. Each
		// queued message numbered its markers against its own local image list
		// (1..K). Because we prepend the queued text but append the queued images
		// to `pendingImages`, any existing draft images (M of them) — plus images
		// already pulled in by earlier queued messages — shift the slot index that
		// every marker must point to. Bumping each message's markers by the
		// running offset keeps the merged text aligned with the merged
		// `pendingImages` order; draft markers stay valid because draft images
		// keep their original positions.
		const queuedImages = allQueued.flatMap(e => e.images ?? []);
		let queuedText: string;
		if (queuedImages.length > 0) {
			const parts: string[] = [];
			let imageOffset = this.ctx.editor.pendingImages.length;
			for (const entry of allQueued) {
				parts.push(shiftImageMarkers(entry.text, imageOffset));
				if (entry.images && entry.images.length > 0) imageOffset += entry.images.length;
			}
			queuedText = parts.join("\n\n");
		} else {
			queuedText = allQueued.map(e => e.text).join("\n\n");
		}
		const currentText = options?.currentText ?? this.ctx.editor.getText();
		const combinedText = [queuedText, currentText].filter(t => t.trim()).join("\n\n");
		this.ctx.editor.setText(combinedText);
		// Hand queued images back to the pending-image buffer (links are
		// re-materialized lazily; the restored text already carries the
		// renumbered `[Image #N, WxH]` markers).
		if (queuedImages.length > 0) {
			this.ctx.editor.pendingImages.push(...queuedImages);
			this.ctx.editor.pendingImageLinks.push(...queuedImages.map(() => undefined));
			this.ctx.editor.imageLinks = this.ctx.editor.pendingImageLinks;
		}
		this.ctx.updatePendingMessagesDisplay();
		if (options?.abort) {
			abortDetached(this.ctx.session, "queued-submissions.restoreToEditor.restored", USER_INTERRUPT_LABEL);
		}
		return allQueued.length;
	}
}
