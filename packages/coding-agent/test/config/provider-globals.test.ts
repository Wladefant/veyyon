import { afterEach, describe, expect, it, vi } from "bun:test";
import { applyProviderGlobalsFromSettings } from "@veyyon/coding-agent/config/provider-globals";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as imageGen from "@veyyon/coding-agent/tools/web/image-gen";
import * as webSearch from "@veyyon/coding-agent/tools/web/search";

describe("applyProviderGlobalsFromSettings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reapplies valid web and image provider globals from cwd-scoped settings", () => {
		const excludeSpy = vi.spyOn(webSearch, "setExcludedSearchProviders").mockImplementation(() => {});
		const webSpy = vi.spyOn(webSearch, "setPreferredSearchProvider").mockImplementation(() => {});
		const imageSpy = vi.spyOn(imageGen, "setPreferredImageProvider").mockImplementation(() => {});

		applyProviderGlobalsFromSettings(
			Settings.isolated({
				"providers.webSearchExclude": ["exa", "not-a-provider", "gemini"],
				"providers.webSearch": "perplexity",
				"providers.image": "xai",
			}),
		);

		expect(excludeSpy).toHaveBeenCalledWith(["exa", "gemini"]);
		expect(webSpy).toHaveBeenCalledWith("perplexity");
		expect(imageSpy).toHaveBeenCalledWith("xai");
	});

	it("applies the automatic choice for a preference that names no provider", () => {
		const webSpy = vi.spyOn(webSearch, "setPreferredSearchProvider").mockImplementation(() => {});
		const imageSpy = vi.spyOn(imageGen, "setPreferredImageProvider").mockImplementation(() => {});

		applyProviderGlobalsFromSettings(
			Settings.isolated({
				"providers.webSearch": "not-a-provider",
				"providers.image": 7,
			}),
		);

		expect(webSpy).toHaveBeenCalledWith("auto");
		expect(imageSpy).toHaveBeenCalledWith("auto");
	});
});
