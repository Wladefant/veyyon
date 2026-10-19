import { afterEach, describe, expect, it, vi } from "bun:test";
import { applyProviderGlobalsFromSettings } from "@veyyon/coding-agent/config/provider-globals";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as imageGen from "@veyyon/coding-agent/tools/web/image-gen";
import {
	isSearchProviderExcluded,
	selectSearchProviders,
	setExcludedSearchProviders,
	setPreferredSearchProvider,
} from "@veyyon/coding-agent/tools/web/search/provider";

describe("applyProviderGlobalsFromSettings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		setPreferredSearchProvider("auto");
		setExcludedSearchProviders([]);
	});

	it("reapplies valid web and image provider globals from cwd-scoped settings", () => {
		const imageSpy = vi.spyOn(imageGen, "setPreferredImageProvider").mockImplementation(() => {});

		applyProviderGlobalsFromSettings(
			Settings.isolated({
				"providers.webSearchExclude": ["exa", "not-a-provider", "gemini"],
				"providers.webSearch": "perplexity",
				"providers.image": "xai",
			}),
		);

		expect(selectSearchProviders()).toEqual({ candidates: [{ id: "perplexity", explicit: true }] });
		expect([isSearchProviderExcluded("exa"), isSearchProviderExcluded("gemini")]).toEqual([true, true]);
		expect(isSearchProviderExcluded("brave")).toBe(false);
		expect(imageSpy).toHaveBeenCalledWith("xai");
	});

	it("applies the automatic choice for a preference that names no provider", () => {
		setPreferredSearchProvider("perplexity");
		const imageSpy = vi.spyOn(imageGen, "setPreferredImageProvider").mockImplementation(() => {});

		applyProviderGlobalsFromSettings(
			Settings.isolated({
				"providers.webSearch": "not-a-provider",
				"providers.image": 7,
			}),
		);

		const selection = selectSearchProviders();
		expect("candidates" in selection && selection.candidates.every(candidate => !candidate.explicit)).toBe(true);
		expect(imageSpy).toHaveBeenCalledWith("auto");
	});
});
