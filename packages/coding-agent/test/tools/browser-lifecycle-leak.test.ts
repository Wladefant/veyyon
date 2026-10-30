/**
 * Regression tests for issue #3963: the browser tool leaks Chromium/Puppeteer
 * resources at two termination boundaries.
 *
 * 1. An aborted `open` observes abort only in its `untilAborted` wrapper — the
 *    inner launch resolves in the background and `acquireBrowser` publishes
 *    the handle unconditionally, leaving a live browser at refCount:0 with no
 *    tab holding it. `releaseTabsForOwner` walks tabs, not browsers, so nothing
 *    ever reaps it.
 * 2. Browser + tab state lives in module-global maps. `AgentSession.dispose()`
 *    walks jobs, eval kernels, provider sessions, and MCP, but has no browser
 *    teardown hook, so any tabs the session opened outlive the session.
 *
 * The tests below cover both by driving `acquireBrowser` / `acquireTab` /
 * `releaseTabsForOwner` directly, with `CmuxSocketClient` prototype methods
 * spied so no real cmux socket / puppeteer process is needed.
 */

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { disposeOwnedResources } from "@veyyon/kernel/session/owned-resources";
import { ToolAbortError } from "@veyyon/coding-agent/tools/core/tool-errors";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import type { CmuxKind } from "@veyyon/coding-agent/tools/web/browser/cmux/rpc";
import { CmuxSocketClient } from "@veyyon/coding-agent/tools/web/browser/cmux/socket-client";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import {
	acquireBrowser,
	getBrowsersMapForTest,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "@veyyon/coding-agent/tools/web/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	releaseTabsForOwner,
	type TabSession,
} from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";

function makeToolSession(sessionId?: string): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getSessionId: () => sessionId,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function makeKind(socketSuffix: string): CmuxKind {
	return { kind: "cmux", socketPath: `/tmp/veyyon-test-${socketSuffix}.sock`, surface: `surface-${socketSuffix}` };
}

async function drainAllTabs(): Promise<void> {
	for (const name of [...getTabsMapForTest().keys()]) {
		await releaseTab(name, { kill: false }).catch(() => undefined);
	}
}

describe("browser lifecycle — aborted open must not leak a browser handle", () => {
	afterEach(async () => {
		await drainAllTabs();
	});

	it("disposes a cmux browser whose launch resolved after the caller aborted", async () => {
		const gate = Promise.withResolvers<void>();
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockImplementation(async () => {
			await gate.promise;
		});
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);

		try {
			const kind = makeKind("abort-orphan");
			const controller = new AbortController();
			const pending = acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal });
			// The reporter's scenario: abort fires while the launch is in flight.
			controller.abort();
			// The launch resolves *after* the abort has been observed by the caller.
			gate.resolve();

			await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			// The freshly-launched browser MUST be torn down before publication so it
			// does not sit at refCount:0 in the global map, leaking a live cmux socket
			// (or, for headless, a live Chromium process) that no `releaseTabsForOwner`
			// / `dropHeadlessTabs` walk would ever reap.
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});

	it("does not launch at all when the signal was already aborted", async () => {
		const connectSpy = spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		const closeSpy = spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		try {
			const kind = makeKind("preaborted");
			const controller = new AbortController();
			controller.abort();
			await expect(acquireBrowser(kind, { cwd: "/tmp", signal: controller.signal })).rejects.toBeInstanceOf(
				ToolAbortError,
			);
			// Not called: pre-abort short-circuit fires before openBrowserHandle.
			expect(connectSpy).not.toHaveBeenCalled();
			expect(closeSpy).not.toHaveBeenCalled();
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			connectSpy.mockRestore();
			closeSpy.mockRestore();
		}
	});
});

describe("browser lifecycle — session-scoped teardown reaps owned tabs", () => {
	afterEach(async () => {
		try {
			await drainAllTabs();
			expect(getTabsMapForTest().size).toBe(0);
			expect(getBrowsersMapForTest().size).toBe(0);
		} finally {
			// The spies sit on `CmuxSocketClient.prototype`: left in place, every later suite in the
			// process talks to these mocks instead of a socket.
			vi.restoreAllMocks();
		}
	});

	it("session disposal reaps only its owned tabs through the registered resource disposer", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		let openCount = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") {
					openCount++;
					return { surface_id: `surface-${openCount}`, url: "about:blank" };
				}
				if (method === "browser.wait") return {};
				if (method === "surface.close") return {};
				if (method === "browser.snapshot" || method === "browser.geometry") return {};
				if (method === "browser.eval") return {};
				return {};
			},
		);

		const kindA = makeKind("owner-a");
		const kindB = makeKind("owner-b");
		const browserA = await acquireBrowser(kindA, { cwd: "/tmp" });
		const browserB = await acquireBrowser(kindB, { cwd: "/tmp" });

		const tabA = await acquireTab("tab-a", browserA, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		await releaseBrowser(browserA, { kill: false });
		const tabB = await acquireTab("tab-b", browserB, { timeoutMs: 1_000, ownerSessionId: "session-B" });
		await releaseBrowser(browserB, { kill: false });

		expect(tabA.tab.ownerSessionId).toBe("session-A");
		expect(tabB.tab.ownerSessionId).toBe("session-B");
		expect(getTabsMapForTest().size).toBe(2);

		// Session disposal must not release a tab owned by another active lane.
		await disposeOwnedResources("session", "session-A");
		expect(getTabsMapForTest().has("tab-a")).toBe(false);
		expect(getTabsMapForTest().has("tab-b")).toBe(true);

		await disposeOwnedResources("session", "session-B");
		expect(getTabsMapForTest().size).toBe(0);
		expect(getBrowsersMapForTest().size).toBe(0);
	});

	it("rejects an explicit close of another session's tab", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async (method: string) => {
			if (method === "browser.open_split") return { surface_id: "foreign-surface", url: "about:blank" };
			return {};
		});

		const browser = await acquireBrowser(makeKind("foreign-close"), { cwd: "/tmp" });
		await acquireTab("foreign-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const tool = new BrowserTool(makeToolSession("session-B"));

		await expect(tool.execute("close-foreign", { action: "close", name: "foreign-tab" })).rejects.toThrow(
			/own|approved/i,
		);
		await expect(tool.execute("close-untracked", { action: "close", name: "foreign-tab" })).rejects.toThrow(
			/own|approved/i,
		);
		expect(getTabsMapForTest().has("foreign-tab")).toBe(true);
	});

	it("rejects close when the lane has no identity to establish ownership", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async (method: string) => {
			if (method === "browser.open_split") return { surface_id: "anonymous-surface", url: "about:blank" };
			return {};
		});

		const browser = await acquireBrowser(makeKind("anonymous-close"), { cwd: "/tmp" });
		await acquireTab("anonymous-tab", browser, { timeoutMs: 1_000 });
		const tool = new BrowserTool(makeToolSession());

		await expect(tool.execute("close-anonymous", { action: "close", name: "anonymous-tab" })).rejects.toThrow(
			/own|approved/i,
		);
		expect(getTabsMapForTest().has("anonymous-tab")).toBe(true);
	});

	it("close all leaves other lane tabs untouched", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		let openCount = 0;
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(async (method: string) => {
			if (method === "browser.open_split") {
				openCount++;
				return { surface_id: `close-all-${openCount}`, url: "about:blank" };
			}
			return {};
		});

		const browserA = await acquireBrowser(makeKind("close-all-a"), { cwd: "/tmp" });
		const browserB = await acquireBrowser(makeKind("close-all-b"), { cwd: "/tmp" });
		await acquireTab("lane-a-tab", browserA, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		await acquireTab("lane-b-tab", browserB, { timeoutMs: 1_000, ownerSessionId: "session-B" });
		const tool = new BrowserTool(makeToolSession("session-B"));

		await tool.execute("close-owned", { action: "close", all: true });

		expect(getTabsMapForTest().has("lane-a-tab")).toBe(true);
		expect(getTabsMapForTest().has("lane-b-tab")).toBe(false);
	});

	// WHY: one tab name is shared, so a second session that opens, reuses, runs or lists it could drive or
	// read another lane's page. These tests pin the refusal before any side effect, and that the owner and
	// ownerless callers keep working.
	it("refuses another session's tab on open, dialog replacement, or no identity, leaving it untouched", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const request = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-deny", url: "about:blank" };
				return {};
			},
		);

		const browser = await acquireBrowser(makeKind("deny-open"), { cwd: "/tmp" });
		const owned = await acquireTab("deny-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const callsBefore = request.mock.calls.length;

		await expect(
			acquireTab("deny-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-B" }),
		).rejects.toThrow(/another session/);
		// A changed dialog policy takes the replacement path, which releases the tab; it must be refused first.
		await expect(
			acquireTab("deny-tab", browser, { timeoutMs: 1_000, dialogs: "accept", ownerSessionId: "session-B" }),
		).rejects.toThrow(/another session/);
		await expect(acquireTab("deny-tab", browser, { timeoutMs: 1_000 })).rejects.toThrow(/another session/);
		await releaseBrowser(browser, { kill: false });

		expect(getTabsMapForTest().get("deny-tab")).toBe(owned.tab);
		expect(owned.tab.state).toBe("alive");
		expect(owned.tab.ownerSessionId).toBe("session-A");
		expect(request.mock.calls.length).toBe(callsBefore);
	});

	it("refuses another session's run on its tab before any code reaches the page", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		const request = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-run-deny", url: "about:blank" };
				return {};
			},
		);

		const browser = await acquireBrowser(makeKind("deny-run"), { cwd: "/tmp" });
		const owned = await acquireTab("deny-run-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		await releaseBrowser(browser, { kill: false });
		const callsBefore = request.mock.calls.length;
		const foreign = new BrowserTool(makeToolSession("session-B"));
		const anonymous = new BrowserTool(makeToolSession());

		await expect(
			foreign.execute("run-foreign", { action: "run", name: "deny-run-tab", code: "return 1;" }),
		).rejects.toThrow(/another session/);
		await expect(
			anonymous.execute("run-anonymous", { action: "run", name: "deny-run-tab", code: "return 1;" }),
		).rejects.toThrow(/another session/);

		expect(request.mock.calls.length).toBe(callsBefore);
		expect(owned.tab.pending.size).toBe(0);
		expect(getTabsMapForTest().get("deny-run-tab")).toBe(owned.tab);
	});

	it("lets the owner reuse its tab and keeps the owner; another session's owner release touches nothing", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-reuse", url: "about:blank" };
				return {};
			},
		);

		const browser = await acquireBrowser(makeKind("reuse"), { cwd: "/tmp" });
		const first = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		const second = await acquireTab("reuse-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-A" });
		await releaseBrowser(browser, { kill: false });

		expect(second.tab).toBe(first.tab);
		expect(second.created).toBe(false);
		expect(second.tab.ownerSessionId).toBe("session-A");

		expect(await releaseTabsForOwner("session-B", { kill: false })).toBe(0);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(true);
		expect(await releaseTabsForOwner("session-A", { kill: false })).toBe(1);
		expect(getTabsMapForTest().has("reuse-tab")).toBe(false);
	});

	it("lets any caller reuse an ownerless tab without taking ownership of it", async () => {
		spyOn(CmuxSocketClient.prototype, "connect").mockResolvedValue(undefined);
		spyOn(CmuxSocketClient.prototype, "close").mockImplementation(() => undefined);
		spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (method: string): Promise<Record<string, unknown>> => {
				if (method === "browser.open_split") return { surface_id: "surface-ownerless", url: "about:blank" };
				return {};
			},
		);

		const browser = await acquireBrowser(makeKind("ownerless-reuse"), { cwd: "/tmp" });
		const first = await acquireTab("ownerless-tab", browser, { timeoutMs: 1_000 });
		const second = await acquireTab("ownerless-tab", browser, { timeoutMs: 1_000, ownerSessionId: "session-B" });
		await releaseBrowser(browser, { kill: false });

		expect(second.tab).toBe(first.tab);
		expect(second.created).toBe(false);
		expect(second.tab.ownerSessionId).toBeUndefined();
	});
});
