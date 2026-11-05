import { isScraperDegrade, type RenderResult, type ScraperDegrade } from "@veyyon/web/scrapers/types";

/**
 * Unwrap a special-handler result for tests that expect a successful render or
 * a non-match. A ScraperDegrade here means the scrape failed where the test
 * expected it to work — fail loudly with the degrade note instead of letting
 * property accesses silently misbehave.
 */
export function asRender(result: RenderResult | ScraperDegrade | null): RenderResult | null {
	if (isScraperDegrade(result)) throw new Error(`unexpected scraper degrade: ${result.note}`);
	return result;
}

/** Unwrap a special-handler result for tests that expect a successful render, failing on a non-match or a degrade. */
export function requireRender(result: RenderResult | ScraperDegrade | null): RenderResult {
	if (result === null || isScraperDegrade(result)) {
		throw new Error(`expected a render, got ${JSON.stringify(result)}`);
	}
	return result;
}
