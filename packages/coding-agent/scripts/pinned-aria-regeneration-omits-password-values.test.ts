// WHY: A changed upstream producer must not restore password values silently.
// This suite checks the pinned transform; real-browser regressions cover traversal and serialization.
import { describe, expect, test } from "bun:test";
import { omitPasswordValues } from "./generate-aria-snapshot";

const inputValueCondition = "element.type !== 'checkbox' && element.type !== 'radio' && element.type !== 'file'";
const expectedPasswordSafeCondition = `${inputValueCondition} && element.type !== 'password'`;

describe("pinned ARIA regeneration omits password values", () => {
	test("preserves ordinary input values and excludes password values", () => {
		const source = `if (${inputValueCondition}) output.value = element.value;`;

		expect(omitPasswordValues(source)).toBe(`if (${expectedPasswordSafeCondition}) output.value = element.value;`);
	});

	test("throws when the upstream condition is missing", () => {
		expect(() => omitPasswordValues("const unchanged = true;")).toThrow();
	});

	test("throws when the upstream condition occurs more than once", () => {
		const source = `${inputValueCondition}\n${inputValueCondition}`;

		expect(() => omitPasswordValues(source)).toThrow();
	});
});
