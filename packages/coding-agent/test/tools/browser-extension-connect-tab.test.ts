import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extensionStateDir, PLAYWRIGHT_EXTENSION_ID, writeExtensionToken } from "@veyyon/coding-agent/tools/web/browser/extension-policy";
import { buildConnectUrl, ExtensionRelay } from "@veyyon/coding-agent/tools/web/browser/extension-relay";
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
		if (message.method === "chrome.tabs.create") result = { id: 900 };
		if (cdp === "Target.getTargetInfo") result = { targetInfo: { targetId: "main-frame" } };
		this.#ws.send(JSON.stringify({ id: message.id, result }));
	}

	/** Chrome closes the extension socket when the last attached tab leaves the connection. */
	#detach(tabId: number | undefined): void {
		if (tabId === undefined || !this.#attached.delete(tabId) || this.#attached.size > 0) return;
		this.#ws.close(1000, "All controlled tabs detached");
	}
}

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

/** The tab id a `chrome.*` call names in its first argument, when it names one. */
function tabOf(params: unknown[]): number | undefined {
	const first = params[0];
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

/** Asks the relay for a new target over CDP and returns its reply. */
function createTarget(cdp: WebSocket): Promise<{ result?: { targetId?: string } }> {
	const created = Promise.withResolvers<{ result?: { targetId?: string } }>();
	cdp.onmessage = event => created.resolve(JSON.parse(String(event.data)));
	cdp.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }));
	return created.promise;
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

test("the control endpoint closes the adopted connect tab by id, and only once a working tab is attached", async () => {
	const bootstrap = {
		extensionId: PLAYWRIGHT_EXTENSION_ID,
		protocolVersion: 2,
		token: "t-0123456789",
		clientName: "veyyon",
	};
	relay = ExtensionRelay.start({ instance: INSTANCE, bootstrap });
	const stateFile = fs.readdirSync(extensionStateDir()).find(name => name.endsWith(".relay.json"));
	if (!stateFile) throw new Error("the relay wrote no state file");
	const state: { port: number; control: string } = JSON.parse(
		fs.readFileSync(path.join(extensionStateDir(), stateFile), "utf8"),
	);
	const closeUrl = `http://127.0.0.1:${state.port}/control/${state.control}/close-connect-tab`;
	extension = await FakeExtension.connect(relay.extensionUrl);
	const ext = extension;
	// Before the connect page appears there is nothing to close.
	expect(await (await fetch(closeUrl, { method: "POST" })).json()).toEqual({ closed: false });
	const connectUrl = buildConnectUrl({ ...bootstrap, relayUrl: relay.extensionUrl });
	ext.emit("chrome.tabs.onCreated", [{ id: OPERATOR_TAB, url: "https://operator.example/inbox" }]);
	ext.emit("chrome.tabs.onCreated", [{ id: CONNECT_TAB, url: connectUrl }]);
	await until(() => relay?.tabCount === 1, "the connect tab adoption");
	// The connect tab is the only attached tab, so closing it would drop the socket. The endpoint refuses.
	expect(await (await fetch(closeUrl, { method: "POST" })).json()).toEqual({ closed: false });
	expect(ext.removedTabs()).toEqual([]);
	expect(ext.open).toBe(true);
	// Once a working tab is attached, the endpoint closes the connect tab by id.
	const cdp = await openCdp(relay.cdpUrl);
	expect((await createTarget(cdp)).result?.targetId).toBe("ext-900");
	expect(await (await fetch(closeUrl, { method: "POST" })).json()).toEqual({ closed: true });
	await until(() => ext.removedTabs().length === 1, "the connect tab removal");
	expect(ext.removedTabs()).toEqual([[CONNECT_TAB]]);
	expect(ext.open).toBe(true);
	// A second call finds nothing left, so no other tab is ever removed.
	expect(await (await fetch(closeUrl, { method: "POST" })).json()).toEqual({ closed: false });
	cdp.close();
});
