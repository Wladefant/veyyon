import { describe, expect, it } from "bun:test";
import {
	isMCPEventsEnabled,
	type MCPEventOccurrence,
	type MCPServerEventsConfig,
	validateMCPEventsConfig,
} from "../src/mcp/types";
import { resolveConfigEnvReference } from "../src/config/config-value-resolution";
import { MCPManager } from "../src/mcp/manager";
import { wireReactiveMCPManager } from "../src/session/factory-mcp";
import { buildMcpEventBatchMessage, type McpEventEntry } from "../src/session/factory-notices";


describe("MCP Events per-server config validation", () => {
	it("accepts undefined or null events config with no errors", () => {
		expect(validateMCPEventsConfig("srv", undefined)).toEqual([]);
		expect(validateMCPEventsConfig("srv", null)).toEqual([]);
	});

	it("rejects non-object events config", () => {
		const errors = validateMCPEventsConfig("srv", "invalid");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("must be an object");
	});

	it("rejects non-boolean enabled field", () => {
		const errors = validateMCPEventsConfig("srv", { enabled: "yes" });
		expect(errors.some(e => e.includes("must be a boolean"))).toBe(true);
	});

	it("rejects plaintext secret at top-level events config", () => {
		const errors = validateMCPEventsConfig("srv", { enabled: true, secret: "plaintext" });
		expect(errors.some(e => e.includes("Plaintext secrets are forbidden"))).toBe(true);
	});

	it("rejects non-array subscriptions field", () => {
		const errors = validateMCPEventsConfig("srv", { enabled: true, subscriptions: "none" });
		expect(errors.some(e => e.includes("must be an array"))).toBe(true);
	});

	it("rejects non-object subscription entries", () => {
		const errors = validateMCPEventsConfig("srv", { enabled: true, subscriptions: ["bad"] });
		expect(errors.some(e => e.includes("must be an object"))).toBe(true);
	});

	it("rejects subscription with missing or empty name", () => {
		const errors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [{ name: "", mode: "poll" }],
		});
		expect(errors.some(e => e.includes('requires a non-empty string "name"'))).toBe(true);
	});

	it("rejects subscription with unknown delivery mode", () => {
		const errors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [{ name: "item.created", mode: "invalid" }],
		});
		expect(errors.some(e => e.includes('"mode" must be one of "poll", "push", or "webhook"'))).toBe(true);
	});

	it("rejects subscription with non-object arguments", () => {
		const errors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [{ name: "item.created", mode: "poll", arguments: "filter=1" }],
		});
		expect(errors.some(e => e.includes('"arguments" must be an object'))).toBe(true);
	});

	it("rejects plaintext secret at subscription level", () => {
		const errors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [{ name: "item.created", mode: "poll", secret: "supersecret" }],
		});
		expect(errors.some(e => e.includes("Plaintext secrets are forbidden"))).toBe(true);
	});

	it("requires webhook object when mode is webhook", () => {
		const errors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [{ name: "item.created", mode: "webhook" }],
		});
		expect(errors.some(e => e.includes('mode "webhook" requires a "webhook" configuration object'))).toBe(true);
	});

	it("rejects webhook with plaintext secret", () => {
		const errors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [
				{
					name: "item.created",
					mode: "webhook",
					webhook: {
						callbackUrl: "https://example.com/webhook",
						secretRef: "vault:mcp/srv/secret",
						secret: "raw_secret_value",
					},
				},
			],
		});
		expect(errors.some(e => e.includes('plaintext "secret" field. Plaintext secrets are forbidden'))).toBe(true);
	});

	it("rejects webhook with missing or non-HTTPS callbackUrl", () => {
		const httpErrors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [
				{
					name: "item.created",
					mode: "webhook",
					webhook: { callbackUrl: "http://example.com/webhook", secretRef: "vault:mcp/srv/secret" },
				},
			],
		});
		expect(httpErrors.some(e => e.includes("must use HTTPS scheme"))).toBe(true);

		const missingErrors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [
				{
					name: "item.created",
					mode: "webhook",
					webhook: { callbackUrl: "", secretRef: "vault:mcp/srv/secret" },
				},
			],
		});
		expect(missingErrors.some(e => e.includes('requires a non-empty string "callbackUrl"'))).toBe(true);
	});

	it("rejects webhook secretRef starting with raw whsec_ prefix", () => {
		const errors = validateMCPEventsConfig("srv", {
			enabled: true,
			subscriptions: [
				{
					name: "item.created",
					mode: "webhook",
					webhook: { callbackUrl: "https://example.com/webhook", secretRef: "whsec_ABC123456" },
				},
			],
		});
		expect(errors.some(e => e.includes('looks like a raw Standard Webhooks secret key ("whsec_...")'))).toBe(true);
	});

	it("accepts valid poll, push, and webhook subscriptions", () => {
		const config: MCPServerEventsConfig = {
			enabled: true,
			subscriptions: [
				{ name: "event.poll", mode: "poll", arguments: { filter: "urgent" } },
				{ name: "event.push", mode: "push" },
				{
					name: "event.webhook",
					mode: "webhook",
					webhook: {
						callbackUrl: "https://relay.example.com/events/cb",
						secretRef: "vault:mcp/srv/webhook-secret",
					},
				},
			],
		};
		expect(validateMCPEventsConfig("srv", config)).toEqual([]);
	});
});

describe("isMCPEventsEnabled predicate", () => {
	it("returns false for undefined or null config", () => {
		expect(isMCPEventsEnabled(undefined)).toBe(false);
	});

	it("returns false when enabled is false or omitted", () => {
		expect(isMCPEventsEnabled({ subscriptions: [{ name: "e", mode: "poll" }] })).toBe(false);
		expect(isMCPEventsEnabled({ enabled: false, subscriptions: [{ name: "e", mode: "poll" }] })).toBe(false);
	});

	it("returns false when enabled is true but subscriptions is empty or missing", () => {
		expect(isMCPEventsEnabled({ enabled: true })).toBe(false);
		expect(isMCPEventsEnabled({ enabled: true, subscriptions: [] })).toBe(false);
	});

	it("returns true when enabled is true and subscriptions is non-empty", () => {
		expect(isMCPEventsEnabled({ enabled: true, subscriptions: [{ name: "e", mode: "poll" }] })).toBe(true);
	});
});

describe("buildMcpEventBatchMessage notice formatting", () => {
	it("returns null for empty entries", () => {
		expect(buildMcpEventBatchMessage([])).toBeNull();
	});

	it("formats events strictly as untrusted data with JSON code block", () => {
		const occurrence: MCPEventOccurrence = {
			eventId: "evt-123",
			name: "incident.created",
			timestamp: "2026-10-14T12:00:00Z",
			data: { id: "inc-1", severity: "P1", summary: "Server down" },
		};
		const entries: McpEventEntry[] = [{ serverName: "pagerduty", event: occurrence }];

		const message = buildMcpEventBatchMessage(entries);
		expect(message).not.toBeNull();
		expect(message?.role).toBe("user");
		expect(message?.attribution).toBe("agent");

		const text = (message?.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("[MCP event] 1 external event occurrence(s) received (untrusted data):");
		expect(text).toContain('server="pagerduty" name="incident.created" id="evt-123"');
		expect(text).toContain("```json");
		expect(text).toContain('"severity": "P1"');
		expect(text).toContain('"summary": "Server down"');
		// Must not inject instruction prose
		expect(text).not.toContain("Execute");
		expect(text).not.toContain("Please process");
	});

	it("deduplicates identical serverName and eventId within the batch", () => {
		const occurrence: MCPEventOccurrence = {
			eventId: "evt-dup",
			name: "incident.created",
			timestamp: "2026-10-14T12:00:00Z",
			data: { id: "inc-dup" },
		};
		const entries: McpEventEntry[] = [
			{ serverName: "srv-a", event: occurrence },
			{ serverName: "srv-a", event: occurrence },
			{ serverName: "srv-b", event: occurrence },
		];

		const message = buildMcpEventBatchMessage(entries);
		expect(message).not.toBeNull();
		const text = (message?.content[0] as { type: "text"; text: string }).text;
		// srv-a deduplicated once, srv-b kept because different serverName
		expect(text).toContain("[MCP event] 2 external event occurrence(s) received (untrusted data):");
		expect(text).toContain('server="srv-a"');
		expect(text).toContain('server="srv-b"');
	});
});

describe("wireReactiveMCPManager event routing and disposal", () => {

	it("enqueues incoming event occurrences to creating session yield queue only", () => {
		let registeredHandler: ((serverName: string, event: MCPEventOccurrence) => void) | undefined;
		const fakeManager = {
			setSpawnAdoption: () => {},
			setSpawnGate: () => {},
			setOnToolsChanged: () => {},
			setOnPromptsChanged: () => {},
			setOnResourcesChanged: () => {},
			setOnEvent: (handler: (serverName: string, event: MCPEventOccurrence) => void) => {
				registeredHandler = handler;
			},
		};

		const enqueued: Array<{ type: string; item: unknown }> = [];
		const fakeSession = {
			isDisposed: false,
			sessionManager: { getSessionId: () => "sess-1" },
			yieldQueue: {
				enqueue: (type: string, item: unknown) => {
					enqueued.push({ type, item });
				},
			},
		};
		const fakeSettings = { get: () => undefined };

		wireReactiveMCPManager({
			manager: fakeManager as any,
			session: fakeSession as any,
			settings: fakeSettings as any,
			refreshTools: async () => {},
		});

		expect(registeredHandler).toBeDefined();

		const occurrence: MCPEventOccurrence = {
			eventId: "evt-1",
			name: "ticket.updated",
			timestamp: "2026-10-14T12:00:00Z",
			data: { ticketId: 42 },
		};
		registeredHandler!("github-mcp", occurrence);

		expect(enqueued.length).toBe(1);
		expect(enqueued[0].type).toBe("mcp-event");
		expect(enqueued[0].item).toEqual({ serverName: "github-mcp", event: occurrence });
	});

	it("stops enqueuing and detaches handler when session is disposed", () => {
		let registeredHandler: ((serverName: string, event: MCPEventOccurrence) => void) | undefined;
		let clearCalled = false;
		const fakeManager = {
			setSpawnAdoption: () => {},
			setSpawnGate: () => {},
			setOnToolsChanged: () => {},
			setOnPromptsChanged: () => {},
			setOnResourcesChanged: () => {},
			setOnEvent: (handler: ((serverName: string, event: MCPEventOccurrence) => void) | undefined) => {
				registeredHandler = handler;
			},
			clearOnEvent: () => {
				clearCalled = true;
				registeredHandler = undefined;
			},
		};

		const enqueued: Array<{ type: string; item: unknown }> = [];
		const fakeSession = {
			isDisposed: true, // Disposed session
			sessionManager: { getSessionId: () => "sess-2" },
			yieldQueue: {
				enqueue: (type: string, item: unknown) => {
					enqueued.push({ type, item });
				},
			},
		};
		const fakeSettings = { get: () => undefined };

		wireReactiveMCPManager({
			manager: fakeManager as any,
			session: fakeSession as any,
			settings: fakeSettings as any,
			refreshTools: async () => {},
		});

		const occurrence: MCPEventOccurrence = {
			eventId: "evt-after-dispose",
			name: "ticket.updated",
			timestamp: "2026-10-14T12:00:00Z",
			data: { ticketId: 99 },
		};
		registeredHandler!("github-mcp", occurrence);

		// Event must not be enqueued to disposed session
		expect(enqueued.length).toBe(0);
		// clearOnEvent must have been called
		expect(clearCalled).toBe(true);
	});
});
describe("MCP Events config and durable session routing", () => {
	it("builds the persisted MCP event receipt through the production notice path", () => {
		const occurrence: MCPEventOccurrence = {
			eventId: "evt-receipt",
			name: "incident.created",
			timestamp: "2026-10-14T12:00:00Z",
			data: { id: "inc-receipt" },
		};
		const message = buildMcpEventBatchMessage([{
			serverName: "alerts",
			subscriptionKey: "alerts:incident.created",
			event: occurrence,
		}]);
		expect(message?.role).toBe("custom");
		if (message?.role !== "custom") throw new Error("Expected the MCP event custom message");
		expect(message.customType).toBe("mcp-event");
		expect(message.details.receipts).toEqual([{
			serverName: "alerts",
			subscriptionKey: "alerts:incident.created",
			id: "evt-receipt",
		}]);
	});
	it("accepts listenPort and resolves an explicit $ENV secret reference", () => {
		const previous = process.env.MCP_EVENTS_TEST_SECRET;
		try {
			process.env.MCP_EVENTS_TEST_SECRET = "test-signing-secret";
			const config: MCPServerEventsConfig = {
				enabled: true,
				subscriptions: [{
					name: "incident.created",
					mode: "webhook",
					webhook: {
						callbackUrl: "https://relay.example.test/events",
						listenPort: 4187,
						secretRef: "$MCP_EVENTS_TEST_SECRET",
					},
				}],
			};
			expect(validateMCPEventsConfig("alerts", config)).toEqual([]);
			expect(config.subscriptions?.[0]?.webhook?.listenPort).toBe(4187);
			expect(resolveConfigEnvReference(config.subscriptions![0]!.webhook!.secretRef)).toEqual({
				ok: true,
				value: "test-signing-secret",
			});
		} finally {
			if (previous === undefined) delete process.env.MCP_EVENTS_TEST_SECRET;
			else process.env.MCP_EVENTS_TEST_SECRET = previous;
		}
	});

	it("reports an unset explicit $ENV secret instead of treating the reference as a default", () => {
		try {
			delete process.env.MCP_EVENTS_MISSING_SECRET;
			const config: MCPServerEventsConfig = {
				enabled: true,
				subscriptions: [{
					name: "incident.created",
					mode: "webhook",
					webhook: {
						callbackUrl: "https://relay.example.test/events",
						listenPort: 4188,
						secretRef: "$MCP_EVENTS_MISSING_SECRET",
					},
				}],
			};
			expect(validateMCPEventsConfig("alerts", config)).toEqual([]);
			expect(resolveConfigEnvReference(config.subscriptions![0]!.webhook!.secretRef)).toEqual({
				ok: false,
				variable: "MCP_EVENTS_MISSING_SECRET",
				explicit: true,
				empty: false,
			});
		} finally {
			if (previous !== undefined) process.env.MCP_EVENTS_MISSING_SECRET = previous;
		}
	});

	it("waits for async disk persistence before returning a queued receipt", async () => {
		const sequence: string[] = [];
		let onEvent: ((serverName: string, event: MCPEventOccurrence, subscriptionKey: string) => Promise<"queued" | "duplicate">) | undefined;
		const manager = {
			setSpawnAdoption() {},
			setSpawnGate() {},
			setOnToolsChanged() {},
			setOnPromptsChanged() {},
			setOnResourcesChanged() {},
			setOnEvent(handler: typeof onEvent) { onEvent = handler; },
		};
		const session = {
			isDisposed: false,
			sessionManager: {
				getSessionId: () => "session-A",
				getSessionFile: async () => { sequence.push("getSessionFile"); return "/tmp/session-A.jsonl"; },
				getEntries: () => [],
				async ensureOnDisk() { sequence.push("ensureOnDisk"); },
				async flush() { sequence.push("flush"); },
				appendCustomEntry(type: string, data: unknown) {
					sequence.push(`append:${type}`);
					persisted.push({ type: "custom", customType: type, data });
				},
			},
			yieldQueue: {
				enqueue(type: string) { sequence.push(`enqueue:${type}`); },
			},
		};
		const persisted: Array<{ type: string; customType: string; data: unknown }> = [];
		wireReactiveMCPManager({
			manager: manager as unknown as MCPManager,
			session: session as unknown as Parameters<typeof wireReactiveMCPManager>[0]["session"],
			settings: { get: () => undefined } as Parameters<typeof wireReactiveMCPManager>[0]["settings"],
			refreshTools: async () => {},
		});
		const occurrence: MCPEventOccurrence = {
			eventId: "evt-durable",
			name: "incident.created",
			timestamp: "2026-10-14T12:00:00Z",
			data: { id: "inc-1" },
		};
		expect(onEvent).toBeDefined();
		const receipt = await onEvent!("alerts", occurrence, "alerts:incident.created");
		expect(receipt).toBe("queued");
		expect(sequence).toEqual([
			"append:mcp-events-state",
			"getSessionFile",
			"ensureOnDisk",
			"flush",
			"enqueue:mcp-event",
		]);
		expect(persisted).toHaveLength(1);
	});

	it("returns a retryable failure and does not enqueue or mark delivery when flush rejects", async () => {
		const sequence: string[] = [];
		let onEvent: ((serverName: string, event: MCPEventOccurrence, subscriptionKey: string) => Promise<"queued" | "duplicate">) | undefined;
		const manager = {
			setSpawnAdoption() {},
			setSpawnGate() {},
			setOnToolsChanged() {},
			setOnPromptsChanged() {},
			setOnResourcesChanged() {},
			setOnEvent(handler: typeof onEvent) { onEvent = handler; },
		};
		const session = {
			isDisposed: false,
			sessionManager: {
				getSessionId: () => "session-A",
				getSessionFile: async () => "/tmp/session-A.jsonl",
				getEntries: () => [],
				async ensureOnDisk() { sequence.push("ensureOnDisk"); },
				async flush() { sequence.push("flush"); throw new Error("disk unavailable"); },
				appendCustomEntry() { sequence.push("append"); },
			},
			yieldQueue: { enqueue() { sequence.push("enqueue"); } },
		};
		wireReactiveMCPManager({
			manager: manager as unknown as MCPManager,
			session: session as unknown as Parameters<typeof wireReactiveMCPManager>[0]["session"],
			settings: { get: () => undefined } as Parameters<typeof wireReactiveMCPManager>[0]["settings"],
			refreshTools: async () => {},
		});
		const occurrence: MCPEventOccurrence = {
			eventId: "evt-retry",
			name: "incident.created",
			timestamp: "2026-10-14T12:00:00Z",
			data: { id: "inc-retry" },
		};
		await expect(onEvent!("alerts", occurrence, "alerts:incident.created")).rejects.toThrow("disk unavailable");
		expect(sequence).toEqual(["append", "ensureOnDisk", "flush"]);
	});

	it("replays a durably enqueued event after restart until its custom-message receipt persists", () => {
		const eventEntry = {
			type: "custom",
			customType: "mcp-events-state",
			data: {
				serverName: "alerts",
				subscriptionKey: "alerts:incident.created",
				eventId: "evt-replay",
				event: {
					eventId: "evt-replay",
					name: "incident.created",
					timestamp: "2026-10-14T12:00:00Z",
					data: { id: "inc-replay" },
				},
			},
		};
		const replayed: unknown[][] = [];
		const replayManager = () => ({
			setSpawnAdoption() {},
			setSpawnGate() {},
			setOnToolsChanged() {},
			setOnPromptsChanged() {},
			setOnResourcesChanged() {},
			setOnEvent() {},
		});
		const wireReplay = (entries: unknown[]) => {
			const enqueued: unknown[][] = [];
			wireReactiveMCPManager({
			manager: replayManager() as unknown as MCPManager,
			session: {
				isDisposed: false,
				sessionManager: {
					getSessionId: () => "session-A",
					getSessionFile: async () => "/tmp/session-A.jsonl",
					getEntries: () => entries,
					async ensureOnDisk() {},
					async flush() {},
				},
				yieldQueue: { enqueue: (...args: unknown[]) => enqueued.push(args) },
			} as unknown as Parameters<typeof wireReactiveMCPManager>[0]["session"],
			settings: { get: () => undefined } as Parameters<typeof wireReactiveMCPManager>[0]["settings"],
				refreshTools: async () => {},
			});
			return enqueued;
		};
		replayed.push(...wireReplay([eventEntry]));
		expect(replayed).toHaveLength(1);
		expect(replayed[0]?.[0]).toBe("mcp-event");
		const receiptMessage = buildMcpEventBatchMessage([{
			serverName: "alerts",
			subscriptionKey: "alerts:incident.created",
			event: eventEntry.data.event,
		}]);
		if (receiptMessage?.role !== "custom") throw new Error("Expected production MCP event receipt");
		expect(wireReplay([eventEntry, receiptMessage])).toEqual([]);
	});
});
