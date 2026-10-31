/**
 * Regression for extension lane exit. When a lane's relay is torn down, Chrome must receive
 * `chrome.tabs.remove` and `chrome.debugger.detach` for exactly the tabs that relay created or
 * adopted. No command may ever address a tab the relay does not track: a tab of another lane,
 * a popup of that tab, or a tab the operator opened. A foreign lane's relay keeps its socket and
 * its tab when this lane's relay closes.
 *
 * Driven through the production ExtensionRelay over loopback sockets. Only the Chrome extension
 * is a fake (FakeExtension, same wire shape as browser-extension-relay.test.ts). The teardown is
 * `relay.close()`, the call the browser registry makes for an extension handle.
 *
 * The session path is driven too: `disposeOwnedResources("session", ...)` -> the "browser-tabs"
 * disposer -> `releaseTabsForOwner` -> `tearDownTab` -> `closeOrphanTarget`. That closes the page
 * over the lane's CDP socket, so the relay's `Target.closeTarget` removes the Chrome tab. Tabs are
 * seeded into the supervisor's tab map. The tab worker is a fake that answers `close`.
 *
 * GAPS, not closed here:
 * - The puppeteer Browser is a shim, not a puppeteer connection. Its `targets()` lists the relay's
 *   tracked tabs, and `page().close()` sends the real `Target.closeTarget`. A real `page()` opens a
 *   page session that FakeExtension does not answer, so the puppeteer target-to-page wiring is not
 *   exercised.
 * - The tab worker is a fake. No worker process runs `open`, `run`, or its own page close.
 * - Tabs are seeded, not acquired through `acquireTab`, so the browser holds are set by hand.
 * - The operator's tab is an event the relay ignores. The test asserts that no command addresses it,
 *   not how the relay decides to ignore it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRelay } from "@veyyon/coding-agent/tools/web/browser/extension-relay";
import type { PuppeteerBrowserHandle } from "@veyyon/coding-agent/tools/web/browser/registry";
import type { TabWorkerInbound, TabWorkerOutbound } from "@veyyon/coding-agent/tools/web/browser/tab-protocol";
import {
	getTabsMapForTest,
	releaseTabForOwner,
	releaseTabsForOwner,
	type TabSession,
	type WorkerTabSession,
} from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import { disposeOwnedResources } from "@veyyon/kernel/session/owned-resources";
import { setAgentDir } from "@veyyon/utils";
import type { Browser } from "puppeteer-core";

const UNTRACKED_TABS = [900, 901, 902];

interface Recorded {
	method: string;
	params: unknown[];
}

interface Closable {
	close(): void;
}

/** Speaks the extension side of the wire: records every command and answers like Chrome would. */
class FakeExtension implements Closable {
	readonly calls: Recorded[] = [];
	readonly #ws: WebSocket;
	#nextTab: number;

	private constructor(ws: WebSocket, firstTabId: number) {
		this.#ws = ws;
		this.#nextTab = firstTabId;
		ws.onmessage = event => this.#onMessage(String(event.data));
	}

	static async connect(url: string, firstTabId: number): Promise<FakeExtension> {
		const ws = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error("extension socket failed"));
		await opened.promise;
		return new FakeExtension(ws, firstTabId);
	}

	get open(): boolean {
		return this.#ws.readyState === WebSocket.OPEN;
	}

	/** A `chrome.tabs.*` event the real extension sends when the operator or a page opens a tab. */
	emit(method: string, params: unknown[]): void {
		this.#ws.send(JSON.stringify({ method, params }));
	}

	#onMessage(text: string): void {
		const message: { id: number; method: string; params: unknown[] } = JSON.parse(text);
		this.calls.push({ method: message.method, params: message.params });
		// chrome.tabs.remove never answers on the real extension.
		if (message.method === "chrome.tabs.remove") return;
		let result: unknown = {};
		if (message.method === "chrome.tabs.create") result = { id: this.#nextTab++, windowId: 7 };
		if (message.params[1] === "Target.getTargetInfo")
			result = { targetInfo: { targetId: "main-frame", title: "", url: "about:blank" } };
		this.#ws.send(JSON.stringify({ id: message.id, result }));
	}

	close(): void {
		this.#ws.close();
	}
}

/** The CDP side a puppeteer client uses to ask the relay for tabs. */
class CdpClient implements Closable {
	readonly #ws: WebSocket;
	readonly #pending = new Map<number, (message: CdpReply) => void>();
	#nextId = 1;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = event => {
			const message: CdpReply = JSON.parse(String(event.data));
			const resolve = message.id === undefined ? undefined : this.#pending.get(message.id);
			if (message.id !== undefined) this.#pending.delete(message.id);
			resolve?.(message);
		};
	}

	static async connect(url: string): Promise<CdpClient> {
		const ws = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error("cdp socket failed"));
		await opened.promise;
		return new CdpClient(ws);
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<CdpReply> {
		const id = this.#nextId++;
		const { promise, resolve } = Promise.withResolvers<CdpReply>();
		this.#pending.set(id, resolve);
		this.#ws.send(JSON.stringify({ id, method, params }));
		return promise;
	}

	close(): void {
		this.#ws.close();
	}
}

interface CdpReply {
	id?: number;
	result?: { targetId?: string };
}

/**
 * The tab worker transport. Answers `close` with `closed`, as the real worker does once its page is
 * released, and ignores every other message. The page belongs to the relay, not to the worker.
 */
class FakeTabWorker {
	readonly mode = "inline" as const;
	readonly #handlers = new Set<(msg: TabWorkerOutbound) => void>();

	send(msg: TabWorkerInbound): void {
		if (msg.type !== "close") return;
		// Answer after the caller subscribes: `waitForClosed` listens only after `send` returns.
		setImmediate(() => {
			for (const handler of [...this.#handlers]) handler({ type: "closed" });
		});
	}

	onMessage(handler: (msg: TabWorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		return () => {
			this.#handlers.delete(handler);
		};
	}

	onError(): () => void {
		return () => undefined;
	}

	async terminate(): Promise<void> {}
}

let dir: string;
const relays: ExtensionRelay[] = [];
const clients: Closable[] = [];
const seededTabNames: string[] = [];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-lane-exit-"));
	setAgentDir(dir);
});

afterEach(async () => {
	for (const name of seededTabNames.splice(0)) tabMap.delete(name);
	for (const client of clients.splice(0)) client.close();
	for (const relay of relays.splice(0)) await relay.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

interface Lane {
	relay: ExtensionRelay;
	ext: FakeExtension;
	cdp: CdpClient;
}

/** A relay for one lane, with its extension connected and its CDP client ready. */
async function laneRelay(instance: string, firstTabId: number): Promise<Lane> {
	const relay = ExtensionRelay.start({ instance });
	relays.push(relay);
	const ext = await FakeExtension.connect(relay.extensionUrl, firstTabId);
	clients.push(ext);
	await relay.waitForExtension(2000);
	const cdp = await CdpClient.connect(relay.cdpUrl);
	clients.push(cdp);
	return { relay, ext, cdp };
}

/** Every tab id a recorded command addresses: a bare id (`chrome.tabs.remove`) or `{ tabId }`. */
function tabIdsIn(call: Recorded): number[] {
	const [target] = call.params;
	if (typeof target === "number") return [target];
	if (target !== null && typeof target === "object" && "tabId" in target && typeof target.tabId === "number") {
		return [target.tabId];
	}
	return [];
}

/** The Chrome tab ids a lane's extension was asked to remove, in order. */
function removedTabIds(ext: FakeExtension): number[] {
	return ext.calls
		.filter(call => call.method === "chrome.tabs.remove")
		.flatMap(tabIdsIn)
		.sort((a, b) => a - b);
}

const tabMap = getTabsMapForTest() as Map<string, TabSession>;

/**
 * The puppeteer Browser a tab reads. `targets()` lists the relay's tracked tabs, the set puppeteer
 * discovers through `Target.setDiscoverTargets`. Each page's `close()` sends the real
 * `Target.closeTarget` over the lane's CDP socket.
 */
function relayBrowser(lane: Lane): Browser {
	const target = (targetId: string) => ({
		_targetId: targetId,
		page: async () => ({ close: () => lane.cdp.send("Target.closeTarget", { targetId }) }),
	});
	return {
		connected: true,
		disconnect: () => undefined,
		targets: () => lane.relay.getTrackedTabs().map(tab => target(tab.targetId)),
	} as unknown as Browser;
}

/** The extension browser handle the registry would hold for `lane`, with `refCount` tab holds. */
function extensionHandle(
	instance: string,
	lane: Lane,
	ownerSessionId: string,
	refCount: number,
): PuppeteerBrowserHandle {
	return {
		key: `extension:${instance}`,
		kind: { kind: "extension", instanceId: instance },
		browser: relayBrowser(lane),
		relay: lane.relay,
		refCount,
		ownerSessionId,
	};
}

/** Seeds a live extension tab into the supervisor's map, owned by `ownerSessionId`. */
function seedTab(name: string, browser: PuppeteerBrowserHandle, targetId: string, ownerSessionId: string): void {
	const tab: WorkerTabSession = {
		name,
		backend: "worker",
		kindTag: "extension",
		browser,
		targetId,
		state: "alive",
		info: { url: "about:blank", viewport: { width: 800, height: 600 }, targetId },
		pending: new Map(),
		ownerSessionId,
		worker: new FakeTabWorker(),
	};
	tabMap.set(name, tab);
	seededTabNames.push(name);
}

describe("a lane's exit releases its own tabs and nothing else", () => {
	test("closing the relay removes exactly the tabs it created or adopted and never addresses an untracked tab", async () => {
		const { relay, ext, cdp } = await laneRelay("lane-a", 100);
		const first = await cdp.send("Target.createTarget", { url: "about:blank" });
		const second = await cdp.send("Target.createTarget", { url: "about:blank" });
		expect(first.result?.targetId).toBe("ext-100");
		expect(second.result?.targetId).toBe("ext-101");

		// A popup of an owned tab is adopted; the others have no owned opener and stay untracked.
		ext.emit("chrome.tabs.onCreated", [{ id: 102, openerTabId: 100 }]);
		ext.emit("chrome.tabs.onCreated", [{ id: 900, url: "https://lane-b.example/" }]);
		ext.emit("chrome.tabs.onCreated", [{ id: 901, openerTabId: 900 }]);
		ext.emit("chrome.tabs.onCreated", [{ id: 902, url: "https://operator.example/" }]);
		await until(() => relay.tabCount === 3, "owned popup adoption");

		expect(
			relay
				.getTrackedTabs()
				.map(tab => tab.tabId)
				.sort((a, b) => a - b),
		).toEqual([100, 101, 102]);

		await relay.close();
		await until(() => !ext.open, "extension socket closed by the relay");

		expect(relay.tabCount).toBe(0);
		expect(
			ext.calls
				.filter(call => call.method === "chrome.tabs.remove")
				.flatMap(tabIdsIn)
				.sort((a, b) => a - b),
		).toEqual([100, 101, 102]);
		expect(
			ext.calls
				.filter(call => call.method === "chrome.debugger.detach")
				.flatMap(tabIdsIn)
				.sort((a, b) => a - b),
		).toEqual([100, 101, 102]);
		// Every command the relay ever sent addresses an owned tab, so no untracked tab was touched.
		const touched = new Set(ext.calls.flatMap(tabIdsIn));
		expect([...touched].sort((a, b) => a - b)).toEqual([100, 101, 102]);
		for (const untracked of UNTRACKED_TABS) expect(touched.has(untracked)).toBe(false);
	});

	test("a foreign lane's relay keeps its extension socket and its tab when this lane's relay closes", async () => {
		const lane = await laneRelay("lane-a", 100);
		const foreign = await laneRelay("lane-b", 200);
		const foreignTab = await foreign.cdp.send("Target.createTarget", { url: "about:blank" });
		expect(foreignTab.result?.targetId).toBe("ext-200");
		await lane.cdp.send("Target.createTarget", { url: "about:blank" });

		await lane.relay.close();
		await until(() => !lane.ext.open, "lane extension socket closed");

		expect(foreign.ext.open).toBe(true);
		expect(foreign.relay.tabCount).toBe(1);
		expect(foreign.relay.getTrackedTabs().map(tab => tab.tabId)).toEqual([200]);
		expect(foreign.ext.calls.filter(call => call.method === "chrome.tabs.remove")).toEqual([]);
		expect(foreign.ext.calls.filter(call => call.method === "chrome.debugger.detach")).toEqual([]);
	});

	test("approved IDs do not let bulk release close another lane's owned tab", async () => {
		const lane = await laneRelay("lane-a", 100);
		const foreign = await laneRelay("lane-b", 200);
		const first = await lane.cdp.send("Target.createTarget", { url: "about:blank" });
		const second = await lane.cdp.send("Target.createTarget", { url: "about:blank" });
		const foreignTab = await foreign.cdp.send("Target.createTarget", { url: "about:blank" });
		expect(first.result?.targetId).toBe("ext-100");
		expect(second.result?.targetId).toBe("ext-101");
		expect(foreignTab.result?.targetId).toBe("ext-200");

		const ownedBrowser = extensionHandle("lane-a", lane, "lane-A", 2);
		seedTab("lane-a-approved-first", ownedBrowser, "ext-100", "lane-A");
		seedTab("lane-a-approved-second", ownedBrowser, "ext-101", "lane-A");
		seedTab("lane-b-approved-tab", extensionHandle("lane-b", foreign, "lane-B", 1), "ext-200", "lane-B");

		expect(await releaseTabsForOwner("lane-A", { approvedTabIds: [200] })).toBe(2);
		await until(() => removedTabIds(lane.ext).length === 2, "approved bulk owned tab removals");

		expect(removedTabIds(lane.ext)).toEqual([100, 101]);
		expect(tabMap.get("lane-b-approved-tab")?.state).toBe("alive");
		expect(removedTabIds(foreign.ext)).toEqual([]);
		expect(foreign.ext.calls.filter(call => call.method === "chrome.debugger.detach")).toEqual([]);
	});

	test("disposing the session closes exactly the tabs it owns and leaves another lane's tab and the operator's tab open", async () => {
		const lane = await laneRelay("lane-a", 100);
		const foreign = await laneRelay("lane-b", 200);
		const first = await lane.cdp.send("Target.createTarget", { url: "about:blank" });
		const second = await lane.cdp.send("Target.createTarget", { url: "about:blank" });
		const foreignTab = await foreign.cdp.send("Target.createTarget", { url: "about:blank" });
		expect(first.result?.targetId).toBe("ext-100");
		expect(second.result?.targetId).toBe("ext-101");
		expect(foreignTab.result?.targetId).toBe("ext-200");
		// The operator opens a tab with no opener the relay tracks. The relay never adopts it.
		lane.ext.emit("chrome.tabs.onCreated", [{ id: 900, url: "https://operator.example/" }]);

		// One lane browser holds both owned tabs, so releasing each tab drops one hold.
		const ownedBrowser = extensionHandle("lane-a", lane, "lane-A", 2);
		seedTab("lane-a-first", ownedBrowser, "ext-100", "lane-A");
		seedTab("lane-a-second", ownedBrowser, "ext-101", "lane-A");
		seedTab("lane-b-tab", extensionHandle("lane-b", foreign, "lane-B", 1), "ext-200", "lane-B");

		await expect(releaseTabForOwner("lane-b-tab", "lane-A", { approvedTabIds: [200] })).rejects.toThrow(
			"only for an ownerless relay-controlled tab",
		);
		expect(removedTabIds(foreign.ext)).toEqual([]);

		await disposeOwnedResources("session", "lane-A");

		await until(() => removedTabIds(lane.ext).length === 2, "owned tab removals");
		expect(removedTabIds(lane.ext)).toEqual([100, 101]);
		// Every command the lane's extension received addresses an owned tab. 900 is never addressed.
		const touched = [...new Set(lane.ext.calls.flatMap(tabIdsIn))].sort((a, b) => a - b);
		expect(touched).toEqual([100, 101]);
		for (const untracked of UNTRACKED_TABS) expect(touched.includes(untracked)).toBe(false);
		// The last tab hold drops the browser handle, which closes the lane's relay.
		expect(lane.relay.closed).toBe(true);

		expect(tabMap.has("lane-a-first")).toBe(false);
		expect(tabMap.has("lane-a-second")).toBe(false);
		// Another lane's tab stays alive, and its relay, socket and tab are untouched.
		expect(tabMap.get("lane-b-tab")?.state).toBe("alive");
		expect(foreign.relay.closed).toBe(false);
		expect(foreign.ext.open).toBe(true);
		expect(foreign.relay.getTrackedTabs().map(tab => tab.tabId)).toEqual([200]);
		const foreignRemovals = foreign.ext.calls.filter(
			call => call.method === "chrome.tabs.remove" || call.method === "chrome.debugger.detach",
		);
		expect(foreignRemovals).toEqual([]);
		expect(foreign.ext.calls.flatMap(tabIdsIn).some(id => id === 100 || id === 101)).toBe(false);
	});
});
