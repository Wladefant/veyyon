/**
 * WHY: the launch composer takes keys before the session attaches its autocomplete provider. An
 * `@` mention typed in that window reached the composer but never opened suggestions, because the
 * editor dropped every evaluation it had no provider for and attaching one evaluated nothing.
 *
 * The class closed: every evaluation the editor asks of a provider as text changes -- a typed
 * trigger (`@`, `#`, `/`), a typed character continuing a token, a bulk insert or bracketed paste,
 * and an inline shortcode rewrite. Each case below types into an editor with no provider, attaches
 * one, and asserts the editor ends where the same keys leave it once a provider exists: the popup
 * for the token at the cursor, the rewritten shortcode, or nothing when the text at the cursor asks
 * for nothing. Escape before attach withdraws the pending evaluation, and only the first provider
 * replays: replacing a provider never reopens a popup the user closed.
 *
 * Not caught: a Tab pressed before attach is not replayed (it is a request for forced file
 * completion, not a function of the text at the cursor), and a host that consumes Escape before the
 * editor sees it leaves the evaluation pending.
 */
import { describe, expect, it } from "bun:test";
import { Editor } from "@veyyon/tui/components/editor";
import type {
	AppliedCompletion,
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
} from "@veyyon/utils/autocomplete";
import { defaultEditorTheme } from "./test-themes";

/** Suggests one item for the `@`, `#` or `/` token ending at the cursor, and rewrites `:joy:`. */
class TokenProvider implements AutocompleteProvider {
	readonly pending: Promise<AutocompleteSuggestions | null>[] = [];

	getSuggestions(lines: string[], cursorLine: number, cursorCol: number): Promise<AutocompleteSuggestions | null> {
		const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const token = /(?:^|\s)([@#/][^\s]*)$/.exec(before)?.[1];
		const result = Promise.resolve(
			token === undefined ? null : { prefix: token, items: [{ value: `${token}-match`, label: `${token}-match` }] },
		);
		this.pending.push(result);
		return result;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_item: AutocompleteItem,
		_prefix: string,
	): AppliedCompletion {
		return { lines, cursorLine, cursorCol };
	}

	trySyncInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
		return textBeforeCursor.endsWith(":joy:") ? { replaceLen: 5, insert: "\u{1F602}" } : null;
	}
}

/** Every suggestion request the provider answered has been applied by the editor. */
async function settle(provider: TokenProvider): Promise<void> {
	for (let request = provider.pending.shift(); request; request = provider.pending.shift()) await request;
}

function popupPrefix(editor: Editor): string | null {
	return editor.getAutocompleteState()?.prefix ?? null;
}

const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";

const cases: { name: string; keys: string[]; text: string; popup: string | null }[] = [
	{ name: "a mention typed key by key", keys: ["@", "z", "q"], text: "@zq", popup: "@zq" },
	{ name: "a mention arriving in one read", keys: ["@zq"], text: "@zq", popup: "@zq" },
	{ name: "a mention after a word", keys: [..."see @src"], text: "see @src", popup: "@src" },
	{ name: "a hash", keys: ["#"], text: "#", popup: "#" },
	{ name: "a slash command", keys: ["/", "h"], text: "/h", popup: "/h" },
	{ name: "a bracketed paste of a mention", keys: ["\x1b[200~@zq\x1b[201~"], text: "@zq", popup: "@zq" },
	{ name: "an inline shortcode", keys: [..."hi :joy:"], text: "hi \u{1F602}", popup: null },
	// No trigger context covers a shortcode inside a word, so only the dropped rewrite brings it back.
	{ name: "a shortcode inside a word", keys: [..."a:joy:"], text: "a\u{1F602}", popup: null },
	{ name: "plain words", keys: [..."hello"], text: "hello", popup: null },
	{ name: "an at sign inside a word", keys: [..."a@b"], text: "a@b", popup: null },
	{ name: "a mention the user typed past", keys: [..."@zq "], text: "@zq ", popup: null },
	{ name: "a mention the user erased", keys: ["@", "z", "q", BACKSPACE, BACKSPACE, BACKSPACE], text: "", popup: null },
	{ name: "a mention the user escaped", keys: ["@", "z", "q", ESCAPE], text: "@zq", popup: null },
];

describe("keys typed before the provider attaches", () => {
	for (const { name, keys, text, popup } of cases) {
		it(`${name}: ends as the same keys would with a provider`, async () => {
			const editor = new Editor(defaultEditorTheme);
			for (const key of keys) editor.handleInput(key);
			const provider = new TokenProvider();
			editor.setAutocompleteProvider(provider);
			await settle(provider);

			expect(editor.getText()).toBe(text);
			expect(popupPrefix(editor)).toBe(popup);
		});
	}

	it("tells the host to repaint a shortcode the provider rewrote on attach", () => {
		const editor = new Editor(defaultEditorTheme);
		let repaints = 0;
		editor.onAutocompleteUpdate = () => {
			repaints += 1;
		};
		for (const key of ":joy:") editor.handleInput(key);
		editor.setAutocompleteProvider(new TokenProvider());

		expect(editor.getText()).toBe("\u{1F602}");
		expect(repaints).toBe(1);
	});

	it("replays once: a replaced provider never reopens a popup the user closed", async () => {
		const editor = new Editor(defaultEditorTheme);
		for (const key of "@zq") editor.handleInput(key);
		const first = new TokenProvider();
		editor.setAutocompleteProvider(first);
		await settle(first);
		expect(popupPrefix(editor)).toBe("@zq");

		editor.handleInput(ESCAPE);
		const second = new TokenProvider();
		editor.setAutocompleteProvider(second);

		expect(second.pending).toHaveLength(0);
		expect(popupPrefix(editor)).toBeNull();
	});
});
