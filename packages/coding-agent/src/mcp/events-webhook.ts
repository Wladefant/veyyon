import { createHmac, timingSafeEqual } from "node:crypto";

export const MCP_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const MCP_WEBHOOK_MAX_AGE_SECONDS = 300;

export interface MCPWebhookRegistration {
	secret: string;
	name: string;
	callbackPath: string;
}

export interface MCPWebhookReceiverOptions {
	registrations: ReadonlyMap<string, MCPWebhookRegistration>;
	verificationRoutes: ReadonlyMap<string, { secret: string }>;
	accept: (subscriptionId: string, event: MCPWebhookMessage) => Promise<"queued" | "duplicate">;
	now?: () => number;
}

export interface MCPEventWebhookOccurrence {
	eventId: string;
	name: string;
	timestamp: string;
	data: unknown;
	[key: string]: unknown;
}

export type MCPWebhookControl =
	| { type: "gap"; messageId: string; cursor?: string | null }
	| { type: "terminated"; messageId: string; error: { code: number; message: string; data?: Record<string, unknown> } };

export type MCPWebhookMessage = MCPEventWebhookOccurrence | MCPWebhookControl;

export interface MCPWebhookReceiver {
	handle(request: Request): Promise<Response>;
}

/** Build a verifier for registered subscriptions; the caller owns secret resolution and lifecycle. */
export function createWebhookReceiver(options: MCPWebhookReceiverOptions): MCPWebhookReceiver {
	const now = options.now ?? Date.now;
	return {
		async handle(request: Request): Promise<Response> {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const path = new URL(request.url).pathname;
			const subscriptionId = request.headers.get("X-MCP-Subscription-Id");
			if (!subscriptionId) return new Response(null, { status: 400 });
			const registration = options.registrations.get(subscriptionId);
			const verification = options.verificationRoutes.get(path);
			const pendingVerification = verification !== undefined && registration === undefined;
			if (registration && registration.callbackPath !== path) return new Response(null, { status: 503 });
			if (!registration && !pendingVerification) return new Response(null, { status: 503 });
			const messageId = request.headers.get("webhook-id");
			const timestamp = request.headers.get("webhook-timestamp");
			const signatures = request.headers.get("webhook-signature");
			if (!messageId || !timestamp || !signatures || messageId.includes(".")) return new Response(null, { status: 400 });
			if (!/^\d+$/.test(timestamp)) return new Response(null, { status: 400 });
			const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
			if (mediaType !== "application/json") return new Response(null, { status: 415 });
			const seconds = Number(timestamp);
			if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now() / 1000) - seconds) > MCP_WEBHOOK_MAX_AGE_SECONDS) {
				return new Response(null, { status: 400 });
			}
			const reader = request.body?.getReader();
			if (!reader) return new Response(null, { status: 400 });
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > MCP_WEBHOOK_MAX_BODY_BYTES) {
						await reader.cancel();
						return new Response(null, { status: 413 });
					}
					chunks.push(part.value);
				}
			} finally {
				reader.releaseLock();
			}
			const body = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.byteLength;
			}
			const secretValue = registration?.secret ?? verification?.secret;
			const secret = secretValue ? decodeSecret(secretValue) : undefined;
			if (!secret || secret.length < 24 || secret.length > 64) return new Response(null, { status: 401 });
			const signed = Buffer.concat([Buffer.from(messageId), Buffer.from("."), Buffer.from(timestamp), Buffer.from("."), Buffer.from(body)]);
			const expected = createHmac("sha256", secret).update(signed).digest();
			const valid = signatures.split(/\s+/).some((entry) => {
				const match = /^v1,([A-Za-z0-9+/]+={0,2})$/.exec(entry);
				if (!match) return false;
				const supplied = Buffer.from(match[1], "base64");
				return supplied.length === expected.length && timingSafeEqual(supplied, expected);
			});
			if (!valid) return new Response(null, { status: 401 });
			let event: unknown;
			try {
				event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
			} catch {
				return new Response(null, { status: 400 });
			}
			if (isVerificationChallenge(event)) {
				return new Response(JSON.stringify({ challenge: event.challenge }), { status: 200, headers: { "content-type": "application/json" } });
			}
			if (pendingVerification) return new Response(null, { status: 503 });
			if (!registration) return new Response(null, { status: 503 });
			let message: MCPWebhookMessage | undefined;
			if (isWebhookControl(event)) {
				message = { ...event, messageId };
			} else if (isOccurrence(event) && event.name === registration.name && event.eventId === messageId) {
				message = event;
			}
			if (!message) return new Response(null, { status: 400 });
			try {
				const outcome = await options.accept(subscriptionId, message);
				return new Response(null, { status: outcome === "duplicate" ? 204 : 202 });
			} catch {
				return new Response(null, { status: 503 });
			}
		},
	};
}

function isOccurrence(value: unknown): value is MCPEventWebhookOccurrence {
	return value !== null && typeof value === "object"
		&& !("type" in value)
		&& "eventId" in value && typeof value.eventId === "string" && value.eventId.length > 0
		&& "name" in value && typeof value.name === "string" && value.name.length > 0
		&& "timestamp" in value && typeof value.timestamp === "string" && /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value.timestamp) && Number.isFinite(Date.parse(value.timestamp))
		&& "data" in value
		&& (!("cursor" in value) || value.cursor === null || typeof value.cursor === "string");
}

function decodeSecret(value: string): Buffer | undefined {
	if (!value.startsWith("whsec_")) return undefined;
	const encoded = value.slice("whsec_".length);
	if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return undefined;
	const decoded = Buffer.from(encoded, "base64");
	if (decoded.toString("base64") !== encoded) return undefined;
	return decoded;
}

function isWebhookControl(value: unknown): value is MCPWebhookControl {
	if (value === null || typeof value !== "object" || !("type" in value)) return false;
	if (value.type === "gap") {
		return !("cursor" in value) || value.cursor === null || typeof value.cursor === "string";
	}
	if (value.type !== "terminated" || !("error" in value) || value.error === null || typeof value.error !== "object") return false;
	if (!("code" in value.error) || typeof value.error.code !== "number" || !Number.isInteger(value.error.code)) return false;
	if (!("message" in value.error) || typeof value.error.message !== "string") return false;
	return !("data" in value.error) || value.error.data !== null && typeof value.error.data === "object" && !Array.isArray(value.error.data);
}
function isVerificationChallenge(value: unknown): value is { type: "verification"; challenge: string } {
	return value !== null && typeof value === "object"
		&& "type" in value && value.type === "verification"
		&& "challenge" in value && typeof value.challenge === "string";
}
