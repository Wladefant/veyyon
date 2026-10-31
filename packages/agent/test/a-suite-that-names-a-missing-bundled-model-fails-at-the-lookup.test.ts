/**
 * Suites across agent and coding-agent build their model fixtures with `requireBundledModel`. When the
 * catalog drops a model, those suites fail at the lookup with the model's name, instead of passing
 * `undefined` on and failing later with an unrelated `TypeError`. This does not check that any
 * particular model stays in the catalog.
 */
import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@veyyon/catalog/models";
import { requireBundledModel } from "./helpers";

describe("requireBundledModel", () => {
	it("returns the catalog's own model for a provider and id the catalog ships", () => {
		expect(requireBundledModel("anthropic", "claude-sonnet-4-5")).toBe(
			getBundledModel("anthropic", "claude-sonnet-4-5"),
		);
	});

	it("throws naming the provider and id when the catalog has no such model", () => {
		expect(() => requireBundledModel("anthropic", "no-such-model")).toThrow(
			"The bundled catalog has no anthropic/no-such-model model",
		);
	});
});
