/**
 * Composer morph (DS-6): a mode changes the prompt GLYPH, not just its hue —
 * `!` full bypass, `$` bash, `◈` plan mode, `›` otherwise — so the state
 * survives color degradation and colorblind terminals. Color-only mode
 * signaling was the defect this replaces: two modes differing only by hue were
 * indistinguishable exactly when the operator most needed the difference.
 *
 * Locks (asserted on the ANSI-stripped rendered frame, i.e. glyph shape):
 *  1. Resting composer shows the `›` prompt.
 *  2. Bash mode morphs it to `$`.
 *  3. Plan mode morphs it to `◈`; pausing plan restores `›`.
 *  4. Full bypass morphs it to `!` and outranks bash.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";
import { createTestAgentSession } from "./helpers/test-agent-session";

describe("composer morph glyphs", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		savedGeometry = {
			columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
			rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
		};
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-composer-morph-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		({ authStorage, session } = await createTestAgentSession(tempDir.path()));
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, new EventBus());
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
	});

	afterEach(async () => {
		for (const key of ["columns", "rows"] as const) {
			const descriptor = savedGeometry[key];
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else delete (process.stdout as unknown as Record<string, unknown>)[key];
		}
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** The composer's first editor row, ANSI-stripped: "  <glyph> <input>". */
	function promptGlyph(): string | undefined {
		const rows = mode.editor.render(100).map(line => stripVTControlCharacters(line));
		const promptRow = rows.find(row => /^ {2}\S /.test(row));
		return promptRow?.trimStart().charAt(0);
	}

	it("shows the › prompt at rest", () => {
		mode.updateEditorBorderColor();
		expect(promptGlyph()).toBe("›");
	});

	it("morphs to $ in bash mode", () => {
		mode.isBashMode = true;
		mode.updateEditorBorderColor();
		expect(promptGlyph()).toBe("$");
	});

	it("morphs to ◈ in plan mode and back to › when plan pauses", () => {
		mode.planModeEnabled = true;
		mode.updateEditorBorderColor();
		expect(promptGlyph()).toBe("◈");
		mode.planModePaused = true;
		mode.updateEditorBorderColor();
		expect(promptGlyph()).toBe("›");
	});

	it("morphs to ! under full bypass, outranking bash mode", () => {
		vi.spyOn(session, "isApprovalBypassed").mockReturnValue(true);
		mode.isBashMode = true;
		mode.updateEditorBorderColor();
		expect(promptGlyph()).toBe("!");
	});
});
