/**
 * Contract: a JSON Schema `type` keyword admits exactly the values of that type. `number` excludes
 * NaN and the infinities, `integer` is the integral subset of `number`, `object` excludes null and
 * arrays, and an unknown keyword admits nothing. The tool-argument validator and its coercion pass
 * both read this one matcher, so a drift here changes which tool calls are accepted.
 *
 * Gap: `type` arrays and the other keywords are covered by the validator's own suites.
 */
import { describe, expect, it } from "bun:test";
import { isJsonSchemaValueValid } from "@veyyon/ai/utils/schema/json-schema-validator";

const VALUES: Record<string, unknown> = {
	string: "text",
	integer: 3,
	fraction: 1.5,
	nan: Number.NaN,
	infinity: Number.POSITIVE_INFINITY,
	boolean: true,
	null: null,
	undefined: undefined,
	array: [1],
	object: { a: 1 },
};

const ADMITTED: Record<string, string[]> = {
	string: ["string"],
	number: ["integer", "fraction"],
	integer: ["integer"],
	boolean: ["boolean"],
	null: ["null"],
	array: ["array"],
	object: ["object"],
	date: [],
};

describe("a JSON Schema type keyword", () => {
	for (const [type, admitted] of Object.entries(ADMITTED)) {
		it(`"${type}" admits ${admitted.length === 0 ? "nothing" : admitted.join(", ")}`, () => {
			const accepted = Object.entries(VALUES)
				.filter(([, value]) => isJsonSchemaValueValid({ type }, value))
				.map(([name]) => name);
			expect(accepted).toEqual(admitted);
		});
	}
});
