/**
 * WHY: an edit into an open suggestion popup re-queried the provider only after a 100 ms debounce, so
 * on every keystroke the list on screen described the text of 100 ms earlier: `/mo` still listed
 * `/mcp` and `/memory` until the timer fired. A slash command name answers on a microtask and an `@`
 * file search in about a millisecond, so the wait was lag that saved no work. Opening the popup never
 * waited; only the edits that followed did.
 *
 * THE CLASS. An edit that keeps the popup open and leaves its list describing text that is no longer
 * before the cursor until a timer fires. Each case freezes timers, makes one kind of edit into an open
 * popup, lets microtasks run, and requires the list to be the provider's answer for the text now
 * before the cursor, and different from the list before the edit. Since every edit now asks at once,
 * a last case requires that an answer to an earlier edit arriving late does not replace a later one.
 *
 * WHAT IT DOES NOT CATCH. A provider that answers slowly leaves the list stale until it answers; that
 * window is the provider's own latency, and the accept-time staleness check covers it. The edit kinds
 * are listed by hand: a new edit path that keeps the popup open is not swept until it has a case.
 */
import { describe, expect, it, vi } from "bun:test";
import { Editor } from "@veyyon/tui/components/editor";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@veyyon/utils/autocomplete";
import { defaultEditorTheme } from "./test-themes";

const COMMANDS = ["mcp", "memory", "model", "settings"];

/** The slash command names that start with the typed name; null outside a slash command name. */
function answer(text: string): AutocompleteSuggestions | null {
	if (!text.startsWith("/") || text.includes(" ")) return null;
	const items = COMMANDS.filter(name => name.startsWith(text.slice(1))).map(name => ({
		value: name,
		label: `/${name}`,
	}));
	return items.length > 0 ? { prefix: text, items } : null;
}

class SlashNames implements AutocompleteProvider {
	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): Promise<AutocompleteSuggestions | null> {
		return answer((lines[cursorLine] ?? "").slice(0, cursorCol));
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, _item: AutocompleteItem, _prefix: string) {
		return { lines, cursorLine, cursorCol };
	}
}

/** One kind of edit made into an open popup. */
interface Edit {
	name: string;
	/** Text typed to open the popup. */
	before: string;
	/** The input that makes the edit. */
	keys: string;
}

const EDITS = [
	{ name: "a typed character", before: "/m", keys: "o" },
	{ name: "a backspace", before: "/mo", keys: "\x7f" },
	{ name: "a paste", before: "/m", keys: "\x1b[200~em\x1b[201~" },
	{ name: "a word deleted backward", before: "/mo", keys: "\x17" },
] as Edit[];

/** Let every pending microtask run; the provider is a resolved promise, not a timer. */
async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function listed(editor: Editor): string[] | undefined {
	return editor.getAutocompleteState()?.items.map(item => item.value);
}

describe("an open suggestion list follows every edit without a timer", () => {
	it.each(EDITS)("$name refreshes the open list before any timer fires", async edit => {
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(new SlashNames());
		editor.handleInput(edit.before);
		await flush();
		expect(editor.isShowingAutocomplete()).toBe(true);
		const before = listed(editor);

		vi.useFakeTimers();
		try {
			editor.handleInput(edit.keys);
			await flush();
		} finally {
			vi.useRealTimers();
		}

		const text = editor.getText();
		const expected = answer(text);
		if (!expected) throw new Error(`the edit left ${JSON.stringify(text)}, which closes the popup`);
		const expectedValues = expected.items.map(item => item.value);
		expect(expectedValues).not.toEqual(before);
		expect(listed(editor)).toEqual(expectedValues);
		expect(editor.getAutocompleteState()?.prefix).toBe(text);
	});

	it("drops an answer to an earlier edit that arrives after the answer to a later one", async () => {
		// Every edit now asks at once, so two questions can be in flight and answer out of order.
		const pending = new Map<string, PromiseWithResolvers<AutocompleteSuggestions | null>>();
		const provider: AutocompleteProvider = {
			getSuggestions: (lines, cursorLine, cursorCol) => {
				const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
				if (text === "/") return Promise.resolve(answer(text));
				const reply = Promise.withResolvers<AutocompleteSuggestions | null>();
				pending.set(text, reply);
				return reply.promise;
			},
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		const editor = new Editor(defaultEditorTheme);
		editor.setAutocompleteProvider(provider);
		editor.handleInput("/");
		await flush();
		expect(editor.isShowingAutocomplete()).toBe(true);

		editor.handleInput("m");
		editor.handleInput("o");
		pending.get("/mo")?.resolve(answer("/mo"));
		await flush();
		pending.get("/m")?.resolve(answer("/m"));
		await flush();

		expect([...pending.keys()]).toEqual(["/m", "/mo"]);
		expect(listed(editor)).toEqual(["model"]);
		expect(editor.getAutocompleteState()?.prefix).toBe("/mo");
	});
});
