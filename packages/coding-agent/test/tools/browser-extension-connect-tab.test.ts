import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeExtensionToken } from "@veyyon/coding-agent/tools/web/browser/extension-policy";
import { ExtensionRelay } from "@veyyon/coding-agent/tools/web/browser/extension-relay";
import { openExtensionSession } from "@veyyon/coding-agent/tools/web/browser/extension-session";
import { setAgentDir } from "@veyyon/utils";

const INSTANCE = "connect-tab";
const CONNECT_TAB = 42;
const OPERATOR_TAB = 7;

interface Call {
	method: string;
	params: unknown[];
}

/** The Playwright Extension's side of the wire: answers `chrome.*` RPC and records every call. */
class FakeExtension {
	readonly calls: Call[] = [];
	readonly #ws: WebSocket;
	readonly #failing: Set<string>;
	readonly #attached = new Set<number>();
	#nextTab = 900;

	private constructor(ws: WebSocket, failing: Set<string>) {
		this.#ws = ws;
		this.#failing = failing;
		ws.onmessage = event => this.#onMessage(String(event.data));
	}

	static async connect(url: string, failing: string[] = []): Promise<FakeExtension> {
		const ws = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error("extension socket failed"));
		await opened.promise;
		return new FakeExtension(ws, new Set(failing));
	}

	get open(): boolean {
		return this.#ws.readyState === WebSocket.OPEN;
	}

	emit(method: string, params: unknown[]): void {
		this.#ws.send(JSON.stringify({ method, params }));
	}

	removedTabs(): unknown[][] {
		return this.calls.filter(call => call.method === "chrome.tabs.remove").map(call => call.params);
	}

	close(): void {
		this.#ws.close();
	}

	#onMessage(text: string): void {
		const message: { id: number; method: string; params: unknown[] } = JSON.parse(text);
		this.calls.push({ method: message.method, params: message.params });
		const tabId = tabOf(message.params);
		if (message.method === "chrome.debugger.attach" && tabId !== undefined) this.#attached.add(tabId);
		if (message.method === "chrome.debugger.detach") this.#detach(tabId);
		// `chrome.tabs.remove` never answers on the real extension. Removing a tab detaches it as well.
		if (message.method === "chrome.tabs.remove") {
			this.#detach(tabId);
			return;
		}
		const cdp = message.method === "chrome.debugger.sendCommand" ? String(message.params[1]) : "";
		if (this.#failing.delete(cdp)) {
			this.#ws.send(JSON.stringify({ id: message.id, error: { message: `${cdp} refused by the fake` } }));
			return;
		}
		let result: unknown = {};
		if (message.method === "chrome.tabs.create") result = { id: this.#nextTab++ };
		if (cdp === "Target.getTargetInfo") result = { targetInfo: { targetId: "main-frame" } };
		this.#ws.send(JSON.stringify({ id: message.id, result }));
	}

	/** Chrome reports the detach to the relay, then closes the socket once the last attached tab leaves. */
	#detach(tabId: number | undefined): void {
		if (tabId === undefined || !this.#attached.delete(tabId)) return;
		this.emit("chrome.debugger.onDetach", [{ tabId }, "target_closed"]);
		if (this.#attached.size === 0) this.#ws.close(1000, "All controlled tabs detached");
	}
}

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

/** The tab id a `chrome.*` call names: a bare id for `chrome.tabs.*`, or `{ tabId }` for `chrome.debugger.*`. */
function tabOf(params: unknown[]): number | undefined {
	const first = params[0];
	if (typeof first === "number") return first;
	if (first && typeof first === "object" && "tabId" in first && typeof first.tabId === "number") return first.tabId;
	return undefined;
}

/** Opens one CDP client on the relay, the way the browser tool connects. */
async function openCdp(cdpUrl: string): Promise<WebSocket> {
	const cdp = new WebSocket(cdpUrl);
	const opened = Promise.withResolvers<void>();
	cdp.onopen = () => opened.resolve();
	await opened.promise;
	return cdp;
}

/** Asks the relay for a new target over CDP and returns its reply. Replies are matched by `id`. */
function createTarget(cdp: WebSocket, id = 1): Promise<{ result?: { targetId?: string } }> {
	const created = Promise.withResolvers<{ result?: { targetId?: string } }>();
	cdp.addEventListener("message", event => {
		const message = JSON.parse(String(event.data));
		if (message.id === id) created.resolve(message);
	});
	cdp.send(JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank" } }));
	return created.promise;
}

/**
 * Returns once the extension has received every frame the relay sent before this call. The relay writes to the
 * extension socket in order, and the fake answers `Page.enable` only after it has read the frames ahead of it,
 * so a `chrome.tabs.remove` the relay issued earlier is already recorded when the reply arrives. Without this a
 * test reads `removedTabs()` before a wrongly issued removal lands, and a missing guard looks like a pass.
 */
async function extensionHasSeenEverything(cdp: WebSocket, targetId: string, id: number): Promise<void> {
	const reply = Promise.withResolvers<{ result?: { sessionId?: string } }>();
	const onMessage = (event: MessageEvent) => {
		const message = JSON.parse(String(event.data));
		if (message.id === id) reply.resolve(message);
	};
	cdp.addEventListener("message", onMessage);
	cdp.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId, flatten: true } }));
	const sessionId = (await reply.promise).result?.sessionId;
	if (sessionId === undefined) throw new Error("the relay gave no session for the barrier");
	const enabled = Promise.withResolvers<void>();
	const onEnabled = (event: MessageEvent) => {
		if (JSON.parse(String(event.data)).id === id + 1) enabled.resolve();
	};
	cdp.addEventListener("message", onEnabled);
	cdp.send(JSON.stringify({ id: id + 1, method: "Page.enable", params: {}, sessionId }));
	await enabled.promise;
	cdp.removeEventListener("message", onMessage);
	cdp.removeEventListener("message", onEnabled);
}

let dir: string;
let extension: FakeExtension | undefined;
let relay: ExtensionRelay | undefined;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-connect-tab-"));
	setAgentDir(dir);
	writeExtensionToken(INSTANCE, "connect-tab-token-0123456789");
});

afterEach(async () => {
	extension?.close();
	extension = undefined;
	await relay?.close();
	relay = undefined;
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Stands in for Chrome. It reuses the operator's running browser: an unrelated tab already exists, and the
 * connect page opens as one more tab whose url is exactly the consent URL.
 */
function reusedOperatorChrome(opts: { openConnectTab: boolean; failing?: string[] }) {
	return async (connectUrl: string): Promise<void> => {
		const relayUrl = new URL(connectUrl).searchParams.get("mcpRelayUrl");
		if (relayUrl === null) throw new Error("the connect url carries no relay url");
		extension = await FakeExtension.connect(relayUrl, opts.failing);
		extension.emit("chrome.tabs.onCreated", [{ id: OPERATOR_TAB, url: "https://operator.example/inbox" }]);
		if (opts.openConnectTab) extension.emit("chrome.tabs.onCreated", [{ id: CONNECT_TAB, url: connectUrl }]);
	};
}

test("the connect tab stays attached until the first browser tab is attached, then it is closed by id", async () => {
	relay = await openExtensionSession(
		{ kind: "extension", instanceId: INSTANCE },
		{ timeoutMs: 3000, launchConnect: reusedOperatorChrome({ openConnectTab: true }) },
	);
	const ext = extension;
	if (!ext) throw new Error("the fake extension never connected");
	// Chrome drops the socket when its last attached tab goes, so the connect tab waits for its replacement.
	expect(ext.removedTabs()).toEqual([]);
	expect(ext.open).toBe(true);
	expect(relay.extensionConnected).toBe(true);
	expect(relay.tabCount).toBe(1);
	const cdp = await openCdp(relay.cdpUrl);
	expect((await createTarget(cdp)).result?.targetId).toBe("ext-900");
	await until(() => ext.removedTabs().length === 1, "the connect tab removal");
	expect(ext.removedTabs()).toEqual([[CONNECT_TAB]]);
	// The replacement attaches before the connect tab leaves, so the socket survives that removal.
	const attachedAt = ext.calls.findIndex(call => call.method === "chrome.debugger.attach" && tabOf(call.params) === 900);
	const removedAt = ext.calls.findIndex(call => call.method === "chrome.tabs.remove");
	expect(attachedAt).toBeGreaterThanOrEqual(0);
	expect(attachedAt).toBeLessThan(removedAt);
	expect(ext.open).toBe(true);
	expect(relay.extensionConnected).toBe(true);
	expect(relay.tabCount).toBe(1);
	// The reused operator Chrome and its tabs stay untouched.
	expect(ext.calls.some(call => JSON.stringify(call.params).includes(`"tabId":${OPERATOR_TAB}`))).toBe(false);
	expect(ext.calls.filter(call => call.method === "chrome.tabs.create")).toHaveLength(1);
	cdp.close();
});

test("a removed connect tab is never removed again when a working tab attaches", async () => {
	relay = await openExtensionSession(
		{ kind: "extension", instanceId: INSTANCE },
		{ timeoutMs: 3000, launchConnect: reusedOperatorChrome({ openConnectTab: true }) },
	);
	const ext = extension;
	if (!ext) throw new Error("the fake extension never connected");
	ext.emit("chrome.tabs.onRemoved", [CONNECT_TAB]);
	await until(() => relay?.tabCount === 0, "the connect tab removal event");
	const cdp = await openCdp(relay.cdpUrl);
	try {
		expect((await createTarget(cdp)).result?.targetId).toBe("ext-900");
		expect(ext.removedTabs()).toEqual([]);
		expect(relay.tabCount).toBe(1);
	} finally {
		cdp.close();
	}
});

test("a failed connect also closes the connect tab it opened, and no other tab", async () => {
	await expect(
		openExtensionSession(
			{ kind: "extension", instanceId: INSTANCE },
			{
				timeoutMs: 300,
				launchConnect: reusedOperatorChrome({ openConnectTab: true, failing: ["Fetch.enable"] }),
			},
		),
	).rejects.toThrow("Could not connect to the Chrome extension");
	const ext = extension;
	if (!ext) throw new Error("the fake extension never connected");
	await until(() => !ext.open, "the relay to drop the extension");
	expect(ext.removedTabs()).toEqual([[CONNECT_TAB]]);
	expect(ext.calls.some(call => JSON.stringify(call.params).includes(`"tabId":${OPERATOR_TAB}`))).toBe(false);
});

test("a connect that never opened a tab removes nothing from the operator's Chrome", async () => {
	await expect(
		openExtensionSession(
			{ kind: "extension", instanceId: INSTANCE },
			{ timeoutMs: 100, launchConnect: reusedOperatorChrome({ openConnectTab: false }) },
		),
	).rejects.toThrow("The extension did not connect");
	const ext = extension;
	if (!ext) throw new Error("the fake extension never connected");
	await until(() => !ext.open, "the relay to drop the extension");
	expect(ext.removedTabs()).toEqual([]);
});

test("an extension that drops and reconnects never has the old connect tab id removed", async () => {
	relay = await openExtensionSession(
		{ kind: "extension", instanceId: INSTANCE },
		{ timeoutMs: 3000, launchConnect: reusedOperatorChrome({ openConnectTab: true }) },
	);
	const first = extension;
	if (!first) throw new Error("the fake extension never connected");
	first.close();
	await until(() => relay?.extensionConnected === false, "the relay to notice the dropped extension");
	// Chrome may hand id 42 to an operator tab by now. The reconnected extension never saw the connect tab.
	const second = await FakeExtension.connect(relay.extensionUrl);
	extension = second;
	await until(() => relay?.extensionConnected === true, "the extension to reconnect");
	const cdp = await openCdp(relay.cdpUrl);
	try {
		expect((await createTarget(cdp)).result?.targetId).toBe("ext-900");
		await extensionHasSeenEverything(cdp, "ext-900", 10);
		expect(
			second.calls.some(call => call.method === "chrome.debugger.sendCommand" && call.params[1] === "Page.enable"),
		).toBe(true);
		expect(relay.tabCount).toBe(1);
		expect(second.removedTabs()).toEqual([]);
		expect(first.removedTabs()).toEqual([]);
	} finally {
		cdp.close();
	}
});

test("two parallel Target.createTarget calls remove the connect tab exactly once", async () => {
	relay = await openExtensionSession(
		{ kind: "extension", instanceId: INSTANCE },
		{ timeoutMs: 3000, launchConnect: reusedOperatorChrome({ openConnectTab: true }) },
	);
	const ext = extension;
	if (!ext) throw new Error("the fake extension never connected");
	const cdp = await openCdp(relay.cdpUrl);
	try {
		const replies = await Promise.all([createTarget(cdp, 1), createTarget(cdp, 2)]);
		expect(replies.map(reply => reply.result?.targetId).sort()).toEqual(["ext-900", "ext-901"]);
		await extensionHasSeenEverything(cdp, "ext-900", 10);
		expect(ext.removedTabs()).toEqual([[CONNECT_TAB]]);
		expect(ext.open).toBe(true);
		expect(relay.tabCount).toBe(2);
	} finally {
		cdp.close();
	}
});
