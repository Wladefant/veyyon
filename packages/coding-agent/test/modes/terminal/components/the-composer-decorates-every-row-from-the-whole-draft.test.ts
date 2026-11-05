/**
 * The composer decorates each drawn row from state that belongs to the whole draft.
 *
 * WHY: a row of the draft is painted one at a time, but what it is painted with depends on other
 * rows. A `2.` marker is accented only when the draft's first line is the `->` queue shorthand,
 * and the `->` line itself becomes the `Queueing` label. That text-wide state is read once per
 * frame, so the class this closes is a frame that paints a row from stale or row-local state: a
 * marker accented after the queue prefix was deleted, a label kept after an edit, or a marker
 * judged from its own row alone.
 *
 * It does not catch a shimmer phase that drifts between rows of one frame; that phase reads the
 * clock and is not asserted here.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { CustomEditor } from "@veyyon/coding-agent/modes/terminal/components/composer/custom-editor";
import { getEditorTheme, initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { expectNotAccented, useFullColor } from "../../../helpers/theme-assertions";

const QUEUED_LIST = "->\n1. first\n2. second\n3. third";
const PLAIN_LIST = "1. first\n2. second\n3. third";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterAll(() => {
	resetSettingsForTest();
});

/** The drawn row whose visible text contains `needle`. */
function rowWith(rows: readonly string[], needle: string): string {
	const row = rows.find(candidate => stripVTControlCharacters(candidate).includes(needle));
	if (row === undefined) throw new Error(`no drawn row contains ${JSON.stringify(needle)}`);
	return row;
}

function draw(editor: CustomEditor): readonly string[] {
	return editor.render(80);
}

describe("the composer decorates every row from the whole draft", () => {
	useFullColor();

	it("labels the queue prefix and accents each list marker below it", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText(QUEUED_LIST);
		const rows = draw(editor);
		expect(stripVTControlCharacters(rows.join("\n"))).toContain("Queueing");
		expect(rowWith(rows, "1. first")).toContain(theme.fg("accent", "1."));
		expect(rowWith(rows, "2. second")).toContain(theme.fg("accent", "2."));
	});

	it("leaves the same list rows plain when the draft carries no queue prefix", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText(PLAIN_LIST);
		const rows = draw(editor);
		expect(stripVTControlCharacters(rows.join("\n"))).not.toContain("Queueing");
		expectNotAccented(theme, rowWith(rows, "2. second"), ["2."]);
	});

	it("drops the label and the accents on the frame after the queue prefix is edited away", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText(QUEUED_LIST);
		draw(editor);
		editor.setText(PLAIN_LIST);
		const rows = draw(editor);
		expect(stripVTControlCharacters(rows.join("\n"))).not.toContain("Queueing");
		expectNotAccented(theme, rowWith(rows, "2. second"), ["2."]);
	});

	it("adds the label and the accents on the frame after a queue prefix is typed", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText(PLAIN_LIST);
		draw(editor);
		editor.setText(QUEUED_LIST);
		const rows = draw(editor);
		expect(stripVTControlCharacters(rows.join("\n"))).toContain("Queueing");
		expect(rowWith(rows, "2. second")).toContain(theme.fg("accent", "2."));
	});

	it("paints a magic keyword on its own row of a multi-line draft", () => {
		const editor = new CustomEditor(getEditorTheme());
		editor.setText("first line\nplease orchestratez the rollout\nlast line");
		const row = rowWith(draw(editor), "the rollout");
		expect(stripVTControlCharacters(row)).toContain("please orchestratez the rollout");
		expect(row).not.toContain("orchestratez");
	});
});
