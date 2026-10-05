/**
 * Loopback relay between the Playwright Extension and puppeteer.
 *
 * The extension connects OUT to this relay over a WebSocket and offers a small allow-listed
 * `chrome.*` RPC (`chrome.debugger.attach/detach/sendCommand`, `chrome.tabs.create/remove`).
 * This module turns that RPC into a browser-level CDP endpoint (`Target.*` with flat sessions),
 * so puppeteer, the tab worker and every `tab.*` helper run unchanged.
 *
 * The relay never opens a CDP port on the browser. It listens on 127.0.0.1 only, accepts one
 * extension connection, exposes only tabs it created or that those tabs opened, and applies
 * the policy of `extension-policy.ts` to every navigation and every export-style command.
 *
 * Extension protocol: Playwright Extension 0.4.0, relay protocol version 2 (Apache-2.0).
 * `chrome.tabs.remove` does not answer on the wire, so teardown never waits for it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { type } from "arktype";
import type { Server, ServerWebSocket } from "bun";
import {
	checkCdpMethod,
	checkNavigation,
	type ExtensionPolicy,
	extensionStateDir,
	generateSecret,
	instanceFileName,
	isProductionUrl,
	type PolicyDecision,
	redactSecrets,
	secretsEqual,
} from "./extension-policy";

const EXTENSION_CALL_TIMEOUT_MS = 15_000;
const DETACH_TIMEOUT_MS = 2_000;
const CDP_ERROR_CODE = -32000;
const METHOD_NOT_FOUND_CODE = -32601;

/** Auto-attach owned by the relay: children start paused so they are gated before they run. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

/** Runs in every document of a controlled tab: no popups. Links and forms that ask for a new window stay in place, where the request gate judges them. */
const POPUP_GUARD_SOURCE = `(() => {
  const key = "__veyyonPopupGuard";
  if (window[key]) return;
  Object.defineProperty(window, key, { value: true });
  window.open = () => null;
  const same = event => {
    const el = event.target instanceof Element ? event.target.closest("a[target],area[target],form[target]") : null;
    if (el && el.getAttribute("target") && !["_self", "_parent", "_top"].includes(el.getAttribute("target"))) el.setAttribute("target", "_self");
  };
  addEventListener("click", same, true);
  addEventListener("submit", same, true);
})();`;

export interface NavigationAudit {
	tabId: number;
	/** `scheme://host`, never the path or query, never page content. */
	origin: string;
	allowed: boolean;
	reason?: string;
}

export interface ExtensionRelayOptions {
	policy: ExtensionPolicy;
	/** Names the state file so several Chrome profiles do not collide. */
	instance?: string;
	/** Other secrets the caller holds (the extension token); they are scrubbed from every log line. */
	scrub?: readonly string[];
	onAudit?: (entry: NavigationAudit) => void;
}

interface OwnedTab {
	tabId: number;
	targetId: string;
	url: string;
	title: string;
}

interface CdpClient {
	id: number;
	ws: ServerWebSocket<SocketData>;
	discover: boolean;
	autoAttach: boolean;
	/** Root session id to tab id. */
	sessions: Map<string, number>;
}

interface SocketData {
	role: "extension" | "cdp";
	clientId?: number;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const cdpRequestSchema = type({
	id: "number",
	method: "string",
	"params?": "Record<string, unknown>",
	"sessionId?": "string",
});

const extensionMessageSchema = type({
	"id?": "number",
	"method?": "string",
	"params?": "unknown[]",
	"result?": "unknown",
	"error?": "unknown",
});

const debugSourceSchema = type({ tabId: "number", "sessionId?": "string" });
const tabSchema = type({ id: "number", "openerTabId?": "number", "pendingUrl?": "string", "url?": "string" });
const requestPausedSchema = type({ requestId: "string", request: { url: "string" }, resourceType: "string" });
const frameNavigatedSchema = type({ frame: { "parentId?": "string", url: "string" } });
const attachedSchema = type({
	sessionId: "string",
	"waitingForDebugger?": "boolean",
	"targetInfo?": { type: "string" },
});

function errorText(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === "object" && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	return JSON.stringify(error);
}

export class ExtensionRelay {
	readonly #policy: ExtensionPolicy;
	readonly #instance: string | undefined;
	readonly #scrub: string[];
	readonly #onAudit: ((entry: NavigationAudit) => void) | undefined;
	readonly #relaySecret = generateSecret();
	readonly #cdpSecret = generateSecret();
	readonly #controlSecret = generateSecret();
	readonly #server: Server<SocketData>;
	readonly #clients = new Map<number, CdpClient>();
	readonly #tabs = new Map<number, OwnedTab>();
	/** Chrome's own child session ids (iframes, workers) to the tab that owns them. */
	readonly #childSessions = new Map<string, number>();
	readonly #pending = new Map<number, PendingCall>();
	#extension: ServerWebSocket<SocketData> | undefined;
	#extensionWaiters: Array<() => void> = [];
	#nextCallId = 1;
	#nextClientId = 1;
	#nextSessionId = 1;
	#closed = false;

	private constructor(opts: ExtensionRelayOptions) {
		this.#policy = opts.policy;
		this.#instance = opts.instance;
		this.#onAudit = opts.onAudit;
		this.#scrub = [...(opts.scrub ?? [])];
		this.#server = Bun.serve<SocketData>({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req, server) => this.#fetch(req, server),
			websocket: {
				open: ws => this.#onOpen(ws),
				message: (ws, data) => this.#onMessage(ws, data),
				close: ws => this.#onSocketClose(ws),
			},
		});
		this.#scrub.push(this.#relaySecret, this.#cdpSecret, this.#controlSecret);
		this.#writeStateFile();
	}

	static start(opts: ExtensionRelayOptions): ExtensionRelay {
		return new ExtensionRelay(opts);
	}

	get port(): number {
		const port = this.#server.port;
		if (port === undefined) throw new Error("The relay has no port.");
		return port;
	}

	/** WebSocket URL the extension connects to. Carries a secret: never log it. */
	get extensionUrl(): string {
		return `ws://127.0.0.1:${this.port}/extension/${this.#relaySecret}`;
	}

	/** Browser WebSocket endpoint for puppeteer. Carries a secret: never log it. */
	get cdpUrl(): string {
		return `ws://127.0.0.1:${this.port}/cdp/${this.#cdpSecret}`;
	}

	get extensionConnected(): boolean {
		return this.#extension !== undefined;
	}

	get tabCount(): number {
		return this.#tabs.size;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Resolve once the extension has connected. */
	waitForExtension(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (this.#extension) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			const done = (): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = (): void => {
				clearTimeout(timer);
				this.#extensionWaiters = this.#extensionWaiters.filter(w => w !== done);
				reject(
					signal?.reason instanceof Error ? signal.reason : new Error("Waiting for the extension was aborted."),
				);
			};
			const timer = setTimeout(() => {
				this.#extensionWaiters = this.#extensionWaiters.filter(w => w !== done);
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`The extension did not connect within ${Math.round(timeoutMs / 1000)} s.`));
			}, timeoutMs);
			this.#extensionWaiters.push(done);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
		});
	}

	/**
	 * Detach every debugger session and drop the extension. Never waits for `chrome.tabs.remove`:
	 * it does not reply. Returns how many tabs were detached.
	 */
	async disconnect(): Promise<number> {
		const tabs = [...this.#tabs.values()];
		this.#tabs.clear();
		this.#childSessions.clear();
		await Promise.all(
			tabs.map(tab =>
				this.#call("chrome.debugger.detach", [{ tabId: tab.tabId }], DETACH_TIMEOUT_MS).catch(() => undefined),
			),
		);
		for (const tab of tabs) this.#fireAndForget("chrome.tabs.remove", [tab.tabId]);
		for (const client of this.#clients.values()) client.ws.close(1001, "relay disconnected");
		this.#clients.clear();
		this.#extension?.close(1000, "disconnected by veyyon");
		this.#extension = undefined;
		return tabs.length;
	}

	/** Disconnect, stop listening and remove the state file. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.disconnect();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("The relay closed."));
		}
		this.#pending.clear();
		this.#server.stop(true);
		fs.rmSync(this.#stateFile(), { force: true });
	}

	#stateFile(): string {
		return path.join(extensionStateDir(), `${instanceFileName(this.#instance)}.relay.json`);
	}

	/** Lets `veyyon browser-extension status|disconnect` reach this process. Private to the user. */
	#writeStateFile(): void {
		const file = this.#stateFile();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const state = { port: this.port, control: this.#controlSecret, pid: process.pid };
		fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
	}

	#log(message: string, fields?: Record<string, unknown>): void {
		logger.debug(redactSecrets(message, this.#scrub), fields);
	}

	// ----- HTTP and WebSocket entry --------------------------------------------------------

	#hostAllowed(req: Request): boolean {
		const host = req.headers.get("host");
		if (host === null) return false;
		const port = this.port;
		return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
	}

	async #fetch(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
		if (!this.#hostAllowed(req)) return new Response("forbidden", { status: 403 });
		const url = new URL(req.url);
		const parts = url.pathname.split("/").filter(Boolean);
		const origin = req.headers.get("origin");
		if (parts[0] === "extension") {
			if (origin !== null && !origin.startsWith("chrome-extension://"))
				return new Response("forbidden", { status: 403 });
			if (!secretsEqual(this.#relaySecret, parts[1])) return new Response("unauthorized", { status: 401 });
			if (this.#extension) return new Response("an extension is already connected", { status: 409 });
			if (server.upgrade(req, { data: { role: "extension" } satisfies SocketData })) return undefined;
			return new Response("expected a websocket", { status: 400 });
		}
		if (parts[0] === "cdp") {
			if (origin !== null) return new Response("forbidden", { status: 403 });
			if (!secretsEqual(this.#cdpSecret, parts[1])) return new Response("unauthorized", { status: 401 });
			const data: SocketData = { role: "cdp", clientId: this.#nextClientId++ };
			if (server.upgrade(req, { data })) return undefined;
			return new Response("expected a websocket", { status: 400 });
		}
		if (parts[0] === "control") {
			if (origin !== null) return new Response("forbidden", { status: 403 });
			if (!secretsEqual(this.#controlSecret, parts[1])) return new Response("unauthorized", { status: 401 });
			if (parts[2] === "status" && req.method === "GET") {
				return Response.json({ connected: this.extensionConnected, tabs: this.tabCount });
			}
			if (parts[2] === "disconnect" && req.method === "POST") {
				const detached = await this.disconnect();
				return Response.json({ detached });
			}
		}
		return new Response("not found", { status: 404 });
	}

	#onOpen(ws: ServerWebSocket<SocketData>): void {
		if (ws.data.role === "extension") {
			this.#extension = ws;
			const waiters = this.#extensionWaiters;
			this.#extensionWaiters = [];
			for (const waiter of waiters) waiter();
			return;
		}
		const clientId = ws.data.clientId;
		if (clientId === undefined) return;
		this.#clients.set(clientId, { id: clientId, ws, discover: false, autoAttach: false, sessions: new Map() });
	}

	#onSocketClose(ws: ServerWebSocket<SocketData>): void {
		if (ws.data.role === "extension") {
			if (this.#extension === ws) this.#onExtensionGone();
			return;
		}
		if (ws.data.clientId !== undefined) this.#clients.delete(ws.data.clientId);
	}

	/** The extension went away (idle service worker, last tab detached, user removed it). */
	#onExtensionGone(): void {
		this.#extension = undefined;
		this.#tabs.clear();
		this.#childSessions.clear();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("The extension disconnected."));
		}
		this.#pending.clear();
		for (const client of this.#clients.values()) client.ws.close(1001, "extension disconnected");
		this.#clients.clear();
	}

	#onMessage(ws: ServerWebSocket<SocketData>, data: string | Buffer): void {
		let raw: unknown;
		try {
			raw = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
		} catch {
			return;
		}
		if (ws.data.role === "extension") {
			const message = extensionMessageSchema(raw);
			if (message instanceof type.errors) return;
			this.#onExtensionMessage(message);
			return;
		}
		const request = cdpRequestSchema(raw);
		if (request instanceof type.errors) return;
		const client = ws.data.clientId === undefined ? undefined : this.#clients.get(ws.data.clientId);
		if (!client) return;
		void this.#handleCdp(client, request.id, request.method, request.params ?? {}, request.sessionId);
	}

	// ----- Extension RPC -----------------------------------------------------------------

	#call(method: string, params: unknown[], timeoutMs = EXTENSION_CALL_TIMEOUT_MS): Promise<unknown> {
		const ws = this.#extension;
		if (!ws) return Promise.reject(new Error("The extension is not connected."));
		const id = this.#nextCallId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`The extension did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`));
			}, timeoutMs);
			this.#pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Send a command and never wait for its reply (`chrome.tabs.remove` has none). */
	#fireAndForget(method: string, params: unknown[]): void {
		const ws = this.#extension;
		if (!ws) return;
		ws.send(JSON.stringify({ id: this.#nextCallId++, method, params }));
	}

	#onExtensionMessage(message: typeof extensionMessageSchema.infer): void {
		if (message.id !== undefined && this.#pending.has(message.id)) {
			const pending = this.#pending.get(message.id);
			this.#pending.delete(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			if (message.error !== undefined) pending.reject(new Error(errorText(message.error)));
			else pending.resolve(message.result);
			return;
		}
		if (message.method === undefined) return;
		const params = message.params ?? [];
		switch (message.method) {
			case "chrome.debugger.onEvent":
				this.#onDebuggerEvent(params);
				return;
			case "chrome.debugger.onDetach": {
				const source = debugSourceSchema(params[0]);
				if (!(source instanceof type.errors)) this.#dropTab(source.tabId);
				return;
			}
			case "chrome.tabs.onRemoved":
				if (typeof params[0] === "number") this.#dropTab(params[0]);
				return;
			case "chrome.tabs.onCreated": {
				const tab = tabSchema(params[0]);
				if (tab instanceof type.errors) return;
				if (tab.openerTabId === undefined || !this.#tabs.has(tab.openerTabId)) return;
				const landing = tab.pendingUrl ?? tab.url;
				if (landing !== undefined && landing !== "") {
					const decision = checkNavigation(this.#policy, landing);
					if (!decision.allowed) {
						this.#audit(tab.id, landing, decision);
						this.#fireAndForget("chrome.tabs.remove", [tab.id]);
						return;
					}
				}
				void this.#registerTab(tab.id).catch(error =>
					this.#log("could not adopt a popup", { error: errorText(error) }),
				);
				return;
			}
		}
	}

	#onDebuggerEvent(params: unknown[]): void {
		const source = debugSourceSchema(params[0]);
		const method = params[1];
		if (source instanceof type.errors || typeof method !== "string") return;
		const tab = this.#tabs.get(source.tabId);
		if (!tab) return;
		const eventParams = params[2];
		if (method === "Fetch.requestPaused") {
			this.#onRequestPaused(source, eventParams);
			return;
		}
		if (method === "Target.attachedToTarget") {
			const attached = attachedSchema(eventParams);
			if (attached instanceof type.errors) return;
			this.#childSessions.set(attached.sessionId, tab.tabId);
			void this.#gateChild(tab, source, attached, eventParams).catch(error =>
				this.#log("could not gate a child session", { error: errorText(error) }),
			);
			return;
		}
		if (method === "Target.detachedFromTarget") {
			const detached = attachedSchema(eventParams);
			if (!(detached instanceof type.errors)) this.#childSessions.delete(detached.sessionId);
		} else if (method === "Page.frameNavigated" && source.sessionId === undefined) {
			const navigated = frameNavigatedSchema(eventParams);
			if (!(navigated instanceof type.errors) && navigated.frame.parentId === undefined) {
				this.#onMainFrameNavigated(tab, navigated.frame.url);
			}
		}
		this.#forwardEvent(tab, source, method, eventParams);
	}

	#forwardEvent(
		tab: OwnedTab,
		source: { tabId: number; sessionId?: string },
		method: string,
		eventParams: unknown,
	): void {
		for (const client of this.#clients.values()) {
			for (const [sessionId, tabId] of client.sessions) {
				if (tabId !== tab.tabId) continue;
				this.#send(client, { sessionId: source.sessionId ?? sessionId, method, params: eventParams ?? {} });
			}
		}
	}

	/**
	 * A child target (iframe, popup frame, worker) starts paused because the relay owns auto-attach with
	 * `waitForDebuggerOnStart`. Gate it first, then resume it, then tell the client. An iframe or page
	 * that cannot be gated is detached and never shown.
	 */
	async #gateChild(
		tab: OwnedTab,
		source: { tabId: number; sessionId?: string },
		attached: typeof attachedSchema.infer,
		eventParams: unknown,
	): Promise<void> {
		const debuggee = { tabId: tab.tabId, sessionId: attached.sessionId };
		const kind = attached.targetInfo?.type;
		try {
			await this.#enableFetchGate(debuggee);
			await this.#call("chrome.debugger.sendCommand", [debuggee, "Target.setAutoAttach", AUTO_ATTACH]);
		} catch (error) {
			if (kind === "iframe" || kind === "page") {
				this.#childSessions.delete(attached.sessionId);
				await this.#call("chrome.debugger.sendCommand", [
					{ tabId: tab.tabId },
					"Target.detachFromTarget",
					{ sessionId: attached.sessionId },
				]).catch(() => {});
				throw error;
			}
			this.#log("a worker target could not be gated", { error: errorText(error) });
		}
		if (attached.waitingForDebugger === true) {
			await this.#call("chrome.debugger.sendCommand", [debuggee, "Runtime.runIfWaitingForDebugger", {}]);
		}
		if (this.#tabs.has(tab.tabId)) this.#forwardEvent(tab, source, "Target.attachedToTarget", eventParams);
	}

	/**
	 * Pause every request of a debuggee so the policy runs before the request leaves, cookies included,
	 * and keep its pages from opening popups. A popup is a new tab that Chrome loads before the debugger
	 * can attach, so the only gate is to stop `window.open` and `target=_blank` at the source.
	 */
	async #enableFetchGate(debuggee: { tabId: number; sessionId?: string }): Promise<void> {
		await this.#call("chrome.debugger.sendCommand", [
			debuggee,
			"Fetch.enable",
			{ patterns: [{ urlPattern: "*", requestStage: "Request" }] },
		]);
		await this.#call("chrome.debugger.sendCommand", [
			debuggee,
			"Page.addScriptToEvaluateOnNewDocument",
			{ source: POPUP_GUARD_SOURCE, runImmediately: true },
		]);
	}

	/**
	 * Decide a paused request. Documents (top level, frames, every redirect hop) must pass the full
	 * policy. Other resources fail only when they target a production host. Fails closed on error.
	 */
	#onRequestPaused(source: { tabId: number; sessionId?: string }, params: unknown): void {
		const paused = requestPausedSchema(params);
		if (paused instanceof type.errors) return;
		const url = paused.request.url;
		let allowed: boolean;
		if (paused.resourceType === "Document") {
			const decision = checkNavigation(this.#policy, url);
			if (!decision.allowed) this.#audit(source.tabId, url, decision);
			allowed = decision.allowed;
		} else if (url.startsWith("data:") || url.startsWith("blob:")) {
			allowed = true;
		} else {
			allowed = !isProductionUrl(url);
		}
		const debuggee = source.sessionId === undefined ? { tabId: source.tabId } : source;
		const reply = allowed
			? this.#call("chrome.debugger.sendCommand", [
					debuggee,
					"Fetch.continueRequest",
					{ requestId: paused.requestId },
				])
			: this.#call("chrome.debugger.sendCommand", [
					debuggee,
					"Fetch.failRequest",
					{ requestId: paused.requestId, errorReason: "BlockedByClient" },
				]);
		reply.catch(error => this.#log("could not answer a paused request", { error: errorText(error) }));
	}

	/** A page can navigate itself (redirect, link, script). Catch the landing and send the tab to about:blank. */
	#onMainFrameNavigated(tab: OwnedTab, url: string): void {
		tab.url = url;
		const decision = checkNavigation(this.#policy, url);
		this.#audit(tab.tabId, url, decision);
		if (decision.allowed) return;
		void this.#call("chrome.debugger.sendCommand", [
			{ tabId: tab.tabId },
			"Page.navigate",
			{ url: "about:blank" },
		]).catch(error => this.#log("could not leave a refused page", { error: errorText(error) }));
	}

	#audit(tabId: number, url: string, decision: PolicyDecision): void {
		let origin = "invalid";
		try {
			origin = new URL(url).origin;
		} catch {}
		const entry: NavigationAudit = decision.allowed
			? { tabId, origin, allowed: true }
			: { tabId, origin, allowed: false, reason: decision.reason };
		logger.info(redactSecrets(`extension navigation ${entry.allowed ? "allowed" : "refused"}`, this.#scrub), {
			tabId,
			origin,
		});
		this.#onAudit?.(entry);
	}

	// ----- Tabs and sessions ---------------------------------------------------------------

	async #registerTab(tabId: number): Promise<OwnedTab> {
		await this.#call("chrome.debugger.attach", [{ tabId }, "1.3"]);
		try {
			await this.#enableFetchGate({ tabId });
			await this.#call("chrome.debugger.sendCommand", [{ tabId }, "Target.setAutoAttach", AUTO_ATTACH]);
		} catch (error) {
			// Fail closed: a tab we cannot gate is never exposed.
			this.#fireAndForget("chrome.debugger.detach", [{ tabId }]);
			throw error;
		}
		const tab: OwnedTab = { tabId, targetId: `ext-${tabId}`, url: "about:blank", title: "" };
		this.#tabs.set(tabId, tab);
		for (const client of this.#clients.values()) {
			if (client.discover)
				this.#send(client, {
					method: "Target.targetCreated",
					params: { targetInfo: this.#targetInfo(tab, false) },
				});
			if (client.autoAttach) this.#attachClient(client, tab);
		}
		return tab;
	}

	#targetInfo(tab: OwnedTab, attached: boolean): Record<string, unknown> {
		return {
			targetId: tab.targetId,
			type: "page",
			title: tab.title,
			url: tab.url,
			attached,
			canAccessOpener: false,
		};
	}

	#attachClient(client: CdpClient, tab: OwnedTab): string {
		const sessionId = `ext-s-${this.#nextSessionId++}`;
		client.sessions.set(sessionId, tab.tabId);
		this.#send(client, {
			method: "Target.attachedToTarget",
			params: { sessionId, targetInfo: this.#targetInfo(tab, true), waitingForDebugger: false },
		});
		return sessionId;
	}

	#dropTab(tabId: number): void {
		const tab = this.#tabs.get(tabId);
		if (!tab) return;
		this.#tabs.delete(tabId);
		for (const [child, owner] of this.#childSessions) if (owner === tabId) this.#childSessions.delete(child);
		for (const client of this.#clients.values()) {
			for (const [sessionId, owner] of client.sessions) {
				if (owner !== tabId) continue;
				client.sessions.delete(sessionId);
				this.#send(client, { method: "Target.detachedFromTarget", params: { sessionId, targetId: tab.targetId } });
			}
			this.#send(client, { method: "Target.targetDestroyed", params: { targetId: tab.targetId } });
		}
	}

	#tabByTargetId(targetId: unknown): OwnedTab | undefined {
		if (typeof targetId !== "string") return undefined;
		for (const tab of this.#tabs.values()) if (tab.targetId === targetId) return tab;
		return undefined;
	}

	// ----- CDP ----------------------------------------------------------------------------

	#send(client: CdpClient, message: Record<string, unknown>): void {
		client.ws.send(JSON.stringify(message));
	}

	#reply(client: CdpClient, id: number, sessionId: string | undefined, body: Record<string, unknown>): void {
		this.#send(client, { id, ...body, ...(sessionId === undefined ? {} : { sessionId }) });
	}

	async #handleCdp(
		client: CdpClient,
		id: number,
		method: string,
		params: Record<string, unknown>,
		sessionId: string | undefined,
	): Promise<void> {
		try {
			const result =
				sessionId === undefined
					? await this.#browserCommand(client, method, params)
					: await this.#sessionCommand(sessionId, client, method, params);
			this.#reply(client, id, sessionId, { result });
		} catch (error) {
			const code = error instanceof UnsupportedMethod ? METHOD_NOT_FOUND_CODE : CDP_ERROR_CODE;
			this.#reply(client, id, sessionId, { error: { code, message: redactSecrets(errorText(error), this.#scrub) } });
		}
	}

	async #sessionCommand(
		sessionId: string,
		client: CdpClient,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		const rootTab = client.sessions.get(sessionId);
		const childTab = this.#childSessions.get(sessionId);
		const tabId = rootTab ?? childTab;
		if (tabId === undefined || !this.#tabs.has(tabId)) throw new Error(`Session ${sessionId} is not attached.`);
		// The relay owns auto-attach (it is what keeps new targets paused until they are gated). A client's
		// own call is acknowledged and ignored, so it can neither turn auto-attach off nor widen it.
		if (method === "Target.setAutoAttach") return {};
		const blocked = checkCdpMethod(method);
		if (!blocked.allowed) throw new Error(blocked.reason);
		if (method === "Page.navigate" && typeof params.url === "string") this.#checkNavigationOrThrow(tabId, params.url);
		const debuggee = rootTab !== undefined ? { tabId } : { tabId, sessionId };
		const result = await this.#call("chrome.debugger.sendCommand", [debuggee, method, params]);
		return result ?? {};
	}

	#checkNavigationOrThrow(tabId: number, url: string): void {
		const decision = checkNavigation(this.#policy, url);
		this.#audit(tabId, url, decision);
		if (!decision.allowed) throw new Error(decision.reason);
	}

	async #browserCommand(client: CdpClient, method: string, params: Record<string, unknown>): Promise<unknown> {
		switch (method) {
			case "Browser.getVersion":
				return {
					protocolVersion: "1.3",
					product: "Chrome/extension-relay",
					revision: "0",
					userAgent: "veyyon-extension-relay",
					jsVersion: "0",
				};
			case "Browser.close":
				// Never close the operator's Chrome. The caller is done; drop its socket.
				setImmediate(() => client.ws.close(1000, "closed"));
				return {};
			case "Target.getBrowserContexts":
				return { browserContextIds: [] };
			case "Target.setDiscoverTargets": {
				client.discover = params.discover === true;
				if (client.discover) {
					for (const tab of this.#tabs.values()) {
						this.#send(client, {
							method: "Target.targetCreated",
							params: { targetInfo: this.#targetInfo(tab, false) },
						});
					}
				}
				return {};
			}
			case "Target.setAutoAttach": {
				client.autoAttach = params.autoAttach === true;
				if (client.autoAttach) {
					const attachedTabs = new Set(client.sessions.values());
					for (const tab of this.#tabs.values()) if (!attachedTabs.has(tab.tabId)) this.#attachClient(client, tab);
				}
				return {};
			}
			case "Target.getTargets":
				return { targetInfos: [...this.#tabs.values()].map(tab => this.#targetInfo(tab, false)) };
			case "Target.getTargetInfo": {
				const tab = this.#tabByTargetId(params.targetId);
				if (!tab) throw new Error("No such target.");
				return { targetInfo: this.#targetInfo(tab, false) };
			}
			case "Target.attachToTarget": {
				const tab = this.#tabByTargetId(params.targetId);
				if (!tab) throw new Error("No such target.");
				return { sessionId: this.#attachClient(client, tab) };
			}
			case "Target.detachFromTarget": {
				if (typeof params.sessionId === "string") client.sessions.delete(params.sessionId);
				return {};
			}
			case "Target.createTarget":
				return await this.#createTarget(params);
			case "Target.closeTarget": {
				const tab = this.#tabByTargetId(params.targetId);
				if (!tab) return { success: false };
				await this.#call("chrome.debugger.detach", [{ tabId: tab.tabId }], DETACH_TIMEOUT_MS).catch(
					() => undefined,
				);
				this.#fireAndForget("chrome.tabs.remove", [tab.tabId]);
				this.#dropTab(tab.tabId);
				return { success: true };
			}
			default:
				throw new UnsupportedMethod(`${method} is not supported by the extension relay.`);
		}
	}

	async #createTarget(params: Record<string, unknown>): Promise<unknown> {
		const url = typeof params.url === "string" && params.url.length > 0 ? params.url : "about:blank";
		const decision = checkNavigation(this.#policy, url);
		if (!decision.allowed) {
			this.#audit(0, url, decision);
			throw new Error(decision.reason);
		}
		const created = tabSchema(await this.#call("chrome.tabs.create", [{ url: "about:blank", active: true }]));
		if (created instanceof type.errors) throw new Error("The extension returned no tab.");
		const tab = await this.#registerTab(created.id);
		if (url !== "about:blank") {
			this.#audit(tab.tabId, url, decision);
			await this.#call("chrome.debugger.sendCommand", [{ tabId: tab.tabId }, "Page.navigate", { url }]);
		}
		return { targetId: tab.targetId };
	}
}

class UnsupportedMethod extends Error {}

export interface ConnectUrlOptions {
	extensionId: string;
	protocolVersion: number;
	relayUrl: string;
	/** The extension's own token from its status page. */
	token: string;
	clientName: string;
}

/** The extension page that opens the relay connection. Carries two secrets: never log it. */
export function buildConnectUrl(opts: ConnectUrlOptions): string {
	const client = encodeURIComponent(JSON.stringify({ name: opts.clientName }));
	return (
		`chrome-extension://${opts.extensionId}/connect.html?protocolVersion=${opts.protocolVersion}` +
		`&mcpRelayUrl=${encodeURIComponent(opts.relayUrl)}&token=${encodeURIComponent(opts.token)}&client=${client}`
	);
}
