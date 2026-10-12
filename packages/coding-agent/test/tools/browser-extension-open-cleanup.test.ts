import { expect, test } from "bun:test";
import type { BrowserHandle } from "@veyyon/coding-agent/tools/web/browser/registry";
import { acquireTab, getTab } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";

// The worker is real. Only its external browser endpoint stalls, as in the startup deadline suite.
test("failed extension open closes only its newly created target", async () => {
	const server = Bun.serve({ port: 0, fetch: () => Promise.withResolvers<Response>().promise });
	const closed: string[] = [];
	const ownedTarget = { _targetId: "owned-new", page: async () => ownedPage };
	const ownedPage = {
		target: () => ownedTarget,
		close: async () => {
			closed.push("owned-new");
		},
	};
	const userTarget = {
		_targetId: "user-existing",
		page: async () => ({
			close: async () => {
				closed.push("user-existing");
			},
		}),
	};
	const browser = {
		key: "extension:test-cleanup",
		kind: { kind: "extension" },
		refCount: 0,
		browser: {
			wsEndpoint: () => `ws://127.0.0.1:${server.port}/stalled`,
			newPage: async () => ownedPage,
			targets: () => [userTarget, ownedTarget],
			connected: true,
			disconnect: () => {
				closed.push("connection-disconnected");
			},
		},
		stealth: { browserSession: null, override: null },
	} as unknown as BrowserHandle;
	const name = `extension-failed-${process.pid}`;
	try {
		await expect(
			acquireTab(name, browser, {
				url: "https://example.com/",
				timeoutMs: 5000,
				deadlineStartMs: performance.now() - 60000,
			}),
		).rejects.toThrow();
		expect(closed).toEqual(["owned-new", "connection-disconnected"]);
		expect(getTab(name)).toBeUndefined();
	} finally {
		await server.stop(true);
	}
}, 30000);
