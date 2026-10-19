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
		// `chrome.tabs.remove` never answers on the real extension.
		if (message.method === "chrome.tabs.remove") return;
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
}

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
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

test("a successful connect closes exactly the connect tab and leaves the reused Chrome and its tabs alone", async () => {
	relay = await openExtensionSession(
		{ kind: "extension", instanceId: INSTANCE },
		{ timeoutMs: 3000, launchConnect: reusedOperatorChrome({ openConnectTab: true }) },
	);
	const ext = extension;
	if (!ext) throw new Error("the fake extension never connected");
	await until(() => ext.removedTabs().length === 1, "the connect tab removal");
	expect(ext.removedTabs()).toEqual([[CONNECT_TAB]]);
	expect(ext.calls.some(call => JSON.stringify(call.params).includes(`"tabId":${OPERATOR_TAB}`))).toBe(false);
	// Chrome and the relay link stay up, and nothing owned is left behind.
	expect(ext.open).toBe(true);
	expect(relay.extensionConnected).toBe(true);
	expect(relay.tabCount).toBe(0);
	// The first real target comes from a fresh tab, not from the closed connect tab.
	const cdp = new WebSocket(relay.cdpUrl);
	const opened = Promise.withResolvers<void>();
	cdp.onopen = () => opened.resolve();
	await opened.promise;
	const created = Promise.withResolvers<{ result?: { targetId?: string } }>();
	cdp.onmessage = event => created.resolve(JSON.parse(String(event.data)));
	cdp.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } }));
	expect((await created.promise).result?.targetId).toBe("ext-900");
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

test("the control endpoint closes the adopted connect tab by id for a relay owned by another process", async () => {
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
	expect(await (await fetch(closeUrl, { method: "POST" })).json()).toEqual({ closed: true });
	await until(() => ext.removedTabs().length === 1, "the connect tab removal");
	expect(ext.removedTabs()).toEqual([[CONNECT_TAB]]);
	// A second call finds nothing left, so no other tab is ever removed.
	expect(await (await fetch(closeUrl, { method: "POST" })).json()).toEqual({ closed: false });
});
