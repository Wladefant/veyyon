/**
 * Where an Enter or Ctrl+Enter submission goes, read from the composer state: a collab guest's host-only
 * input stays local and a read-only guest keeps its draft, `!`/`$` input waits behind a running command,
 * compaction queues the text, loop mode takes it as the loop prompt, a focused agent view refuses commands,
 * an extension input handler can consume it, an empty Enter interrupts only a turn with messages queued
 * behind it, a submission snaps the transcript to its live tail, emoticons expand only while emoji
 * autocomplete is on, and an unnamed session is titled from a message that carries a task without
 * overwriting a name set meanwhile.
 *
 * Subject: `modes/terminal/controllers/prompt-submission.ts`, driven through `PromptSubmission` with a
 * recording context.
 *
 * WHAT THIS SUITE DOES NOT CATCH. A dispatch failure handing the draft back is defended by the
 * submission-failure suite, skill routing by the skill-queue suite, and `/queue` by the queue suites.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { ImageContent } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { expandEmoticons } from "@veyyon/coding-agent/modes/terminal/autocomplete/emoji-autocomplete";
import type { InputControllerContext } from "@veyyon/coding-agent/modes/terminal/controllers/input-controller";
import { PromptSubmission } from "@veyyon/coding-agent/modes/terminal/controllers/prompt-submission";
import { QueuedSubmissions } from "@veyyon/coding-agent/modes/terminal/controllers/queued-submissions";
import * as tinyTitleRow from "@veyyon/coding-agent/modes/terminal/controllers/tiny-title-download-row";
import * as titleGenerator from "@veyyon/coding-agent/utils/title-generator";

interface Harness {
	submission: PromptSubmission;
	ctx: InputControllerContext;
	/** Every observable effect, in order, as `kind:detail`. */
	log: string[];
	editorText(): string;
	setSessionName(name: string | undefined): void;
}

interface HarnessOptions {
	editorText?: string;
	streaming?: boolean;
	queuedMessageCount?: number;
	compacting?: boolean;
	bashRunning?: boolean;
	evalRunning?: boolean;
	loopModeEnabled?: boolean;
	focusedAgentId?: string;
	collabGuest?: { readOnly: boolean };
	inputHandler?: (text: string) => { handled?: boolean; text?: string } | undefined;
	sessionName?: string;
}

function harness(options: HarnessOptions = {}): Harness {
	const log: string[] = [];
	let editorText = options.editorText ?? "";
	let sessionName = options.sessionName;
	const editor = {
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as readonly (string | undefined)[] | undefined,
		getText: () => editorText,
		getExpandedText: () => editorText,
		setText: (text: string) => {
			editorText = text;
		},
		clearDraft: () => {
			editorText = "";
		},
		addToHistory: (text: string) => log.push(`history:${text}`),
	};
	const session = {
		isStreaming: options.streaming ?? false,
		isCompacting: options.compacting ?? false,
		isBashRunning: options.bashRunning ?? false,
		isEvalRunning: options.evalRunning ?? false,
		queuedMessageCount: options.queuedMessageCount ?? 0,
		sessionId: "session-1",
		extensionRunner: options.inputHandler
			? {
					hasHandlers: (kind: string) => kind === "input",
					emitInput: async (text: string) => options.inputHandler?.(text),
				}
			: undefined,
		prompt: async (text: string) => {
			log.push(`prompt:${text}`);
		},
		abort: async () => {
			log.push("abort");
		},
	};
	const viewSession = {
		isStreaming: false,
		queuedMessageCount: 0,
		prompt: async (text: string) => {
			log.push(`view-prompt:${text}`);
		},
	};
	const ctx = {
		editor,
		session,
		viewSession,
		focusedAgentId: options.focusedAgentId,
		collabGuest: options.collabGuest
			? {
					readOnly: options.collabGuest.readOnly,
					sendPrompt: (text: string) => log.push(`guest-prompt:${text}`),
				}
			: undefined,
		loopModeEnabled: options.loopModeEnabled ?? false,
		loopPrompt: undefined as string | undefined,
		isBashMode: false,
		isPythonMode: false,
		skillCommands: new Map(),
		compactionQueuedMessages: [],
		locallySubmittedUserSignatures: new Set<string>(),
		settings: { get: () => undefined },
		sessionManager: {
			getSessionName: () => sessionName,
			setSessionName: async (name: string, source: string) => {
				log.push(`session-name:${name}:${source}`);
				sessionName = name;
			},
		},
		ui: {
			requestRender: () => {},
			scrollToLiveTail: () => log.push("scroll-to-live-tail"),
		},
		onInputCallback: (submission: { text: string }) => log.push(`input:${submission.text}`),
		startPendingSubmission: (submission: { text: string }) => submission,
		withLocalSubmission: async <T>(_text: string, fn: () => Promise<T>) => fn(),
		queueCompactionMessage: (text: string, mode: string) => log.push(`compaction-queue:${mode}:${text}`),
		handleBashCommand: async (command: string, excluded: boolean) => log.push(`bash:${command}:${excluded}`),
		handlePythonCommand: async (code: string, excluded: boolean) => log.push(`python:${code}:${excluded}`),
		flushPendingBashComponents: () => {},
		updateEditorBorderColor: () => {},
		updatePendingMessagesDisplay: () => {},
		showStatus: (message: string) => log.push(`status:${message}`),
		showWarning: (message: string) => log.push(`warning:${message}`),
		showError: (message: string) => log.push(`error:${message}`),
	} as unknown as InputControllerContext;
	return {
		submission: new PromptSubmission(ctx, new QueuedSubmissions(ctx)),
		ctx,
		log,
		editorText: () => editorText,
		setSessionName: name => {
			sessionName = name;
		},
	};
}

/** Titling stays off unless a test turns it on, so no submission reaches a model. */
let autoTitleDisabled: Mock<() => boolean>;
beforeEach(() => {
	autoTitleDisabled = vi.spyOn(titleGenerator, "autoTitleDisabled").mockReturnValue(true);
	vi.spyOn(tinyTitleRow, "showTinyTitleDownloadRow").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a submission from a collab guest", () => {
	it("keeps a slash command local, since commands run on the host", async () => {
		const { submission, log, editorText } = harness({ collabGuest: { readOnly: false } });

		await submission.submit("/deploy now");

		expect(log.filter(line => !line.startsWith("scroll"))).toEqual([
			"status:/deploy is host-only during a collab session",
		]);
		expect(editorText()).toBe("");
	});

	it("keeps `!` and `$` input local, since execution is the host's", async () => {
		const bash = harness({ collabGuest: { readOnly: false } });
		await bash.submission.submit("!ls");
		const python = harness({ collabGuest: { readOnly: false } });
		await python.submission.submit("$ print(1)");

		const expected = ["status:Local execution is host-only during a collab session"];
		expect([bash.log.slice(1), python.log.slice(1)]).toEqual([expected, expected]);
	});

	it("keeps the draft and sends nothing on a read-only link", async () => {
		const { submission, log, editorText } = harness({ collabGuest: { readOnly: true }, editorText: "hello" });

		await submission.submit("hello");

		expect(log.slice(1)).toEqual(["status:This collab link is read-only — prompting is disabled"]);
		expect(editorText()).toBe("hello");
	});

	it("sends a prompt on a writable link", async () => {
		const { submission, log } = harness({ collabGuest: { readOnly: false } });

		await submission.submit("hello");

		expect(log.slice(1)).toEqual(["guest-prompt:hello"]);
	});
});

describe("a `!` or `$` submission", () => {
	it("waits behind a running bash command and keeps its text", async () => {
		const { submission, log, editorText } = harness({ bashRunning: true });

		await submission.submit("!ls");

		expect(log.slice(1)).toEqual(["warning:A bash command is already running. Press Esc to cancel it first."]);
		expect(editorText()).toBe("!ls");
	});

	it("waits behind a running python execution and keeps its text", async () => {
		const { submission, log, editorText } = harness({ evalRunning: true });

		await submission.submit("$ print(1)");

		expect(log.slice(1)).toEqual(["warning:A Python execution is already running. Press Esc to cancel it first."]);
		expect(editorText()).toBe("$ print(1)");
	});

	it("runs `!!` as a command excluded from context and `!` as one included", async () => {
		const { submission, log } = harness();

		await submission.submit("!!ls -la");
		await submission.submit("!pwd");

		expect(log.filter(line => line.startsWith("bash:"))).toEqual(["bash:ls -la:true", "bash:pwd:false"]);
	});
});

describe("a submission while the session is busy", () => {
	it("queues for after compaction on Enter and on Ctrl+Enter", async () => {
		const { submission, log } = harness({ compacting: true, editorText: "later" });

		await submission.submit("now");
		await submission.handleFollowUp();

		expect(log.filter(line => !line.startsWith("scroll"))).toEqual([
			"compaction-queue:steer:now",
			"compaction-queue:followUp:later",
		]);
	});

	it("interrupts on an empty Enter only when messages wait behind the turn", async () => {
		const nothingQueued = harness({ streaming: true, queuedMessageCount: 0 });
		await nothingQueued.submission.submit("");
		const oneQueued = harness({ streaming: true, queuedMessageCount: 1 });
		await oneQueued.submission.submit("");

		expect([nothingQueued.log.includes("abort"), oneQueued.log.includes("abort")]).toEqual([false, true]);
	});
});

describe("a submission's routing", () => {
	it("snaps the transcript to its live tail before anything else", async () => {
		const { submission, log } = harness();

		await submission.submit("hello");

		expect(log[0]).toBe("scroll-to-live-tail");
	});

	it("becomes the loop prompt while loop mode is on", async () => {
		const { submission, ctx } = harness({ loopModeEnabled: true });

		await submission.submit("keep fixing tests");

		expect(ctx.loopPrompt).toBe("keep fixing tests");
	});

	it("is consumed by an extension input handler that handles it", async () => {
		const { submission, log, editorText } = harness({
			editorText: "intercepted",
			inputHandler: () => ({ handled: true }),
		});

		await submission.submit("intercepted");

		expect(log.slice(1)).toEqual([]);
		expect(editorText()).toBe("");
	});

	it("refuses a command in a focused agent view and keeps it in the composer", async () => {
		const { submission, log, editorText } = harness({ focusedAgentId: "agent-1", editorText: "/model" });

		await submission.submit("/model");
		const keptAfterCommand = editorText();
		await submission.submit("tell me more");

		expect(log.filter(line => !line.startsWith("scroll"))).toEqual([
			"status:Commands run in the main session — press ←← to return first",
			"view-prompt:tell me more",
		]);
		expect(keptAfterCommand).toBe("/model");
	});
});

describe("emoticons in a submission", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("expand while emoji autocomplete is on and stay as typed while it is off", async () => {
		const expanded = expandEmoticons("ok :)");
		const on = harness();
		await on.submission.submit("ok :)");
		Settings.instance.override("emojiAutocomplete", false);
		const off = harness();
		await off.submission.submit("ok :)");

		expect(expanded).not.toBe("ok :)");
		expect([on.log.at(-1), off.log.at(-1)]).toEqual([`history:${expanded}`, "history:ok :)"]);
	});
});

describe("titling an unnamed session", () => {
	function enableTitling(): { requests: string[]; resolve(title: string): Promise<void> } {
		const requests: string[] = [];
		const pending = Promise.withResolvers<string | null>();
		autoTitleDisabled.mockReturnValue(false);
		vi.spyOn(titleGenerator, "generateSessionTitle").mockImplementation(text => {
			requests.push(text);
			return pending.promise;
		});
		return {
			requests,
			async resolve(title) {
				pending.resolve(title);
				await pending.promise;
				// The title lands one reaction after the generator settles.
				await Promise.resolve();
			},
		};
	}

	it("skips a greeting and titles from a message that carries a task", async () => {
		const titling = enableTitling();
		const { submission, log } = harness();

		await submission.submit("hi");
		await submission.submit("fix the flaky parser test");
		await titling.resolve("Flaky parser test");

		expect(titling.requests).toEqual(["fix the flaky parser test"]);
		expect(log.filter(line => line.startsWith("session-name:"))).toEqual(["session-name:Flaky parser test:auto"]);
	});

	it("keeps a name the session got while the title was generating", async () => {
		const titling = enableTitling();
		const { submission, log, setSessionName } = harness();

		await submission.submit("fix the flaky parser test");
		setSessionName("chosen by hand");
		await titling.resolve("Flaky parser test");

		expect(log.filter(line => line.startsWith("session-name:"))).toEqual([]);
	});
});
