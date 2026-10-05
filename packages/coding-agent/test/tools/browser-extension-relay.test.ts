import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildConnectUrl,
	ExtensionRelay,
	type NavigationAudit,
} from "@veyyon/coding-agent/tools/web/browser/extension-relay";
import { logger, setAgentDir } from "@veyyon/utils";

const EXTENSION_TOKEN = "extension-token-SECRET-0123456789";

interface Recorded {
	method: string;
	params: unknown[];
}

/** Speaks the Playwright Extension wire protocol: JSON RPC in, `chrome.*` events out. */
class FakeExtension {
	readonly calls: Recorded[] = [];
	#nextTab = 100;
	readonly #failing = new Set<string>();

	/** Make the next `chrome.debugger.sendCommand` of this CDP method fail once. */
	failNext(cdpMethod: string): void {
		this.#failing.add(cdpMethod);
	}
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = event => this.#onMessage(String(event.data));
	}

	static async connect(url: string): Promise<FakeExtension> {
		const ws = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error("extension socket failed"));
		await opened.promise;
		return new FakeExtension(ws);
	}

	get open(): boolean {
		return this.#ws.readyState === WebSocket.OPEN;
	}

	emit(method: string, params: unknown[]): void {
		this.#ws.send(JSON.stringify({ method, params }));
	}

	#onMessage(text: string): void {
		const message: { id: number; method: string; params: unknown[] } = JSON.parse(text);
		this.calls.push({ method: message.method, params: message.params });
		// chrome.tabs.remove never answers on the real extension.
		if (message.method === "chrome.tabs.remove") return;
		const target = message.method === "chrome.debugger.sendCommand" ? String(message.params[1]) : "";
		if (this.#failing.delete(target)) {
			this.#ws.send(JSON.stringify({ id: message.id, error: { message: `${target} refused by the fake` } }));
			return;
		}
		let result: unknown = {};
		if (message.method === "chrome.tabs.create") result = { id: this.#nextTab++ };
		this.#ws.send(JSON.stringify({ id: message.id, result }));
	}

	callsOf(method: string): Recorded[] {
		return this.calls.filter(call => call.method === method);
	}

	close(): void {
		this.#ws.close();
	}
}

interface CdpMessage {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
	sessionId?: string;
}

class CdpTestClient {
	readonly events: CdpMessage[] = [];
	#nextId = 1;
	readonly #pending = new Map<number, (message: CdpMessage) => void>();
	readonly #ws: WebSocket;

	private constructor(ws: WebSocket) {
		this.#ws = ws;
		ws.onmessage = event => {
			const message: CdpMessage = JSON.parse(String(event.data));
			const resolve = message.id === undefined ? undefined : this.#pending.get(message.id);
			if (resolve && message.id !== undefined) {
				this.#pending.delete(message.id);
				resolve(message);
			} else this.events.push(message);
		};
	}

	static async connect(url: string): Promise<CdpTestClient> {
		const ws = new WebSocket(url);
		const opened = Promise.withResolvers<void>();
		ws.onopen = () => opened.resolve();
		ws.onerror = () => opened.reject(new Error("cdp socket failed"));
		await opened.promise;
		return new CdpTestClient(ws);
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpMessage> {
		const id = this.#nextId++;
		const { promise, resolve } = Promise.withResolvers<CdpMessage>();
		this.#pending.set(id, resolve);
		this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
		return promise;
	}

	get closed(): boolean {
		return this.#ws.readyState === WebSocket.CLOSED || this.#ws.readyState === WebSocket.CLOSING;
	}

	close(): void {
		this.#ws.close();
	}
}

/** One HTTP request with a hand-written Host header; fetch will not let a test lie about it. */
function rawHttp(port: number, host: string, requestPath: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1", () => {
			socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
		});
		let data = "";
		socket.on("data", chunk => {
			data += chunk.toString("utf8");
		});
		socket.on("end", () => resolve(data));
		socket.on("error", reject);
	});
}

async function until(check: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

let dir: string;
let relay: ExtensionRelay | undefined;
const audits: NavigationAudit[] = [];

function startRelay(allow: string[]): ExtensionRelay {
	relay = ExtensionRelay.start({
		policy: { allow },
		instance: "test",
		scrub: [EXTENSION_TOKEN],
		onAudit: entry => audits.push(entry),
	});
	return relay;
}

/** Relay with a connected extension and a CDP client that already auto-attaches. */
async function connected(allow: string[]): Promise<{ r: ExtensionRelay; ext: FakeExtension; cdp: CdpTestClient }> {
	const r = startRelay(allow);
	const ext = await FakeExtension.connect(r.extensionUrl);
	await r.waitForExtension(2000);
	const cdp = await CdpTestClient.connect(r.cdpUrl);
	await cdp.send("Target.setDiscoverTargets", { discover: true });
	await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
	return { r, ext, cdp };
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-ext-relay-"));
	setAgentDir(dir);
	audits.length = 0;
});

afterEach(async () => {
	await relay?.close();
	relay = undefined;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("connection rules", () => {
	test("listens on 127.0.0.1 and refuses a foreign Host header", async () => {
		const r = startRelay([]);
		expect(r.extensionUrl.startsWith("ws://127.0.0.1:")).toBe(true);
		expect(r.cdpUrl.startsWith("ws://127.0.0.1:")).toBe(true);
		const reply = await rawHttp(r.port, "evil.example", "/cdp/anything");
		expect(reply.startsWith("HTTP/1.1 403")).toBe(true);
		const own = await rawHttp(r.port, `127.0.0.1:${r.port}`, "/cdp/anything");
		expect(own.startsWith("HTTP/1.1 401")).toBe(true);
	});

	test("a wrong or missing secret is refused on every endpoint", async () => {
		const r = startRelay([]);
		const base = `http://127.0.0.1:${r.port}`;
		expect((await fetch(`${base}/extension/wrong`)).status).toBe(401);
		expect((await fetch(`${base}/extension/`)).status).toBe(401);
		expect((await fetch(`${base}/cdp/wrong`)).status).toBe(401);
		expect((await fetch(`${base}/control/wrong/status`)).status).toBe(401);
		expect((await fetch(`${base}/extension/x`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
	});

	test("a second extension is rejected while one is connected", async () => {
		const r = startRelay([]);
		const first = await FakeExtension.connect(r.extensionUrl);
		await r.waitForExtension(2000);
		const second = await fetch(r.extensionUrl.replace(/^ws:/, "http:"));
		expect(second.status).toBe(409);
		expect(first.open).toBe(true);
	});

	test("waitForExtension times out with a clear message", async () => {
		const r = startRelay([]);
		await expect(r.waitForExtension(50)).rejects.toThrow("did not connect");
	});

	test("the connect URL names the protocol and carries both secrets", () => {
		const url = buildConnectUrl({
			extensionId: "abc",
			protocolVersion: 2,
			relayUrl: "ws://127.0.0.1:1/extension/r",
			token: "tok",
			clientName: "veyyon",
		});
		expect(url).toBe(
			"chrome-extension://abc/connect.html?protocolVersion=2&mcpRelayUrl=ws%3A%2F%2F127.0.0.1%3A1%2Fextension%2Fr&token=tok&client=%7B%22name%22%3A%22veyyon%22%7D",
		);
	});
});

describe("CDP over the extension RPC", () => {
	test("createTarget makes a tab, attaches the debugger and announces the session", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		const created = await cdp.send("Target.createTarget", { url: "about:blank" });
		const targetId = created.result?.targetId;
		expect(typeof targetId).toBe("string");
		expect(ext.callsOf("chrome.tabs.create")).toHaveLength(1);
		expect(ext.callsOf("chrome.debugger.attach")[0]?.params).toEqual([{ tabId: 100 }, "1.3"]);
		const attached = cdp.events.find(event => event.method === "Target.attachedToTarget");
		expect(attached?.params?.targetInfo).toMatchObject({ targetId, type: "page" });
		const targets = await cdp.send("Target.getTargets");
		expect(targets.result?.targetInfos).toHaveLength(1);
	});

	test("session commands reach chrome.debugger.sendCommand for the right tab", async () => {
		const { ext, cdp } = await connected([]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const sessionId = String(cdp.events.find(event => event.method === "Target.attachedToTarget")?.params?.sessionId);
		const evaluated = await cdp.send("Runtime.evaluate", { expression: "1+1" }, sessionId);
		expect(evaluated.error).toBeUndefined();
		expect(evaluated.sessionId).toBe(sessionId);
		expect(ext.callsOf("chrome.debugger.sendCommand").at(-1)?.params).toEqual([
			{ tabId: 100 },
			"Runtime.evaluate",
			{ expression: "1+1" },
		]);
	});

	test("debugger events reach the session of the tab they came from", async () => {
		const { ext, cdp } = await connected([]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const sessionId = String(cdp.events.find(event => event.method === "Target.attachedToTarget")?.params?.sessionId);
		ext.emit("chrome.debugger.onEvent", [{ tabId: 100 }, "Page.loadEventFired", { timestamp: 1 }]);
		ext.emit("chrome.debugger.onEvent", [{ tabId: 999 }, "Page.loadEventFired", { timestamp: 2 }]);
		await until(() => cdp.events.some(event => event.method === "Page.loadEventFired"), "the event");
		const fired = cdp.events.filter(event => event.method === "Page.loadEventFired");
		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatchObject({ sessionId, params: { timestamp: 1 } });
	});

	test("closeTarget detaches the tab and does not wait for chrome.tabs.remove", async () => {
		const { ext, cdp } = await connected([]);
		const created = await cdp.send("Target.createTarget", { url: "about:blank" });
		const started = performance.now();
		const closed = await cdp.send("Target.closeTarget", { targetId: created.result?.targetId });
		expect(closed.result?.success).toBe(true);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(ext.callsOf("chrome.debugger.detach")).toHaveLength(1);
		await until(() => ext.callsOf("chrome.tabs.remove").length === 1, "the tab removal");
		expect(ext.callsOf("chrome.tabs.remove")[0]?.params).toEqual([100]);
		expect((await cdp.send("Target.getTargets")).result?.targetInfos).toHaveLength(0);
	});

	test("Browser.close never closes the operator's Chrome", async () => {
		const { ext, cdp } = await connected([]);
		await cdp.send("Browser.close");
		await until(() => cdp.closed, "the client socket to close");
		expect(ext.callsOf("chrome.tabs.remove")).toHaveLength(0);
		expect(ext.open).toBe(true);
	});

	test("a popup opened by an owned tab is adopted; a tab the user opened is not", async () => {
		const { ext, cdp } = await connected([]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		ext.emit("chrome.tabs.onCreated", [{ id: 555, openerTabId: 12345 }]);
		ext.emit("chrome.tabs.onCreated", [{ id: 556, openerTabId: 100 }]);
		await until(() => ext.callsOf("chrome.debugger.attach").length === 2, "the popup attach");
		expect(ext.callsOf("chrome.debugger.attach")[1]?.params).toEqual([{ tabId: 556 }, "1.3"]);
		await until(
			() => cdp.events.filter(event => event.method === "Target.attachedToTarget").length === 2,
			"the popup session",
		);
	});
});

describe("policy at the relay", () => {
	test("a non-allowlisted createTarget is refused, logged and never reaches Chrome", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		const refused = await cdp.send("Target.createTarget", { url: "https://bank.example.net/login?user=me" });
		expect(refused.error?.message).toContain("not on the extension allowlist");
		expect(ext.callsOf("chrome.tabs.create")).toHaveLength(0);
		expect(audits).toEqual([
			{
				tabId: 0,
				origin: "https://bank.example.net",
				allowed: false,
				reason: expect.stringContaining("not on the extension allowlist"),
			},
		]);
	});

	test("Page.navigate is checked; an allowlisted one passes", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const sessionId = String(cdp.events.find(event => event.method === "Target.attachedToTarget")?.params?.sessionId);
		const refused = await cdp.send("Page.navigate", { url: "https://evil.example/" }, sessionId);
		expect(refused.error?.message).toContain("allowlist");
		const sent = ext.callsOf("chrome.debugger.sendCommand").filter(call => call.params[1] === "Page.navigate");
		expect(sent).toHaveLength(0);
		const allowed = await cdp.send("Page.navigate", { url: "https://staging.example.com/app" }, sessionId);
		expect(allowed.error).toBeUndefined();
		expect(audits.map(entry => [entry.origin, entry.allowed])).toEqual([
			["https://evil.example", false],
			["https://staging.example.com", true],
		]);
	});

	test("production hosts are refused even on the allowlist", async () => {
		const { cdp } = await connected(["zaraprptkegxqpvnsubu.supabase.co"]);
		const refused = await cdp.send("Target.createTarget", { url: "https://zaraprptkegxqpvnsubu.supabase.co/" });
		expect(refused.error?.message).toContain("production host");
	});

	test("data-exporting commands are blocked", async () => {
		const { ext, cdp } = await connected([]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const sessionId = String(cdp.events.find(event => event.method === "Target.attachedToTarget")?.params?.sessionId);
		for (const method of ["Page.printToPDF", "Network.getAllCookies", "Storage.getCookies"]) {
			const reply = await cdp.send(method, {}, sessionId);
			expect(reply.error?.message).toMatch(/blocked|allowlist/);
		}
		const exposed = ext
			.callsOf("chrome.debugger.sendCommand")
			.filter(call => call.params[1] !== "Fetch.enable" && call.params[1] !== "Target.setAutoAttach");
		expect(exposed).toHaveLength(0);
	});

	test("a page that lands on a refused origin is sent back to about:blank", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		ext.emit("chrome.debugger.onEvent", [
			{ tabId: 100 },
			"Page.frameNavigated",
			{ frame: { id: "f", url: "https://redirect.example/landing" } },
		]);
		await until(
			() => ext.callsOf("chrome.debugger.sendCommand").some(call => call.params[1] === "Page.navigate"),
			"the corrective navigation",
		);
		expect(
			ext.callsOf("chrome.debugger.sendCommand").find(call => call.params[1] === "Page.navigate")?.params,
		).toEqual([{ tabId: 100 }, "Page.navigate", { url: "about:blank" }]);
		expect(audits.at(-1)).toMatchObject({ origin: "https://redirect.example", allowed: false });
	});

	test("every owned tab is gated with Fetch.enable before the client can see it", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const gate = ext.callsOf("chrome.debugger.sendCommand").find(call => call.params[1] === "Fetch.enable");
		expect(gate?.params[0]).toEqual({ tabId: 100 });
		const sentOrder = ext.calls.map(call => call.method);
		expect(sentOrder.indexOf("chrome.debugger.attach")).toBeLessThan(
			ext.calls.findIndex(call => call.params[1] === "Fetch.enable"),
		);
	});

	test("a refused document request, including a redirect hop, is failed before it is sent", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const paused = (requestId: string, url: string, resourceType: string) =>
			ext.emit("chrome.debugger.onEvent", [
				{ tabId: 100 },
				"Fetch.requestPaused",
				{ requestId, request: { url }, resourceType },
			]);
		paused("r1", "https://staging.example.com/app", "Document");
		paused("r2", "https://evil.example/landing", "Document");
		paused("r3", "https://app.polysimulator.com./", "Document");
		paused("r4", "https://zaraprptkegxqpvnsubu.supabase.co/rest/v1/x", "Fetch");
		paused("r5", "https://cdn.example.net/logo.png", "Image");
		await until(
			() =>
				ext
					.callsOf("chrome.debugger.sendCommand")
					.filter(call => String(call.params[1]).startsWith("Fetch.") && call.params[1] !== "Fetch.enable")
					.length === 5,
			"five answers",
		);
		const answers = new Map(
			ext
				.callsOf("chrome.debugger.sendCommand")
				.filter(call => String(call.params[1]).startsWith("Fetch.") && call.params[1] !== "Fetch.enable")
				.map(call => [String((call.params[2] as { requestId: string }).requestId), String(call.params[1])]),
		);
		expect(Object.fromEntries(answers)).toEqual({
			r1: "Fetch.continueRequest",
			r2: "Fetch.failRequest",
			r3: "Fetch.failRequest",
			r4: "Fetch.failRequest",
			r5: "Fetch.continueRequest",
		});
		expect(cdp.events.some(event => event.method === "Fetch.requestPaused")).toBe(false);
	});

	test("a client cannot switch the gate off", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const sessionId = String(cdp.events.find(event => event.method === "Target.attachedToTarget")?.params?.sessionId);
		const before = ext.callsOf("chrome.debugger.sendCommand").length;
		for (const method of ["Fetch.disable", "Fetch.enable", "Target.createTarget", "Browser.setDownloadBehavior"]) {
			const reply = await cdp.send(method, {}, sessionId);
			expect(reply.error?.message).toContain("allowlist");
		}
		expect(ext.callsOf("chrome.debugger.sendCommand")).toHaveLength(before);
	});

	test("a popup whose first URL is refused is closed; a user tab with no owned opener is left alone", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		ext.emit("chrome.tabs.onCreated", [{ id: 600, openerTabId: 100, pendingUrl: "https://evil.example/" }]);
		ext.emit("chrome.tabs.onCreated", [{ id: 601, pendingUrl: "chrome://newtab/" }]);
		await until(() => ext.callsOf("chrome.tabs.remove").length > 0, "the popup removal");
		expect(ext.callsOf("chrome.tabs.remove").map(call => call.params)).toEqual([[600]]);
		expect(ext.callsOf("chrome.debugger.attach").map(call => call.params[0])).toEqual([{ tabId: 100 }]);
	});

	test("the relay owns auto-attach: the root is paused-on-start, a client call is ignored", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const sessionId = String(cdp.events.find(event => event.method === "Target.attachedToTarget")?.params?.sessionId);
		const owned = ext
			.callsOf("chrome.debugger.sendCommand")
			.filter(call => call.params[1] === "Target.setAutoAttach");
		expect(owned.map(call => call.params)).toEqual([
			[{ tabId: 100 }, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }],
		]);
		const reply = await cdp.send("Target.setAutoAttach", { autoAttach: false }, sessionId);
		expect(reply.error).toBeUndefined();
		expect(
			ext.callsOf("chrome.debugger.sendCommand").filter(call => call.params[1] === "Target.setAutoAttach"),
		).toHaveLength(1);
	});

	test("a child frame is gated and resumed before the client hears about it; its early request is judged", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		ext.emit("chrome.debugger.onEvent", [
			{ tabId: 100 },
			"Target.attachedToTarget",
			{ sessionId: "child-1", waitingForDebugger: true, targetInfo: { type: "iframe" } },
		]);
		await until(
			() =>
				cdp.events.some(
					event => event.method === "Target.attachedToTarget" && event.params?.sessionId === "child-1",
				),
			"the child announcement",
		);
		const childCalls = ext
			.callsOf("chrome.debugger.sendCommand")
			.filter(call => (call.params[0] as { sessionId?: string }).sessionId === "child-1")
			.map(call => call.params[1]);
		expect(childCalls).toEqual(["Fetch.enable", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
		expect(cdp.events.length).toBeGreaterThan(0);
		// The child asks for a refused document the moment it runs.
		ext.emit("chrome.debugger.onEvent", [
			{ tabId: 100, sessionId: "child-1" },
			"Fetch.requestPaused",
			{ requestId: "c1", request: { url: "https://evil.example/" }, resourceType: "Document" },
		]);
		await until(
			() => ext.callsOf("chrome.debugger.sendCommand").some(call => call.params[1] === "Fetch.failRequest"),
			"the child's request answer",
		);
		const failed = ext.callsOf("chrome.debugger.sendCommand").find(call => call.params[1] === "Fetch.failRequest");
		expect(failed?.params[0]).toEqual({ tabId: 100, sessionId: "child-1" });
	});

	test("an iframe that cannot be gated is detached and never announced", async () => {
		const { ext, cdp } = await connected(["https://staging.example.com"]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		ext.failNext("Fetch.enable");
		ext.emit("chrome.debugger.onEvent", [
			{ tabId: 100 },
			"Target.attachedToTarget",
			{ sessionId: "child-2", waitingForDebugger: true, targetInfo: { type: "iframe" } },
		]);
		await until(
			() => ext.callsOf("chrome.debugger.sendCommand").some(call => call.params[1] === "Target.detachFromTarget"),
			"the detach",
		);
		expect(cdp.events.some(event => event.params?.sessionId === "child-2")).toBe(false);
		expect(
			ext.callsOf("chrome.debugger.sendCommand").some(call => call.params[1] === "Runtime.runIfWaitingForDebugger"),
		).toBe(false);
	});
});

describe("disconnect", () => {
	test("detaches every debugger session, drops the extension and the client, and returns fast", async () => {
		const { r, ext, cdp } = await connected([]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		await cdp.send("Target.createTarget", { url: "about:blank" });
		expect(r.tabCount).toBe(2);
		const started = performance.now();
		const detached = await r.disconnect();
		expect(detached).toBe(2);
		expect(performance.now() - started).toBeLessThan(1500);
		expect(ext.callsOf("chrome.debugger.detach").map(call => call.params)).toEqual([
			[{ tabId: 100 }],
			[{ tabId: 101 }],
		]);
		await until(() => ext.callsOf("chrome.tabs.remove").length === 2, "both tab removals");
		await until(() => cdp.closed, "the CDP client to close");
		await until(() => !ext.open, "the extension socket to close");
		expect(r.tabCount).toBe(0);
		expect(r.extensionConnected).toBe(false);
	});

	test("the control endpoint reports status and disconnects", async () => {
		const { r, ext, cdp } = await connected([]);
		await cdp.send("Target.createTarget", { url: "about:blank" });
		const stateFile = path.join(dir, "browser-extension", "test.relay.json");
		const state: { port: number; control: string } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		const base = `http://127.0.0.1:${state.port}/control/${state.control}`;
		expect(await (await fetch(`${base}/status`)).json()).toEqual({ connected: true, tabs: 1 });
		expect(await (await fetch(`${base}/disconnect`, { method: "POST" })).json()).toEqual({ detached: 1 });
		expect(ext.callsOf("chrome.debugger.detach")).toHaveLength(1);
		expect(r.tabCount).toBe(0);
	});

	test("close removes the state file", async () => {
		const r = startRelay([]);
		const stateFile = path.join(dir, "browser-extension", "test.relay.json");
		expect(fs.existsSync(stateFile)).toBe(true);
		await r.close();
		expect(fs.existsSync(stateFile)).toBe(false);
	});

	test("an extension that goes away closes the CDP clients", async () => {
		const { ext, cdp } = await connected([]);
		ext.close();
		await until(() => cdp.closed, "the CDP client to close");
	});
});

describe("secrets stay out of logs", () => {
	test("no secret appears in any log line across a full run", async () => {
		const lines: string[] = [];
		const record = (...args: unknown[]): void => {
			lines.push(JSON.stringify(args));
		};
		const spies = [
			spyOn(logger, "debug").mockImplementation(record),
			spyOn(logger, "info").mockImplementation(record),
			spyOn(logger, "warn").mockImplementation(record),
			spyOn(logger, "error").mockImplementation(record),
		];
		try {
			const { r, cdp } = await connected(["https://staging.example.com"]);
			await cdp.send("Target.createTarget", { url: "https://evil.example/path?token=1" });
			await cdp.send("Target.createTarget", { url: "https://staging.example.com/" });
			await cdp.send("Nonsense.method");
			const secrets = [EXTENSION_TOKEN, r.extensionUrl.split("/").at(-1), r.cdpUrl.split("/").at(-1)];
			await r.disconnect();
			const joined = lines.join("\n");
			expect(lines.length).toBeGreaterThan(0);
			for (const secret of secrets) expect(joined).not.toContain(String(secret));
			expect(joined).not.toContain("token=1");
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});
