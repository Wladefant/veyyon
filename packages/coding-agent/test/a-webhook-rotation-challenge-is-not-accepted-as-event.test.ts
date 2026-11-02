import { expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createWebhookReceiver, webhookRegistrationKey, type MCPWebhookMessage } from "../src/mcp/events-webhook";

const CALLBACK_PATH = "/hooks/refresh";
const REMOTE_ID = "same-remote-id";
const OLD_SECRET_BYTES = Buffer.alloc(32, 21);
const NEXT_SECRET_BYTES = Buffer.alloc(32, 37);
const asSecret = (bytes: Buffer): string => `whsec_${bytes.toString("base64")}`;

function signedRequest(secret: Buffer, messageId: string, message: Record<string, unknown>, path = CALLBACK_PATH): Request {
	const timestamp = String(Math.floor(Date.now() / 1_000));
	const body = Buffer.from(JSON.stringify(message));
	const signed = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`), body]);
	const signature = createHmac("sha256", secret).update(signed).digest("base64");
	return new Request(`https://receiver.test${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-MCP-Subscription-Id": REMOTE_ID,
			"webhook-id": messageId,
			"webhook-timestamp": timestamp,
			"webhook-signature": `v1,${signature}`,
		},
		body,
	});
}

function occurrence(messageId: string): Record<string, unknown> {
	return {
		eventId: messageId,
		name: "orders/changed",
		timestamp: new Date().toISOString(),
		data: { source: "synthetic" },
	};
}

it("renews a webhook with a rotated challenge secret without granting early event delivery", async () => {
	const registrationKey = webhookRegistrationKey(CALLBACK_PATH, REMOTE_ID);
	const registrations = new Map([[registrationKey, {
		secret: asSecret(OLD_SECRET_BYTES),
		name: "orders/changed",
		callbackPath: CALLBACK_PATH,
	}]]);
	// Simulate a renewal with the same remote subscription id and callback path.
	// Until events/subscribe succeeds, the old registration still owns events.
	const verificationRoutes = new Map([[CALLBACK_PATH, { secret: asSecret(NEXT_SECRET_BYTES) }]]);
	const accepted: Array<{ key: string; event: MCPWebhookMessage }> = [];
	const receiver = createWebhookReceiver({
		registrations,
		verificationRoutes,
		registrationKey: webhookRegistrationKey,
		accept: async (key, event) => {
			accepted.push({ key, event });
			return "queued";
		},
	});

	const rotatedChallenge = await receiver.handle(signedRequest(NEXT_SECRET_BYTES, "verify-new", {
		type: "verification",
		challenge: "new-key-proven",
	}));
	expect(rotatedChallenge.status).toBe(200);
	expect(await rotatedChallenge.json()).toEqual({ challenge: "new-key-proven" });
	expect(accepted).toHaveLength(0);
	// An old key may deliver existing events but must not verify its replacement.
	expect((await receiver.handle(signedRequest(OLD_SECRET_BYTES, "stale-proof", {
		type: "verification",
		challenge: "old-key-must-not-verify",
	}))).status).toBe(401);

	// The retiring key must still authorize its existing occurrence route.
	expect((await receiver.handle(signedRequest(OLD_SECRET_BYTES, "old-event", occurrence("old-event")))).status).toBe(202);
	expect(accepted).toHaveLength(1);
	expect(accepted[0]?.key).toBe(registrationKey);

	// The uncommitted new key must not authorize regular event delivery.
	expect((await receiver.handle(signedRequest(NEXT_SECRET_BYTES, "early-event", occurrence("early-event")))).status).toBe(401);
	expect(accepted).toHaveLength(1);
	// Even a correctly signed challenge for another unregistered callback path is refused.
	expect((await receiver.handle(signedRequest(NEXT_SECRET_BYTES, "wrong-path", {
		type: "verification",
		challenge: "wrong-route",
	}, "/hooks/other"))).status).toBe(503);

	// After a successful renewal, events switch to the newly registered key.
	registrations.set(registrationKey, {
		secret: asSecret(NEXT_SECRET_BYTES),
		name: "orders/changed",
		callbackPath: CALLBACK_PATH,
	});
	verificationRoutes.delete(CALLBACK_PATH);
	expect((await receiver.handle(signedRequest(NEXT_SECRET_BYTES, "new-event", occurrence("new-event")))).status).toBe(202);
	expect((await receiver.handle(signedRequest(OLD_SECRET_BYTES, "stale-event", occurrence("stale-event")))).status).toBe(401);
	expect(accepted.map(item => (item.event as { eventId?: string }).eventId)).toEqual(["old-event", "new-event"]);
});

it("accepts first-time challenge authorization without early occurrence delivery", async () => {
	const verificationRoutes = new Map([[CALLBACK_PATH, { secret: asSecret(NEXT_SECRET_BYTES) }]]);
	const accepted: MCPWebhookMessage[] = [];
	const receiver = createWebhookReceiver({
		registrations: new Map(),
		verificationRoutes,
		registrationKey: webhookRegistrationKey,
		accept: async (_key, event) => {
			accepted.push(event);
			return "queued";
		},
	});

	const challenge = await receiver.handle(signedRequest(NEXT_SECRET_BYTES, "initial-verify", {
		type: "verification",
		challenge: "first-time-verified",
	}));
	expect(challenge.status).toBe(200);
	expect(await challenge.json()).toEqual({ challenge: "first-time-verified" });
	// No active registration exists until the remote subscribe succeeds.
	expect((await receiver.handle(signedRequest(NEXT_SECRET_BYTES, "premature-event", occurrence("premature-event")))).status).toBe(503);
	expect((await receiver.handle(signedRequest(OLD_SECRET_BYTES, "wrong-key", {
		type: "verification",
		challenge: "incorrect",
	}))).status).toBe(401);
	expect(accepted).toHaveLength(0);
});
