/**
 * WHY: a search provider's browser fallback (`browserFetch` -> `browseHtmlPage`) opens one page in
 * the shared headless browser and closes it in a `finally`. The page was opened through
 * `untilAborted`, which rejects at once on an abort and leaves the `newPage` call running, so a
 * search cancelled while its page was opening never assigned the page and never closed it: the
 * page stayed open in a browser that other tabs and searches keep alive. The retry delay between
 * attempts was a `Bun.sleep` that ignored the abort, so a cancelled search held its page and its
 * browser hold for the whole delay.
 *
 * The class this closes: a browser resource the fallback starts before an abort and receives after
 * it. Both cases cancel at the point where the resource is in flight and assert it is released.
 *
 * What it does NOT catch: a page opened by the browser tool's own tab worker, which has its own
 * lifecycle, and pages a provider's `afterNavigation` hook opens.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as launch from "@veyyon/coding-agent/tools/web/browser/launch";
import * as registry from "@veyyon/coding-agent/tools/web/browser/registry";
import { browserFetch } from "@veyyon/coding-agent/tools/web/search/providers/browser-page";

interface FakePage {
	closes: number;
	goto(): Promise<null>;
	content(): Promise<string>;
	url(): string;
	close(): Promise<void>;
}

function fakePage(): FakePage {
	return {
		closes: 0,
		goto: async () => null,
		content: async () => "<html></html>",
		url: () => "https://search.invalid/",
		async close() {
			this.closes++;
		},
	};
}

/** Route `browserFetch` to its browser fallback, with `newPage` answered by `openPage`. */
function browserWhoseNewPage(openPage: () => Promise<FakePage>): void {
	spyOn(globalThis, "fetch").mockRejectedValue(new Error("network blocked in this suite"));
	spyOn(launch, "applyViewport").mockResolvedValue(undefined);
	spyOn(launch, "applyStealthPatches").mockResolvedValue(undefined);
	const handle = {
		key: "headless:search-suite",
		kind: { kind: "headless", headless: true },
		browser: { connected: false, newPage: openPage },
		refCount: 0,
		identity: undefined,
	} as unknown as registry.BrowserHandle;
	spyOn(registry, "acquireBrowser").mockResolvedValue(handle);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a cancelled browser search", () => {
	it("closes the page that finishes opening after the cancel", async () => {
		const opened = Promise.withResolvers<FakePage>();
		const requested = Promise.withResolvers<void>();
		browserWhoseNewPage(() => {
			requested.resolve();
			return opened.promise;
		});
		const controller = new AbortController();

		const search = browserFetch(() => ({ url: "https://search.invalid/?q=x" }), {
			signal: controller.signal,
			browser: { shouldFallback: () => false },
		});
		await requested.promise;
		controller.abort();
		const outcome = await search.then(
			() => "resolved",
			(error: Error) => error.name,
		);
		const late = fakePage();
		opened.resolve(late);
		await opened.promise;
		await Promise.resolve();

		expect({ outcome, closes: late.closes }).toEqual({ outcome: "AbortError", closes: 1 });
	});

	it("ends at the cancel instead of sleeping out the retry delay", async () => {
		const page = fakePage();
		browserWhoseNewPage(async () => page);
		const controller = new AbortController();
		let navigations = 0;
		page.goto = async () => {
			navigations++;
			return null;
		};
		// The first attempt is rejected; the cancel lands once the retry delay has started.
		const shouldFallback = () => {
			queueMicrotask(() => controller.abort());
			return true;
		};

		const started = performance.now();
		const outcome = await browserFetch(() => ({ url: "https://search.invalid/?q=x" }), {
			signal: controller.signal,
			browser: { shouldFallback, attempts: 2, retryDelayMs: 60_000 },
		}).then(
			() => "resolved",
			(error: Error) => error.name,
		);

		expect({
			outcome,
			navigations,
			closes: page.closes,
			boundedMs: performance.now() - started < 2_000,
		}).toEqual({ outcome: "AbortError", navigations: 1, closes: 1, boundedMs: true });
	});
});
