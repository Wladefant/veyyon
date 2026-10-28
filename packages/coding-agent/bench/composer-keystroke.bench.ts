/**
 * Composer keystroke benchmark.
 *
 * Builds the focused `CustomEditor` the interactive host draws, with the composer chrome applied and
 * the height cap `computeEditorMaxHeight` sets for a 40-row terminal, fills it with a draft of N
 * lines, and times one keystroke plus one `render(120)`: a typed character, then a backspace, so the
 * draft returns to its starting size every second operation.
 *
 * Metric (lower is better): p50 and p95 microseconds per keystroke-and-frame. The visible window is
 * the same handful of rows at every size, so a frame whose cost still grows with N is reading the
 * whole draft once per drawn row.
 *
 * Run: bun packages/coding-agent/bench/composer-keystroke.bench.ts
 */

import { benchStats } from "@veyyon/utils/bench-harness";
import { Settings } from "../src/config/settings";
import {
	applyComposerChrome,
	computeEditorMaxHeight,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "../src/modes/terminal/components/composer/composer-chrome";
import { CustomEditor } from "../src/modes/terminal/components/composer/custom-editor";
import { getEditorTheme, initTheme } from "../src/theme/theme";

const TERMINAL_ROWS = 40;
const WIDTH = 120;
/** Draft sizes in lines, and the keystrokes timed at each. */
const CASES: ReadonlyArray<{ lines: number; keystrokes: number }> = [
	{ lines: 1, keystrokes: 4000 },
	{ lines: 400, keystrokes: 2000 },
	{ lines: 4000, keystrokes: 400 },
];

await Settings.init({ inMemory: true });
await initTheme(false);

for (const { lines, keystrokes } of CASES) {
	const editor = new CustomEditor(getEditorTheme());
	applyComposerChrome(editor, resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE));
	editor.setMaxHeight(computeEditorMaxHeight(TERMINAL_ROWS));
	editor.focused = true;
	editor.insertText(
		Array.from({ length: lines }, (_, i) => `line ${i} of the prompt with some words in it`).join("\n"),
	);
	for (let i = 0; i < 50; i++) editor.render(WIDTH);
	const samples: number[] = [];
	for (let i = 0; i < keystrokes; i++) {
		const start = performance.now();
		editor.handleInput(i % 2 === 0 ? "a" : "\x7f");
		editor.render(WIDTH);
		samples.push((performance.now() - start) * 1000);
	}
	const { p50, p95 } = benchStats(samples);
	console.log(`lines=${lines} keystrokes=${keystrokes} p50=${p50.toFixed(1)}us p95=${p95.toFixed(1)}us`);
}
