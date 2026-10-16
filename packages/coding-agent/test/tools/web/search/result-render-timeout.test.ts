/**
 * How long a rendered search page may take to show its results is the browser
 * mechanism's decision, not each provider's.
 *
 * WHY THIS SUITE EXISTS. The providers read through a headless browser each
 * declared `RESULT_RENDER_TIMEOUT_MS = 10_000` beside their own `ready`
 * selector. The SELECTOR is the provider's fact: only google knows its results
 * are `a h3`. The patience is not: the wait exists because a headless browser
 * reports the document loaded before the results are in the DOM, and that is the
 * same race whichever engine is being read. So the default moved to
 * `browser-page.ts`, which owns the mechanism, and `timeoutMs` became optional.
 *
 * `readyTimeoutMs` exists so the resolution is testable without launching a
 * browser, and the zero case below is why it is a function rather than a `??`
 * inline: an explicit `0` has to keep meaning "do not wait".
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AuthStorage } from "@veyyon/ai";
import * as launch from "@veyyon/coding-agent/tools/web/browser/launch";
import * as registry from "@veyyon/coding-agent/tools/web/browser/registry";
import { getSearchProvider, SEARCH_PROVIDER_ORDER } from "@veyyon/coding-agent/tools/web/search/provider";
import { RESULT_RENDER_TIMEOUT_MS, readyTimeoutMs } from "@veyyon/coding-agent/tools/web/search/providers/browser-page";

describe("RESULT_RENDER_TIMEOUT_MS", () => {
	/**
	 * The value, exactly. The page has already responded by the time this wait
	 * starts, so ten seconds is generous; a test that accepted any positive number
	 * would let a minute-long stall through, and a stalled search reads to the user
	 * as a hung tool call.
	 */
	it("is ten seconds", () => {
		expect(RESULT_RENDER_TIMEOUT_MS).toBe(10_000);
	});
});

describe("readyTimeoutMs", () => {
	/** A provider that names only a selector gets the mechanism's default. */
	it("falls back to the shared default when the provider gives no timeout", () => {
		expect(readyTimeoutMs({})).toBe(10_000);
		expect(readyTimeoutMs()).toBe(10_000);
		expect(readyTimeoutMs({ timeoutMs: undefined })).toBe(10_000);
	});

	/** A provider that needs longer or shorter still decides for itself. */
	it("keeps a timeout the provider did specify", () => {
		expect(readyTimeoutMs({ timeoutMs: 250 })).toBe(250);
		expect(readyTimeoutMs({ timeoutMs: 30_000 })).toBe(30_000);
	});

	/**
	 * Zero means do not wait, and is NOT the absent case.
	 *
	 * The reason this is a function with a nullish check rather than `||` at the
	 * call site: a truthiness test would turn "read the page immediately" into a
	 * ten-second wait, and the caller would have no way to ask for no wait at all.
	 */
	it("treats an explicit zero as no wait rather than as absent", () => {
		expect(readyTimeoutMs({ timeoutMs: 0 })).toBe(0);
	});
});

/** The rendered pages one provider search opened, and the selector waits on them. */
interface RenderedRead {
	pages: number;
	waits: Array<{ selector: string; timeout?: number }>;
}

describe("the render wait has one owner", () => {
	/**
	 * Every search provider, run to the point where it reads a rendered page, with the network
	 * refused so a provider that has a browser fallback takes it. The fake browser records each
	 * page opened and each selector wait. Swept from the provider registry, so a provider added tomorrow is run here
	 * without anyone naming it.
	 */
	async function renderedReadsByProvider(): Promise<Record<string, RenderedRead>> {
		spyOn(globalThis, "fetch").mockRejectedValue(new Error("network refused in this suite"));
		spyOn(launch, "applyViewport").mockResolvedValue(undefined);
		spyOn(launch, "applyStealthPatches").mockResolvedValue(undefined);
		let read: RenderedRead = { pages: 0, waits: [] };
		const page = {
			goto: async () => null,
			waitForSelector: async (selector: string, options?: { timeout?: number }) => {
				read.waits.push({ selector, timeout: options?.timeout });
				return null;
			},
			content: async () => "<html><body></body></html>",
			url: () => "https://search.invalid/",
			close: async () => undefined,
		};
		const handle = {
			key: "headless:render-wait-suite",
			kind: { kind: "headless", headless: true },
			browser: {
				connected: false,
				newPage: async () => {
					read.pages++;
					return page;
				},
			},
			refCount: 0,
			identity: undefined,
		} as unknown as registry.BrowserHandle;
		spyOn(registry, "acquireBrowser").mockResolvedValue(handle);

		const byProvider: Record<string, RenderedRead> = {};
		for (const id of SEARCH_PROVIDER_ORDER) {
			if (id === "public") continue; // the aggregate runs the engines swept here by their own ids
			read = { pages: 0, waits: [] };
			const provider = await getSearchProvider(id);
			await provider
				.search({ query: "render wait", authStorage: noCredentials, systemPrompt: "render wait suite" })
				.catch(() => undefined);
			if (read.pages > 0) byProvider[id] = read;
		}
		return byProvider;
	}

	const noCredentials = {
		getApiKey: async () => undefined,
		resolver: () => undefined,
		hasAuth: () => false,
	} as unknown as AuthStorage;

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * A provider names the selector its results render under; the patience is the mechanism's. A
	 * provider that passed its own `timeoutMs` beside the selector, which is how the first two
	 * copies of the number happened, waits a different time and fails here. Pinned by provider, so
	 * a provider that starts or stops reading rendered pages turns this red and someone records it.
	 */
	it("waits for each provider's own selector for the mechanism's default time", async () => {
		expect(await renderedReadsByProvider()).toEqual({
			google: { pages: 1, waits: [{ selector: "a h3", timeout: RESULT_RENDER_TIMEOUT_MS }] },
			mojeek: { pages: 1, waits: [] },
		});
	});
});
