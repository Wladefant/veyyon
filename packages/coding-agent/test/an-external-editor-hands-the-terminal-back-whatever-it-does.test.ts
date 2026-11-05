/**
 * Subject: `utils/external-editor.ts`, driven through `editInTerminal` and the hook editor's Ctrl+G.
 *
 * WHY. Five surfaces hand the terminal to `$VISUAL`/`$EDITOR`: the composer, the plan review, its
 * annotation editor, `/todo edit`, and the hook / ask-input editor. Each held its own copy of the
 * handoff and the copies drifted. `/todo edit` opened a stdin path Bun never sets, so its editor never
 * received the controlling terminal the others open. The hook editor had no catch: an editor that
 * failed to start rejected a detached promise into the process-wide rejection handler, which exits
 * the session.
 *
 * THE CLASS THIS CLOSES. `editInTerminal` is the one handoff: stop the screen, run the editor, close
 * the terminal handle, restart the screen. The screen comes back whether the editor saves, exits
 * non-zero, or never starts, and the options a surface passes reach the edit. The hook editor reports
 * a failed start, and a missing editor setting, as a row under its text instead of rejecting.
 *
 * WHAT THIS DOES NOT CATCH. Whether the editor child receives `/dev/tty`: the test sandbox has no
 * controlling terminal, so the handoff takes its inherited-stdio branch here. A new surface that calls
 * `openInEditor` directly instead of `editInTerminal` is not detected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { HookEditorComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/hook-editor";
import { setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { editInTerminal, NO_EDITOR_CONFIGURED } from "@veyyon/coding-agent/utils/external-editor";
import type { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { setKeybindings } from "@veyyon/utils/keybindings";
import { requireTheme } from "./helpers/require-theme";

const CTRL_G = "\x07";
const MISSING_EDITOR = "veyyon-test-editor-that-is-not-installed";

let scratch: TempDir;

beforeAll(async () => {
	const theme = await requireTheme("dark");
	setThemeInstance(theme);
	scratch = await TempDir.create("@veyyon-editor-handoff-");
});

afterAll(async () => {
	await scratch.remove();
});

/** A `sh` editor command whose body runs with the temp file as `$1`. */
function shellEditor(name: string, body: string): string {
	const script = path.join(scratch.path(), `${name}.sh`);
	fs.writeFileSync(script, `${body}\n`);
	return `sh ${script}`;
}

/** A screen that records its transitions, and drops a marker file while it is stopped. */
function recordingScreen(marker?: string) {
	const events: string[] = [];
	return {
		events,
		stop(): void {
			events.push("stop");
			if (marker) fs.writeFileSync(marker, "stopped");
		},
		start(): void {
			events.push("start");
			if (marker) fs.rmSync(marker, { force: true });
		},
	};
}

describe("editInTerminal", () => {
	it("runs the editor while the screen is stopped, then restarts the screen with the edit", async () => {
		const marker = path.join(scratch.path(), "screen-stopped");
		const screen = recordingScreen(marker);
		const editor = shellEditor("copy-marker", `cat '${marker}' > "$1"`);

		const result = await editInTerminal(screen, editor, "original");

		expect(result).toBe("stopped");
		expect(screen.events).toEqual(["stop", "start"]);
	});

	it("returns null and restarts the screen when the editor exits non-zero", async () => {
		const screen = recordingScreen();

		const result = await editInTerminal(screen, shellEditor("fail", "exit 3"), "original");

		expect(result).toBeNull();
		expect(screen.events).toEqual(["stop", "start"]);
	});

	it("restarts the screen and rejects when the editor cannot start", async () => {
		const screen = recordingScreen();

		const failure = await editInTerminal(screen, MISSING_EDITOR, "original").then(
			() => undefined,
			(error: unknown) => error,
		);

		expect((failure as NodeJS.ErrnoException).code).toBe("ENOENT");
		expect(screen.events).toEqual(["stop", "start"]);
	});

	it("passes the file extension and newline handling through to the edit", async () => {
		const echoPath = shellEditor("echo-path", `printf '%s\\n' "$1" > "$1"`);

		const kept = await editInTerminal(recordingScreen(), echoPath, "", {
			extension: ".todo.md",
			trimTrailingNewline: false,
		});
		const trimmed = await editInTerminal(recordingScreen(), echoPath, "", { extension: ".todo.md" });

		expect(kept?.endsWith(".todo.md\n")).toBe(true);
		expect(trimmed?.endsWith(".todo.md")).toBe(true);
	});
});

describe("the hook editor's external editor", () => {
	const originalPlatform = process.platform;
	const originalVisual = process.env.VISUAL;
	const originalEditor = process.env.EDITOR;

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	afterEach(() => {
		(process as unknown as { platform: NodeJS.Platform }).platform = originalPlatform;
		if (originalVisual === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete process.env.EDITOR;
		else process.env.EDITOR = originalEditor;
	});

	/** An embedded hook editor on a recording screen; `noticed` settles on the next repaint request. */
	function mountHookEditor(prefill: string) {
		const screen = recordingScreen();
		let repaint = Promise.withResolvers<void>();
		const component = new HookEditorComponent(
			{ ...screen, requestRender: () => {}, setFocus: () => {}, terminal: { columns: 120 } } as unknown as TUI,
			"Prompt",
			prefill,
			() => {},
			() => {},
			{ presentation: "embedded", onRequestRender: () => repaint.resolve() },
		);
		return {
			screen,
			component,
			text: () => Bun.stripANSI(component.render(120).join("\n")),
			async noticed(): Promise<void> {
				await repaint.promise;
				repaint = Promise.withResolvers<void>();
			},
		};
	}

	it("states an editor that cannot start under the text and gives the screen back", async () => {
		process.env.VISUAL = MISSING_EDITOR;
		const mounted = mountHookEditor("draft");

		mounted.component.handleInput(CTRL_G);
		await mounted.noticed();

		expect(mounted.text()).toContain("Failed to open external editor:");
		expect(mounted.text()).toContain("draft");
		expect(mounted.screen.events).toEqual(["stop", "start"]);
	});

	it("states a missing editor setting without releasing the screen", async () => {
		delete process.env.VISUAL;
		delete process.env.EDITOR;
		(process as unknown as { platform: NodeJS.Platform }).platform = "linux";
		const mounted = mountHookEditor("draft");

		mounted.component.handleInput(CTRL_G);
		await mounted.noticed();

		expect(mounted.text()).toContain(NO_EDITOR_CONFIGURED);
		expect(mounted.screen.events).toEqual([]);
	});

	it("replaces the text with the edit and clears the earlier failure", async () => {
		process.env.VISUAL = MISSING_EDITOR;
		const mounted = mountHookEditor("draft");
		mounted.component.handleInput(CTRL_G);
		await mounted.noticed();

		process.env.VISUAL = shellEditor("write-edit", `printf 'edited text' > "$1"`);
		mounted.component.handleInput(CTRL_G);
		while (mounted.screen.events.length < 4) await nextMacrotask();
		await nextMacrotask();

		expect(mounted.text()).toContain("edited text");
		expect(mounted.text()).not.toContain("Failed to open external editor");
		expect(mounted.text()).not.toContain("draft");
	});
});
