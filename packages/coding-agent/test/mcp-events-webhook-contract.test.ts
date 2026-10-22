import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { createWebhookReceiver, MCP_WEBHOOK_MAX_BODY_BYTES } from "../src/mcp/events-webhook";
import type { MCPWebhookMessage } from "../src/mcp/events-webhook";

const now = 1_800_000_000_000;
const secret = `whsec_${Buffer.from("contract secret with enough entropy").toString("base64")}`;
const subscriptionId = "subscription-a";
const callbackPath = "/callback/unique-route";
const event = { eventId: "event-a", name: "change.created", timestamp: "2026-10-14T00:00:00Z", data: { text: "untrusted" } };

function signedRequest(body: Uint8Array | string, overrides: Record<string, string> = {}, path = callbackPath): Request {
	const bytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
	const id = overrides["webhook-id"] ?? event.eventId;
	const timestamp = overrides["webhook-timestamp"] ?? String(now / 1000);
	const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
		.update(Buffer.concat([Buffer.from(id), Buffer.from("."), Buffer.from(timestamp), Buffer.from("."), bytes]))
		.digest("base64");
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: {
			"X-MCP-Subscription-Id": subscriptionId,
			"content-type": "application/json",
			"webhook-id": id,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,${signature}`,
			...overrides,
		},
		body: bytes,
	});
}

function receiver(accept: (id: string, received: MCPWebhookMessage) => Promise<"queued" | "duplicate">) {
	return createWebhookReceiver({
		registrations: new Map([[subscriptionId, { secret, name: event.name, callbackPath }]]),
		verificationRoutes: new Map([[callbackPath, { secret }]]),
		accept,
		now: () => now,
	});
}

describe("MCP webhook receiver contract", () => {
	it("authenticates raw bytes and awaits durable acceptance", async () => {
		const queued: unknown[] = [];
		let release!: () => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const target = receiver(async (id, received) => { expect(id).toBe(subscriptionId); queued.push(received); markStarted(); await waiting; return "queued"; });
		let settled = false;
		const pending = target.handle(signedRequest(JSON.stringify(event))).then((response) => { settled = true; return response; });
		await started;
		expect(settled).toBe(false);
		release();
		expect((await pending).status).toBe(202);
		expect(queued).toEqual([event]);
	});

	it("rejects modified bytes, missing headers and non-JSON content", async () => {
		const target = receiver(async () => "queued");
		const request = signedRequest(JSON.stringify(event));
		expect((await target.handle(new Request(request, { body: "{}" }))).status).toBe(401);
		const missing = new Request("http://localhost/events", { method: "POST", headers: { "X-MCP-Subscription-Id": subscriptionId }, body: "{}" });
		expect((await target.handle(missing)).status).toBe(400);
		expect((await target.handle(signedRequest(JSON.stringify(event), { "content-type": "text/plain" }))).status).toBe(415);
	});

	it("echoes only an authenticated verification challenge on its pending route", async () => {
		let accepted = 0;
		const target = receiver(async () => { accepted++; return "queued"; });
		const verification = JSON.stringify({ type: "verification", challenge: "nonce-a" });
		const response = await target.handle(signedRequest(verification, { "X-MCP-Subscription-Id": "not-yet-registered", "webhook-id": "msg_verification_nonce" }));
		const registeredChallenge = JSON.stringify({ type: "verification", challenge: "restart-nonce" });
		const registeredResponse = await target.handle(signedRequest(registeredChallenge, { "webhook-id": "msg_verification_restart" }));
		expect(registeredResponse.status).toBe(200);
		expect(await registeredResponse.json()).toEqual({ challenge: "restart-nonce" });
		expect((await target.handle(signedRequest(verification, { "X-MCP-Subscription-Id": "" }))).status).toBe(400);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ challenge: "nonce-a" });
		expect((await target.handle(signedRequest(JSON.stringify(event), { "X-MCP-Subscription-Id": "not-yet-registered" }))).status).toBe(503);
		expect(accepted).toBe(0);
	});

	it("rejects stale, future, oversized and unregistered deliveries", async () => {
		const target = receiver(async () => "queued");
		expect((await target.handle(signedRequest(JSON.stringify(event), { "webhook-timestamp": String(now / 1000 - 301) }))).status).toBe(400);
		expect((await target.handle(signedRequest(JSON.stringify(event), { "webhook-timestamp": String(now / 1000 + 301) }))).status).toBe(400);
		expect((await target.handle(signedRequest(new Uint8Array(MCP_WEBHOOK_MAX_BODY_BYTES + 1)))).status).toBe(413);
		expect((await target.handle(signedRequest(JSON.stringify(event), { "X-MCP-Subscription-Id": "unknown" }, "/unknown"))).status).toBe(503);
	});

	it("validates event name and occurrence fields before acceptance", async () => {
		let accepted = false;
		const target = receiver(async () => { accepted = true; return "queued"; });
		expect((await target.handle(signedRequest(JSON.stringify({ ...event, name: "other.event" })))).status).toBe(400);
		expect((await target.handle(signedRequest(JSON.stringify({ ...event, eventId: "different-id" })))).status).toBe(400);
		expect((await target.handle(signedRequest(JSON.stringify({ ...event, type: "unrecognized" })))).status).toBe(400);
		expect((await target.handle(signedRequest(JSON.stringify({ ...event, cursor: [] })))).status).toBe(400);
		expect((await target.handle(signedRequest(JSON.stringify({ ...event, timestamp: "2025" })))).status).toBe(400);
		expect(accepted).toBe(false);
	});

	it("accepts any JSON data shape declared by the server schema", async () => {
		const received: MCPWebhookMessage[] = [];
		const target = receiver(async (_id, message) => { received.push(message); return "queued"; });
		const scalarData = { ...event, data: null };
		expect((await target.handle(signedRequest(JSON.stringify(scalarData)))).status).toBe(202);
		expect((await target.handle(signedRequest(JSON.stringify({ ...event, data: ["value"] })))).status).toBe(202);
		expect((await target.handle(signedRequest(JSON.stringify({ eventId: event.eventId, name: event.name, timestamp: event.timestamp })))).status).toBe(400);
		expect(received).toHaveLength(2);
	});

	it("accepts signed gap and termination controls through the durable callback", async () => {
		const accepted: MCPWebhookMessage[] = [];
		const target = receiver(async (_id, message) => { accepted.push(message); return "queued"; });
		const gap = { type: "gap", cursor: "opaque-cursor" };
		const terminated = { type: "terminated", error: { code: -32024, message: "Forbidden", data: { reason: "revoked" } } };
		expect((await target.handle(signedRequest(JSON.stringify(gap), { "webhook-id": "msg_gap_a" }))).status).toBe(202);
		expect((await target.handle(signedRequest(JSON.stringify(terminated), { "webhook-id": "msg_terminated_a" }))).status).toBe(202);
		expect(accepted).toEqual([{ ...gap, messageId: "msg_gap_a" }, { ...terminated, messageId: "msg_terminated_a" }]);
	});

	it("acknowledges duplicates without queueing twice", async () => {
		let count = 0;
		const target = receiver(async () => { count++; return "duplicate"; });
		expect((await target.handle(signedRequest(JSON.stringify(event)))).status).toBe(204);
		expect(count).toBe(1);
	});

	it("does not acknowledge when durable acceptance fails", async () => {
		const target = receiver(async () => { throw new Error("queue unavailable"); });
		expect((await target.handle(signedRequest(JSON.stringify(event)))).status).toBe(503);
	});
});
