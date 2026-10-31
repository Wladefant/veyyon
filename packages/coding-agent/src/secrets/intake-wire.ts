export const SECRET_INTAKE_VERSION = 1 as const;
export const MAX_SECRET_UTF8_BYTES = 8192;

export type SecretRequestStatus = "pending" | "saving" | "saved" | "declined" | "cancelled" | "expired" | "consumed" | "failed";
export type SecretDeliveryPolicy = "private-operation";

export interface SecretRequestMetadata {
	version: typeof SECRET_INTAKE_VERSION;
	requestId: string;
	ownerSessionId: string;
	projectId: string;
	purpose: string;
	label: string;
	provider: string;
	vaultCollection: string;
	deliveryPolicy: SecretDeliveryPolicy;
	expiresAt: string;
	nonce: string;
	serverPublicKeyJwk: JsonWebKey;
	status: SecretRequestStatus;
}

export interface SecretSubmission {
	version: typeof SECRET_INTAKE_VERSION;
	requestId: string;
	nonce: string;
	clientPublicKeyJwk: JsonWebKey;
	iv: string;
	ciphertext: string;
}

const metadataKeys = ["version", "requestId", "ownerSessionId", "projectId", "purpose", "label", "provider", "vaultCollection", "deliveryPolicy", "expiresAt", "nonce", "serverPublicKeyJwk", "status"] as const;
const submissionKeys = ["version", "requestId", "nonce", "clientPublicKeyJwk", "iv", "ciphertext"] as const;
const statuses = new Set<SecretRequestStatus>(["pending", "saving", "saved", "declined", "cancelled", "expired", "consumed", "failed"]);
const encoder = new TextEncoder();

function invalid(): never {
	throw new TypeError("Invalid secret intake message");
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = false): string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) return invalid();
	if (encoder.encode(value).byteLength > maxBytes || /[\u0000-\u001F\u007F-\u009F]/u.test(value)) return invalid();
	return value;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	const record = value as Record<string, unknown>;
	const ownKeys = Object.keys(record);
	if (ownKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) return invalid();
	return record;
}

function canonicalBase64Url(value: unknown, minBytes: number, maxBytes: number): string {
	const text = boundedString(value, Math.ceil(maxBytes * 4 / 3) + 4);
	if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return invalid();
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
	if (binary.length < minBytes || binary.length > maxBytes) return invalid();
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	if (toBase64Url(bytes) !== text) return invalid();
	return text;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function publicP256Jwk(value: unknown): JsonWebKey {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
	const jwk = value as Record<string, unknown>;
	const fields = Object.keys(jwk);
	if (fields.some((field) => !["kty", "crv", "x", "y", "ext", "key_ops", "alg", "use"].includes(field))) return invalid();
	if (jwk.kty !== "EC" || jwk.crv !== "P-256" || Object.hasOwn(jwk, "d")) return invalid();
	for (const coordinate of [jwk.x, jwk.y]) {
		if (typeof coordinate !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(coordinate)) return invalid();
		canonicalBase64Url(coordinate, 32, 32);
	}
	if (jwk.ext !== undefined && jwk.ext !== true) return invalid();
	if (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 0)) return invalid();
	if (jwk.alg !== undefined && jwk.alg !== "ECDH-ES") return invalid();
	if (jwk.use !== undefined && jwk.use !== "enc") return invalid();
	return { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string };
}

export function parseSecretRequestMetadata(value: unknown): SecretRequestMetadata {
	const input = exactRecord(value, metadataKeys);
	if (input.version !== SECRET_INTAKE_VERSION || input.deliveryPolicy !== "private-operation" || !statuses.has(input.status as SecretRequestStatus)) return invalid();
	const expiresAt = boundedString(input.expiresAt, 40);
	if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) return invalid();
	return {
		version: SECRET_INTAKE_VERSION,
		requestId: boundedString(input.requestId, 128),
		ownerSessionId: boundedString(input.ownerSessionId, 128),
		projectId: boundedString(input.projectId, 128),
		purpose: boundedString(input.purpose, 512),
		label: boundedString(input.label, 128),
		provider: boundedString(input.provider, 128),
		vaultCollection: boundedString(input.vaultCollection, 128),
		deliveryPolicy: "private-operation",
		expiresAt,
		nonce: canonicalBase64Url(input.nonce, 16, 64),
		serverPublicKeyJwk: publicP256Jwk(input.serverPublicKeyJwk),
		status: input.status as SecretRequestStatus,
	};
}

export function parseSecretSubmission(value: unknown): SecretSubmission {
	const input = exactRecord(value, submissionKeys);
	if (input.version !== SECRET_INTAKE_VERSION) return invalid();
	return {
		version: SECRET_INTAKE_VERSION,
		requestId: boundedString(input.requestId, 128),
		nonce: canonicalBase64Url(input.nonce, 16, 64),
		clientPublicKeyJwk: publicP256Jwk(input.clientPublicKeyJwk),
		iv: canonicalBase64Url(input.iv, 12, 12),
		ciphertext: canonicalBase64Url(input.ciphertext, 16, 8192 + 16),
	};
}

export function secretRequestAad(metadataValue: SecretRequestMetadata): Uint8Array {
	const metadata = parseSecretRequestMetadata(metadataValue);
	return encoder.encode(JSON.stringify({
		version: metadata.version,
		requestId: metadata.requestId,
		ownerSessionId: metadata.ownerSessionId,
		projectId: metadata.projectId,
		expiresAt: metadata.expiresAt,
		nonce: metadata.nonce,
	}));
}

export function decodeSecretIntakeBase64Url(value: string, minBytes: number, maxBytes: number): Uint8Array {
	const text = canonicalBase64Url(value, minBytes, maxBytes);
	const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeSecretIntakeBase64Url(value: Uint8Array): string {
	return toBase64Url(value);
}
