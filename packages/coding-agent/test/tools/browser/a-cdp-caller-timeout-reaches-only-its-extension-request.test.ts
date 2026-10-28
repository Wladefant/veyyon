/**
 * WHY: Puppeteer consumes send options before serializing CDP. A relay-only test could pass while
 * real callers still lose their deadlines. Drive real Connection and CDPSession instances with a
 * fake transport. This proves the caller seam, not Chrome latency or host CPU behavior.
 */
import { expect, test } from "bun:test";
import { Connection, type ConnectionTransport, connect } from "puppeteer-core";
import {
	bindExtensionTimeouts,
	ExtensionTimeoutTransport,
	isExtensionRelayEndpoint,
} from "../../../src/tools/web/browser/extension-timeout-transport";

interface Request {
	id: number;
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
	relayTimeoutMs?: number;
}

class FakeTransport implements ConnectionTransport {
	onmessage?: (message: string) => void;
	onclose?: () => void;
	readonly requests: Request[] = [];

	send(message: string): void {
		const request: Request = JSON.parse(message);
		this.requests.push(request);
		const result = request.method === "Target.getBrowserContexts" ? { browserContextIds: [] } : {};
		queueMicrotask(() => this.onmessage?.(JSON.stringify({ id: request.id, sessionId: request.sessionId, result })));
	}

	close(): void {
		this.onclose?.();
	}
}

test("a real CDP session carries each caller timeout outside Chrome params", async () => {
	const wire = new FakeTransport();
	const transport = new ExtensionTimeoutTransport(wire);
	const connection = new Connection("ws://127.0.0.1/cdp/fake-secret", transport);
	transport.bind(connection);
	try {
		wire.onmessage?.(
			JSON.stringify({
				method: "Target.attachedToTarget",
				params: { sessionId: "root", targetInfo: { type: "page" } },
			}),
		);
		const session = connection.session("root");
		if (!session) throw new Error("The fake page session did not attach.");
		await Promise.all([
			session.send(
				"Runtime.callFunctionOn",
				{ functionDeclaration: "() => 1", awaitPromise: true },
				{ timeout: 40_000 },
			),
			session.send("Network.enable"),
			session.send("Runtime.evaluate", { expression: "1" }, { timeout: 5_000 }),
		]);
		expect(wire.requests).toMatchObject([
			{
				method: "Runtime.callFunctionOn",
				sessionId: "root",
				relayTimeoutMs: 40_000,
				params: { functionDeclaration: "() => 1", awaitPromise: true },
			},
			{ method: "Network.enable", sessionId: "root" },
			{ method: "Runtime.evaluate", sessionId: "root", relayTimeoutMs: 5_000 },
		]);
		expect(wire.requests[1]).not.toHaveProperty("relayTimeoutMs");
		expect(wire.requests[0]?.params).not.toHaveProperty("relayTimeoutMs");
		await connection.send("Browser.getVersion");
		expect(wire.requests[3]).not.toHaveProperty("relayTimeoutMs");
	} finally {
		connection.dispose();
	}
});

test("the connected browser binds deadlines without creating a target or CDP session", async () => {
	const wire = new FakeTransport();
	const transport = new ExtensionTimeoutTransport(wire);
	const browser = await connect({ transport, defaultViewport: null });
	try {
		const before = wire.requests.length;
		bindExtensionTimeouts(browser, transport);
		expect(wire.requests.length).toBe(before);
		if (!("_connection" in browser)) throw new Error("Puppeteer did not create a CDP connection.");
		await (browser._connection as unknown as Connection).send("Browser.getVersion", undefined, { timeout: 40_000 });
		expect(wire.requests.at(-1)).toMatchObject({ method: "Browser.getVersion", relayTimeoutMs: 40_000 });
	} finally {
		await browser.disconnect();
	}
});

test("only the extension relay endpoint selects the timeout transport", () => {
	expect(isExtensionRelayEndpoint("ws://127.0.0.1:1234/cdp/secret")).toBe(true);
	expect(isExtensionRelayEndpoint("ws://127.0.0.1:1234/devtools/browser/id")).toBe(false);
	expect(isExtensionRelayEndpoint("ws://example.com/cdp/secret")).toBe(false);
});
