import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import { Settings } from "@veyyon/contracts/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import * as launch from "@veyyon/coding-agent/tools/web/browser/launch";
import {
	acquireBrowser,
	getBrowsersMapForTest,
	releaseBrowser,
} from "@veyyon/coding-agent/tools/web/browser/registry";
import * as tabSupervisor from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import {
	getTabsMapForTest,
	releaseAllTabs,
	releaseTab,
	releaseTabsForOwner,
} from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";

async function drainAll(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: true }).catch(() => undefined);
	}
	for (const key of [...getBrowsersMapForTest().keys()]) {
		const b = getBrowsersMapForTest().get(key);
		if (b) await releaseBrowser(b, { kill: true }).catch(() => undefined);
	}
}

function makeMockBrowser() {
	const closeSpy = vi.fn().mockResolvedValue(undefined);
	const mockBrowser = {
		close: closeSpy,
		connected: true,
		process: () => ({ pid: 12345 }),
		version: async () => "Chrome/130.0.0.0",
		wsEndpoint: () => "ws://127.0.0.1:9222/devtools/browser/mock",
	} as unknown as Browser;
	return { mockBrowser, closeSpy };
}

describe("browser registry sweep — close browsers when session releases tabs", () => {
	afterEach(async () => {
		try {
			await drainAll();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("closes and deletes a launched browser with refCount 0 when its session releases tabs", async () => {
		const { mockBrowser, closeSpy } = makeMockBrowser();
		const launchSpy = spyOn(launch, "launchHeadlessBrowser").mockResolvedValue({
			browser: mockBrowser,
			profileDir: undefined,
			identity: undefined,
		});

		const handle = await acquireBrowser(
			{ kind: "headless", headless: true },
			{ cwd: "/tmp", ownerSessionId: "session-sweep-test" },
		);

		expect(launchSpy).toHaveBeenCalledTimes(1);
		expect(handle.refCount).toBe(0);
		expect(getBrowsersMapForTest().size).toBe(1);

		// When the session releases its tabs, it must also close and delete any browser
		// it launched that has refCount 0 and no remaining tabs.
		await releaseTabsForOwner("session-sweep-test", { kill: true });

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(getBrowsersMapForTest().size).toBe(0);
	});

	it("closes and deletes orphan launched browsers when releaseAllTabs is called", async () => {
		const { mockBrowser, closeSpy } = makeMockBrowser();
		const launchSpy = spyOn(launch, "launchHeadlessBrowser").mockResolvedValue({
			browser: mockBrowser,
			profileDir: undefined,
			identity: undefined,
		});

		const handle = await acquireBrowser(
			{ kind: "headless", headless: true },
			{ cwd: "/tmp" },
		);

		expect(launchSpy).toHaveBeenCalledTimes(1);
		expect(handle.refCount).toBe(0);
		expect(getBrowsersMapForTest().size).toBe(1);

		await releaseAllTabs({ kill: true });

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(getBrowsersMapForTest().size).toBe(0);
	});

	it("closes the browser in finally when tab acquisition fails after browser launch", async () => {
		const { mockBrowser, closeSpy } = makeMockBrowser();
		const launchSpy = spyOn(launch, "launchHeadlessBrowser").mockResolvedValue({
			browser: mockBrowser,
			profileDir: undefined,
			identity: undefined,
		});

		const acquireTabSpy = spyOn(tabSupervisor, "acquireTab").mockRejectedValue(
			new Error("Simulated tab worker init failure"),
		);

		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "session-finally-test",
			settings: Settings.isolated({ "browser.headless": true }),
		};

		const tool = new BrowserTool(session);
		await expect(
			tool.execute("call-1", { action: "open", name: "fail-tab", url: "https://example.com" }),
		).rejects.toThrow("Simulated tab worker init failure");

		expect(launchSpy).toHaveBeenCalledTimes(1);
		expect(acquireTabSpy).toHaveBeenCalledTimes(1);
		// Before fix: browser was acquired at refCount 0, sat in browsers map, close was never called.
		// After fix: finally block in #open ensures the browser is closed and evicted.
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(getBrowsersMapForTest().size).toBe(0);
	});
});
