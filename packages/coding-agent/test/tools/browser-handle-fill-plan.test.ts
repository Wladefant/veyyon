import { describe, expect, it } from "bun:test";
import { toActionableHandle } from "@veyyon/coding-agent/tools/web/browser/tab-worker";
import type { ElementHandle } from "puppeteer-core";

/**
 * WHY. `fill()` on an element handle decides in the page whether to select-and-insert, assign a
 * value (date, time, colour, range), or refuse, then does at most one trusted text insertion. A
 * wrong decision types a value into another field, silently keeps a stale value, or edits an element
 * `fill` must refuse. These suites drive the real decision (`planFill`, reached through
 * `toActionableHandle(...).fill`) against a stub element and a stub page keyboard, so they run with no
 * Chromium. The real-browser behaviour (React's value tracker, real focus) lives in
 * `a-fill-replaces-a-value-with-one-real-edit.test.ts`, which needs a launchable Chromium.
 */

interface StubOptions {
	tag: string;
	type?: string;
	value?: string;
	disabled?: boolean;
	readOnly?: boolean;
	isContentEditable?: boolean;
	/** The element refuses focus (hidden, inert, not rendered): focus() leaves activeElement elsewhere. */
	takesFocus?: boolean;
	/** For value-assigned inputs: a value the element cannot hold is normalised to "". */
	accepts?: (value: string) => boolean;
	/** The editing host `activeElement` returns after a contenteditable selection. */
	editingHostContains?: boolean;
}

function makeFixture(options: StubOptions) {
	const events: string[] = [];
	const inserted: string[] = [];
	const takesFocus = options.takesFocus ?? true;
	const accepts = options.accepts ?? (() => true);
	let storedValue = options.value ?? "";
	let active: unknown = null;
	const element: Record<string, unknown> = {
		tagName: options.tag.toUpperCase(),
		type: options.type,
		disabled: options.disabled,
		readOnly: options.readOnly,
		isContentEditable: options.isContentEditable,
		focus: () => {
			events.push("focus");
			if (takesFocus) active = element;
		},
		select: () => {
			events.push("select");
		},
		contains: () => options.editingHostContains ?? true,
		dispatchEvent: (event: { type: string }) => {
			events.push(`event:${event.type}`);
			return true;
		},
		getRootNode: () => ({
			get activeElement() {
				if (options.isContentEditable && takesFocus) {
					return { isContentEditable: true, contains: () => options.editingHostContains ?? true };
				}
				return active as never;
			},
		}),
		ownerDocument: {
			createRange: () => ({
				selectNodeContents: () => {
					events.push("range");
				},
			}),
			defaultView: {
				getSelection: () => ({
					removeAllRanges: () => {
						events.push("clearSelection");
					},
					addRange: () => {
						events.push("addRange");
					},
				}),
				Event: class {
					constructor(readonly type: string) {}
				},
			},
		},
	};
	Object.defineProperty(element, "value", {
		get: () => storedValue,
		set: (next: string) => {
			storedValue = accepts(next) ? next : "";
		},
	});
	const handle = {
		evaluate: async (fn: (el: unknown, value: string) => unknown, value: string) => fn(element, value),
		frame: {
			page: () => ({
				keyboard: {
					sendCharacter: async (text: string) => {
						events.push("insert");
						inserted.push(text);
					},
				},
			}),
		},
	} as unknown as ElementHandle;
	return { handle: toActionableHandle(handle), events, inserted, value: () => storedValue };
}

describe("handle fill — text fields get one selected-contents insertion", () => {
	for (const options of [
		{ tag: "input" },
		{ tag: "input", type: "email" },
		{ tag: "input", type: "number" },
		{ tag: "textarea" },
	]) {
		it(`<${options.tag}${options.type ? ` type=${options.type}` : ""}> is focused, selected, then filled by one insertion`, async () => {
			const fixture = makeFixture({ ...options, value: "old" });
			await fixture.handle.fill("fresh");
			expect(fixture.events).toEqual(["focus", "select", "insert"]);
			expect(fixture.inserted).toEqual(["fresh"]);
		});
	}

	it("an empty value is still the one insertion: it deletes the selected contents", async () => {
		const fixture = makeFixture({ tag: "input", value: "old" });
		await fixture.handle.fill("");
		expect(fixture.inserted).toEqual([""]);
	});

	it("an element that does not take focus is refused, so nothing is typed into another field", async () => {
		const fixture = makeFixture({ tag: "input", takesFocus: false });
		await expect(fixture.handle.fill("x")).rejects.toThrow(/fill: the <input> cannot take focus/);
		expect(fixture.inserted).toEqual([]);
	});

	it("a textarea that does not take focus is refused", async () => {
		const fixture = makeFixture({ tag: "textarea", takesFocus: false });
		await expect(fixture.handle.fill("x")).rejects.toThrow(/cannot take focus/);
		expect(fixture.inserted).toEqual([]);
	});
});

describe("handle fill — value-assigned inputs are set, with the events a user edit fires", () => {
	it("assigns a date, then fires input and change, and types nothing", async () => {
		const fixture = makeFixture({ tag: "input", type: "date", value: "2020-01-01" });
		await fixture.handle.fill("2026-10-01");
		expect(fixture.value()).toBe("2026-10-01");
		expect(fixture.events).toEqual(["focus", "event:input", "event:change"]);
		expect(fixture.inserted).toEqual([]);
	});

	it("an empty value clears a date input (a deletion) through the same set path", async () => {
		const fixture = makeFixture({ tag: "input", type: "date", value: "2020-01-01" });
		await fixture.handle.fill("");
		expect(fixture.value()).toBe("");
		expect(fixture.events).toEqual(["focus", "event:input", "event:change"]);
	});

	it("a value the input cannot hold is refused and the previous value is restored", async () => {
		const fixture = makeFixture({
			tag: "input",
			type: "date",
			value: "2020-01-01",
			accepts: value => /^\d{4}-\d{2}-\d{2}$/.test(value),
		});
		await expect(fixture.handle.fill("tomorrow")).rejects.toThrow(/not a value an <input type="date"> holds/);
		expect(fixture.value()).toBe("2020-01-01");
		expect(fixture.events).not.toContain("event:input");
		expect(fixture.inserted).toEqual([]);
	});
});

describe("handle fill — elements fill refuses, naming what to use", () => {
	const refusals: Array<[string, StubOptions, RegExp]> = [
		["checkbox", { tag: "input", type: "checkbox" }, /set by clicking it/],
		["radio", { tag: "input", type: "radio" }, /set by clicking it/],
		["file input", { tag: "input", type: "file" }, /tab\.uploadFile/],
		["submit button", { tag: "input", type: "submit" }, /holds no text/],
		["disabled input", { tag: "input", disabled: true }, /disabled/],
		["read-only input", { tag: "input", readOnly: true }, /read-only/],
		["disabled textarea", { tag: "textarea", disabled: true }, /disabled/],
		["read-only textarea", { tag: "textarea", readOnly: true }, /read-only/],
		["select", { tag: "select" }, /tab\.select\(selector, \.\.\.values\)/],
		["plain div", { tag: "div" }, /not an <input>, a <textarea> or contenteditable/],
	];
	for (const [name, options, message] of refusals) {
		it(`${name} is refused and nothing is typed`, async () => {
			const fixture = makeFixture(options);
			await expect(fixture.handle.fill("x")).rejects.toThrow(message);
			expect(fixture.inserted).toEqual([]);
			expect(fixture.events).not.toContain("insert");
		});
	}
});

describe("handle fill — contenteditable", () => {
	it("selects the element's contents and replaces them with one insertion", async () => {
		const fixture = makeFixture({ tag: "div", isContentEditable: true });
		await fixture.handle.fill("fresh");
		expect(fixture.events).toEqual(["focus", "range", "clearSelection", "addRange", "insert"]);
		expect(fixture.inserted).toEqual(["fresh"]);
	});

	it("an empty value deletes the selected contents with one empty insertion", async () => {
		const fixture = makeFixture({ tag: "div", isContentEditable: true });
		await fixture.handle.fill("");
		expect(fixture.inserted).toEqual([""]);
	});

	it("is refused when no editing host took the selection's focus", async () => {
		const fixture = makeFixture({ tag: "div", isContentEditable: true, takesFocus: false });
		await expect(fixture.handle.fill("x")).rejects.toThrow(/cannot take focus/);
		expect(fixture.inserted).toEqual([]);
	});

	it("is refused when the focused editing host does not contain the element", async () => {
		const fixture = makeFixture({ tag: "div", isContentEditable: true, editingHostContains: false });
		await expect(fixture.handle.fill("x")).rejects.toThrow(/cannot take focus/);
		expect(fixture.inserted).toEqual([]);
	});
});
