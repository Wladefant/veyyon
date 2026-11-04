import type { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
	openSecretSubmission,
	sealSecretSubmission,
} from "../src/secrets/intake-crypto";
import {
	decodeSecretIntakeBase64Url,
	encodeSecretIntakeBase64Url,
	parseSecretRequestMetadata,
	parseSecretSubmission,
	type SecretRequestMetadata,
} from "../src/secrets/intake-wire";

interface SyntheticFixture {
	metadata: SecretRequestMetadata;
	testOnlyServerPrivateJwk: webcrypto.JsonWebKey;
	testOnlyClientPrivateJwk: webcrypto.JsonWebKey;
	fixedPlaintext: string;
	fixedSubmission: {
		version: 1;
		requestId: string;
		nonce: string;
		clientPublicKeyJwk: webcrypto.JsonWebKey;
		iv: string;
		ciphertext: string;
	};
}

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/secret-intake-p256-synthetic.json", import.meta.url)), "utf8")) as SyntheticFixture;
const subtle = globalThis.crypto.subtle;

async function serverPrivateKey(): Promise<CryptoKey> {
	return subtle.importKey("jwk", fixture.testOnlyServerPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

describe("sealed secret intake wire", () => {
	test("rejects malformed, extra-key, secret-bearing, and non-public JWK envelopes", () => {
		expect(() => parseSecretRequestMetadata({ ...fixture.metadata, extra: true })).toThrow("Invalid secret intake message");
		expect(() => parseSecretRequestMetadata({ ...fixture.metadata, value: "synthetic" })).toThrow("Invalid secret intake message");
		expect(() => parseSecretRequestMetadata({ ...fixture.metadata, serverPublicKeyJwk: { ...fixture.metadata.serverPublicKeyJwk, d: "synthetic" } })).toThrow("Invalid secret intake message");
		expect(() => parseSecretRequestMetadata({ ...fixture.metadata, purpose: "synthetic\u0000purpose" })).toThrow("Invalid secret intake message");
		expect(() => parseSecretRequestMetadata({ ...fixture.metadata, purpose: "x".repeat(513) })).toThrow("Invalid secret intake message");
		expect(() => parseSecretSubmission({ version: 1, requestId: "synthetic-request-0001", nonce: fixture.metadata.nonce, clientPublicKeyJwk: fixture.metadata.serverPublicKeyJwk, iv: "AAECAwQFBgcICQoL", ciphertext: "AAECAwQFBgcICQoLDA0ODw", extra: 1 })).toThrow("Invalid secret intake message");
		expect(() => parseSecretSubmission({ version: 1, requestId: "synthetic-request-0001", nonce: fixture.metadata.nonce, clientPublicKeyJwk: fixture.metadata.serverPublicKeyJwk, iv: "AAECAwQFBgcICQoL=", ciphertext: "AAECAwQFBgcICQoLDA0ODw" })).toThrow("Invalid secret intake message");
	});

	test("round-trips Unicode, newlines, quotes, and shell metacharacters without changing plaintext", async () => {
		const value = "synthetic ▰\r\nquote=' double=\" shell=$() ; && | < >";
		const submission = await sealSecretSubmission(fixture.metadata, value);
		await expect(openSecretSubmission(fixture.metadata, submission, await serverPrivateKey())).resolves.toBe(value);
	});

	test("opens the fixed P-256/HKDF/AES-GCM vector", async () => {
		await expect(openSecretSubmission(fixture.metadata, fixture.fixedSubmission, await serverPrivateKey())).resolves.toBe(fixture.fixedPlaintext);
	});

	test("rejects ciphertext tampering, wrong nonce, and changed authenticated metadata", async () => {
		const submission = await sealSecretSubmission(fixture.metadata, "synthetic secret");
		const bytes = decodeSecretIntakeBase64Url(submission.ciphertext, 16, 8192 + 16);
		bytes[0] ^= 1;
		const tampered = { ...submission, ciphertext: encodeSecretIntakeBase64Url(bytes) };
		await expect(openSecretSubmission(fixture.metadata, tampered, await serverPrivateKey())).rejects.toThrow("Secret intake operation failed");
		await expect(openSecretSubmission(fixture.metadata, { ...submission, nonce: "AQECAwQFBgcICQoLDA0ODw" }, await serverPrivateKey())).rejects.toThrow("Secret intake operation failed");
		await expect(openSecretSubmission({ ...fixture.metadata, projectId: "other-project" }, submission, await serverPrivateKey())).rejects.toThrow("Secret intake operation failed");
	});

	test("accepts exactly 8192 UTF-8 bytes and rejects empty or oversized values", async () => {
		const value = "x".repeat(8192);
		const submission = await sealSecretSubmission(fixture.metadata, value);
		await expect(openSecretSubmission(fixture.metadata, submission, await serverPrivateKey())).resolves.toBe(value);
		await expect(sealSecretSubmission(fixture.metadata, "")).rejects.toThrow("Secret intake operation failed");
		await expect(sealSecretSubmission(fixture.metadata, `${value}x`)).rejects.toThrow("Secret intake operation failed");
		await expect(sealSecretSubmission(fixture.metadata, "é".repeat(4097))).rejects.toThrow("Secret intake operation failed");
		await expect(sealSecretSubmission(fixture.metadata, "\uD800")).rejects.toThrow("Secret intake operation failed");
		await expect(sealSecretSubmission(fixture.metadata, "\uDC00")).rejects.toThrow("Secret intake operation failed");
	});
});
