import { setPreferredImageProvider } from "../tools/web/image-gen";
// The LEAVES that own these, not the `../tools/web/search` barrel. The barrel is the
// search tool: it reaches 426 modules, including the theme engine, and this file
// applies three settings. `./provider` and `./types` reach four between them.
import { setExcludedSearchProviders, setPreferredSearchProvider } from "../tools/web/search/provider";
import { isSearchProviderId } from "../tools/web/search/types";
import type { Settings } from "./settings";

/**
 * Apply the web search, excluded web search and image provider preferences in `settings`. The two
 * preferences are enums, which the settings read serves as their default when the stored value is
 * not a member; the exclusion list is an array whose entries the read does not check, so unknown
 * provider ids are dropped here.
 */
export function applyProviderGlobalsFromSettings(settings: Settings): void {
	setExcludedSearchProviders(settings.get("providers.webSearchExclude").filter(isSearchProviderId));
	setPreferredSearchProvider(settings.get("providers.webSearch"));
	setPreferredImageProvider(settings.get("providers.image"));
}
