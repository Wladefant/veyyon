/**
 * Handing queued messages back to the composer: Alt+Up restores them and leaves the running turn and its
 * internal steers alone, Esc restores them, drops internal steers and interrupts the turn, and either way
 * the local-echo signatures of the handed-back messages are forgotten. `/queue` with no message prints its
 * usage instead of sending an empty one.
 *
 * Subject: `modes/terminal/controllers/queued-submissions.ts`, driven through `QueuedSubmissions` with a
 * recording context.
 *
 * WHAT THIS SUITE DOES NOT CATCH. Marker renumbering and compaction-queue draining are defended by the
 * skill-queue and compaction-image suites; the `/queue` batch send and its partial failure by the
 * submission suites.
 */
import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@veyyon/ai";
import {
	QueuedSubmissions,
	type QueuedSubmissionsContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/queued-submissions";
import { USER_INTERRUPT_LABEL } from "@veyyon/coding-agent/session/messages";

interface Recorded {
	statuses: string[];
	warnings: string[];
	prompts: string[];
	clearQueueOptions: unknown[];
	aborts: unknown[];
}

function harness(options: { queued?: string[]; editorText?: string } = {}) {
	const recorded: Recorded = { statuses: [], warnings: [], prompts: [], clearQueueOptions: [], aborts: [] };
	let editorText = options.editorText ?? "";
	const editor = {
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: [] as readonly (string | undefined)[],
		getText: () => editorText,
		setText: (text: string) => {
			editorText = text;
		},
		clearDraft: () => {
			editorText = "";
		},
	};
	const session = {
		isCompacting: false,
		isStreaming: false,
		queuedMessageCount: 0,
		prompt: async (text: string) => {
			recorded.prompts.push(text);
		},
		followUp: async (text: string) => {
			recorded.prompts.push(text);
		},
		clearQueue: (clearOptions: unknown) => {
			recorded.clearQueueOptions.push(clearOptions);
			const steering = (options.queued ?? []).map(text => ({ text }));
			options.queued = [];
			return { steering, followUp: [] };
		},
		abort: async (abortOptions: unknown) => {
			recorded.aborts.push(abortOptions);
		},
	};
	const ctx = {
		editor,
		session,
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(["sent\u00000"]),
		onInputCallback: undefined,
		showStatus: (message: string) => recorded.statuses.push(message),
		showWarning: (message: string) => recorded.warnings.push(message),
		showError: () => {},
		startPendingSubmission: () => {
			throw new Error("no input waiter in this harness");
		},
		ui: { requestRender: () => {} },
		updatePendingMessagesDisplay: () => {},
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
	} as unknown as QueuedSubmissionsContext;
	return { queue: new QueuedSubmissions(ctx), ctx, recorded, editorText: () => editorText };
}

describe("a queued message comes back to the editor", () => {
	it("leaves the turn and its internal steers alone on Alt+Up", () => {
		const { queue, recorded, editorText } = harness({ queued: ["first", "second"] });

		expect(queue.restoreToEditor()).toBe(2);
		expect(editorText()).toBe("first\n\nsecond");
		expect(recorded.clearQueueOptions).toEqual([{ forInterrupt: undefined }]);
		expect(recorded.aborts).toEqual([]);
	});

	it("drops internal steers and interrupts the turn on Esc", () => {
		const { queue, recorded } = harness({ queued: ["first"] });

		expect(queue.restoreToEditor({ abort: true })).toBe(1);
		expect(recorded.clearQueueOptions).toEqual([{ forInterrupt: true }]);
		expect(recorded.aborts).toEqual([{ reason: USER_INTERRUPT_LABEL }]);
	});

	it("goes ahead of the text the composer held when Esc was pressed, not what it holds now", () => {
		const { queue, editorText } = harness({ queued: ["queued"], editorText: "typed since" });

		queue.restoreToEditor({ abort: true, currentText: "held at Esc" });

		expect(editorText()).toBe("queued\n\nheld at Esc");
	});

	it("forgets the local-echo signatures of what it handed back", () => {
		const { queue, ctx } = harness({ queued: ["first"] });

		queue.restoreToEditor();

		expect([...ctx.locallySubmittedUserSignatures]).toEqual([]);
	});

	it("reports how many came back, and says so when nothing was queued", () => {
		const empty = harness();
		empty.queue.handleDequeue();
		const two = harness({ queued: ["first", "second"] });
		two.queue.handleDequeue();

		expect([empty.recorded.statuses, two.recorded.statuses]).toEqual([
			["No queued messages to restore"],
			["Restored 2 queued messages to editor"],
		]);
	});
});

describe("/queue with no message", () => {
	it("prints its usage and sends nothing", async () => {
		const { queue, recorded } = harness();

		await queue.queue("", {});

		expect({ warnings: recorded.warnings, prompts: recorded.prompts }).toEqual({
			warnings: ["Usage: /queue <message> (or start a prompt with -> / =>)"],
			prompts: [],
		});
	});
});
