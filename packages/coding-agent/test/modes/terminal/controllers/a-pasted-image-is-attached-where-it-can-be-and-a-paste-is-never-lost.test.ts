/**
 * What a paste becomes in the composer: a clipboard image is labelled with its pixel size and resized only
 * while `images.autoResize` is on; text arriving over the enhanced-paste protocol lands in a focused modal
 * prompt that takes pastes (an OAuth API key typed into a login prompt once landed in the editor behind it)
 * and in the editor otherwise; an image arriving over that protocol while a modal prompt holds focus is
 * refused rather than buried; a pasted path that is too large to attach is pasted as text
 * with the size error; over SSH a missing path never reaches for the clipboard, which belongs to the remote
 * host; and a large paste whose file attachment cannot be written is pasted inline instead.
 *
 * Subject: `modes/terminal/controllers/composer-paste.ts`, driven through `ComposerPaste` with a recording
 * context and an injected clipboard.
 *
 * WHAT THIS SUITE DOES NOT CATCH. The Finder file-URL and smart-paste text fallbacks are defended by the
 * image-paste and smart-paste suites, a missing path pasted locally by the image-path suite, and the
 * large-paste menu choices by the large-paste suite.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@veyyon/ai";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	type ComposerClipboard,
	ComposerPaste,
	type ComposerPasteContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/composer-paste";
import { MAX_IMAGE_INPUT_BYTES } from "@veyyon/coding-agent/utils/image-loading";
import { TempDir } from "@veyyon/utils";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

const SSH_VARS = ["SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"] as const;

/** Runs `fn` with the SSH variables set to `value` (or removed), restoring them after. */
async function withSsh<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const saved = SSH_VARS.map(name => process.env[name]);
	for (const name of SSH_VARS) delete process.env[name];
	if (value !== undefined) process.env.SSH_TTY = value;
	try {
		return await fn();
	} finally {
		SSH_VARS.forEach((name, index) => {
			const previous = saved[index];
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		});
	}
}

interface Recorded {
	inserted: string[];
	pastedText: string[];
	insertedPastes: string[];
	statuses: string[];
	errors: string[];
}

function harness(options: { focused?: object | null; artifactsDir?: string; clipboardImage?: boolean } = {}) {
	const recorded: Recorded = { inserted: [], pastedText: [], insertedPastes: [], statuses: [], errors: [] };
	const inputListeners: Array<(data: string) => unknown> = [];
	const editor = {
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as readonly (string | undefined)[] | undefined,
		insertText: (text: string) => recorded.inserted.push(text),
		pasteText: (text: string) => recorded.pastedText.push(text),
		insertPaste: (text: string) => recorded.insertedPastes.push(text),
	};
	const ctx = {
		editor,
		settings: { get: () => 100 },
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "blob.png", displayPath: "blob.png" }),
			getArtifactsDir: () => options.artifactsDir ?? null,
			getSessionId: () => "session-1",
		},
		showStatus: (message: string) => recorded.statuses.push(message),
		showError: (message: string) => recorded.errors.push(message),
		showHookSelector: async () => "Attach as local file",
		ui: {
			getFocused: () => ("focused" in options ? options.focused : editor),
			requestRender: () => {},
			addInputListener: (listener: (data: string) => unknown) => inputListeners.push(listener),
			addStartListener: () => {},
			terminal: { write: () => {}, requestEnhancedPaste: () => {} },
		},
	} as unknown as ComposerPasteContext;
	const clipboard: ComposerClipboard = {
		readImage: async () =>
			options.clipboardImage ? { data: new Uint8Array(ONE_PX_PNG), mimeType: "image/png" } : null,
		readText: async () => "",
	} as unknown as ComposerClipboard;
	return { paste: new ComposerPaste(ctx, clipboard), editor, recorded, inputListeners };
}

const ST = "\x1b\\";
function enhancedPastePacket(metadata: string, payload?: string): string {
	return `\x1b]5522;${metadata}${payload === undefined ? "" : `;${payload}`}${ST}`;
}

/** Delivers one clipboard read of `bytes` as `mime` over the enhanced-paste protocol. */
function deliverEnhancedPaste(listener: (data: string) => unknown, mime: string, bytes: Uint8Array): void {
	const encodedMime = Buffer.from(mime, "utf8").toString("base64");
	const password = Buffer.from("pw", "utf8").toString("base64");
	listener(enhancedPastePacket(`type=read:status=OK:pw=${password}`));
	listener(enhancedPastePacket(`type=read:status=DATA:mime=${encodedMime}`));
	listener(enhancedPastePacket("type=read:status=DONE"));
	listener(enhancedPastePacket(`type=read:status=OK:pw=${password}`));
	listener(enhancedPastePacket(`type=read:status=DATA:mime=${encodedMime}`, Buffer.from(bytes).toString("base64")));
	listener(enhancedPastePacket("type=read:status=DONE"));
}

describe("a clipboard image", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	it("is labelled with its pixel size and attached as pasted while autoResize is off", async () => {
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
		const { paste, editor, recorded } = harness({ clipboardImage: true });

		expect(await paste.handleImagePaste()).toBe(true);

		expect(recorded.inserted).toEqual(["[Image #1, 1x1] "]);
		expect(editor.pendingImages).toHaveLength(1);
	});

	it("is resized before it is attached while autoResize is on", async () => {
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": true } });
		const { paste, recorded } = harness({ clipboardImage: true });

		await paste.handleImagePaste();

		expect(recorded.inserted).toHaveLength(1);
		expect(recorded.inserted[0]).toMatch(/^\[Image #1, \d+x\d+\] $/);
		expect(recorded.inserted[0]).not.toBe("[Image #1, 1x1] ");
	});
});

describe("an image over the enhanced-paste protocol", () => {
	it("is refused while a modal prompt that takes pastes holds focus", () => {
		const modal = { pasteText: () => {} };
		const { paste, editor, recorded, inputListeners } = harness({ focused: modal });

		paste.installEnhancedPaste();
		deliverEnhancedPaste(inputListeners[0]!, "image/png", ONE_PX_PNG);

		expect(recorded.statuses).toEqual(["Image paste is not supported in this prompt"]);
		expect(editor.pendingImages).toEqual([]);
	});
});

describe("text over the enhanced-paste protocol", () => {
	function pasteTextWhileFocused(focused: object | null | undefined, text: string) {
		const h = focused === undefined ? harness() : harness({ focused });
		h.paste.installEnhancedPaste();
		deliverEnhancedPaste(h.inputListeners[0]!, "text/plain", Buffer.from(text, "utf8"));
		return h;
	}

	it("lands in the modal prompt that holds focus, not in the editor behind it", () => {
		const modalPasted: string[] = [];
		const modal = { pasteText: (text: string) => modalPasted.push(text) };

		const { recorded } = pasteTextWhileFocused(modal, "sk-test-123");

		expect(modalPasted).toEqual(["sk-test-123"]);
		expect(recorded.pastedText).toEqual([]);
	});

	it("lands in the editor while the editor holds focus", () => {
		const { recorded } = pasteTextWhileFocused(undefined, "regular paste body");

		expect(recorded.pastedText).toEqual(["regular paste body"]);
	});

	it("lands in the editor when nothing holds focus", () => {
		const { recorded } = pasteTextWhileFocused(null, "unfocused body");

		expect(recorded.pastedText).toEqual(["unfocused body"]);
	});

	it("lands in the editor when the focused component cannot take a paste", () => {
		const { recorded } = pasteTextWhileFocused({}, "fallback body");

		expect(recorded.pastedText).toEqual(["fallback body"]);
	});
});

describe("a pasted image path", () => {
	let tempDir: TempDir;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-composer-paste-");
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(() => {
		tempDir.removeSync();
		resetSettingsForTest();
	});

	it("that is too large is pasted as text with the size error, and the clipboard is left alone", async () => {
		const big = path.join(tempDir.path(), "huge.png");
		await fs.writeFile(big, "");
		await fs.truncate(big, MAX_IMAGE_INPUT_BYTES + 1);
		const { paste, editor, recorded } = harness({ clipboardImage: true });

		await withSsh(undefined, () => paste.handleImagePathPaste(big));

		expect(recorded.pastedText).toEqual([big]);
		expect(recorded.statuses).toHaveLength(1);
		expect(recorded.statuses[0]).toMatch(/^Image file too large: /);
		expect(editor.pendingImages).toEqual([]);
	});

	it("that is missing over SSH never attaches the clipboard image, which is the remote host's", async () => {
		const missing = path.join(tempDir.path(), "gone.png");
		const { paste, editor, recorded } = harness({ clipboardImage: true });

		await withSsh("/dev/pts/0", () => paste.handleImagePathPaste(missing));

		expect(editor.pendingImages).toEqual([]);
		expect(recorded.statuses).toHaveLength(1);
		expect(recorded.statuses[0]).toMatch(/^Image not found at .*Over SSH this path is local to your terminal/);
	});
});

describe("a large paste whose file attachment cannot be written", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-composer-paste-");
	});

	afterEach(() => {
		tempDir.removeSync();
	});

	it("is pasted inline instead, so its text is not lost", async () => {
		// A regular file where the artifacts directory should be: nothing can be written beneath it.
		const notADirectory = path.join(tempDir.path(), "artifacts");
		await fs.writeFile(notADirectory, "");
		const { paste, recorded } = harness({ artifactsDir: notADirectory });

		await paste.presentLargePasteMenu("line 1\nline 2", 2);

		expect(recorded.insertedPastes).toEqual(["line 1\nline 2"]);
		expect(recorded.errors).toEqual(["Failed to save paste to a file — pasted inline instead"]);
	});
});
