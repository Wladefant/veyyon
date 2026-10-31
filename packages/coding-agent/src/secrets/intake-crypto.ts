import {
	decodeSecretIntakeBase64Url,
	encodeSecretIntakeBase64Url,
	MAX_SECRET_UTF8_BYTES,
	parseSecretRequestMetadata,
	parseSecretSubmission,
	secretRequestAad,
	SECRET_INTAKE_VERSION,
	type SecretRequestMetadata,
	type SecretSubmission,
} from "./intake-wire";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const HKDF_INFO = encoder.encode("veyyon/secret-intake/v1");
const subtle = globalThis.crypto.subtle;

function safeFailure(): never {
	throw new TypeError("Secret intake operation failed");
}

async function deriveAesKey(privateKey: CryptoKey, publicKey: CryptoKey, nonce: Uint8Array): Promise<CryptoKey> {
	let shared: ArrayBuffer | undefined;
	try {
		shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
		const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
		return await subtle.deriveKey(
			{ name: "HKDF", hash: "SHA-256", salt: nonce, info: HKDF_INFO },
			material,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		);
	} finally {
		if (shared) new Uint8Array(shared).fill(0);
	}
}

async function importPublicJwk(jwk: JsonWebKey): Promise<CryptoKey> {
	return subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export async function createSecretIntakeKeyPair(): Promise<CryptoKeyPair> {
	try {
		return await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
	} catch {
		return safeFailure();
	}
}

export async function sealSecretSubmission(metadataValue: SecretRequestMetadata, value: string): Promise<SecretSubmission> {
	let plaintext: Uint8Array | undefined;
	let nonce: Uint8Array | undefined;
	try {
		const metadata = parseSecretRequestMetadata(metadataValue);
		if (typeof value !== "string") return safeFailure();
		for (let index = 0; index < value.length; index++) {
			const codeUnit = value.charCodeAt(index);
			if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
				if (index + 1 >= value.length) return safeFailure();
				const next = value.charCodeAt(index + 1);
				if (next < 0xdc00 || next > 0xdfff) return safeFailure();
				index++;
			} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
				return safeFailure();
			}
		}
		plaintext = encoder.encode(value);
		if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SECRET_UTF8_BYTES) return safeFailure();
		nonce = decodeSecretIntakeBase64Url(metadata.nonce, 16, 64);
		const ephemeral = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
		const clientPublicKeyJwk = await subtle.exportKey("jwk", ephemeral.publicKey);
		const serverPublicKey = await importPublicJwk(metadata.serverPublicKeyJwk);
		const aesKey = await deriveAesKey(ephemeral.privateKey, serverPublicKey, nonce);
		const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: secretRequestAad(metadata), tagLength: 128 }, aesKey, plaintext);
		return parseSecretSubmission({
			version: SECRET_INTAKE_VERSION,
			requestId: metadata.requestId,
			nonce: metadata.nonce,
			clientPublicKeyJwk,
			iv: encodeSecretIntakeBase64Url(iv),
			ciphertext: encodeSecretIntakeBase64Url(new Uint8Array(ciphertext)),
		});
	} catch {
		return safeFailure();
	} finally {
		plaintext?.fill(0);
		nonce?.fill(0);
	}
}

export async function openSecretSubmission(
	metadataValue: SecretRequestMetadata,
	submissionValue: SecretSubmission,
	privateKey: CryptoKey,
): Promise<string> {
	let ciphertext: Uint8Array | undefined;
	let nonce: Uint8Array | undefined;
	let plaintext: ArrayBuffer | undefined;
	try {
		const metadata = parseSecretRequestMetadata(metadataValue);
		const submission = parseSecretSubmission(submissionValue);
		if (submission.requestId !== metadata.requestId || submission.nonce !== metadata.nonce) return safeFailure();
		if (privateKey.type !== "private" || privateKey.algorithm.name !== "ECDH" || privateKey.usages.indexOf("deriveBits") < 0) return safeFailure();
		ciphertext = decodeSecretIntakeBase64Url(submission.ciphertext, 16, MAX_SECRET_UTF8_BYTES + 16);
		nonce = decodeSecretIntakeBase64Url(metadata.nonce, 16, 64);
		const clientPublicKey = await importPublicJwk(submission.clientPublicKeyJwk);
		const aesKey = await deriveAesKey(privateKey, clientPublicKey, nonce);
		const iv = decodeSecretIntakeBase64Url(submission.iv, 12, 12);
		plaintext = await subtle.decrypt({ name: "AES-GCM", iv, additionalData: secretRequestAad(metadata), tagLength: 128 }, aesKey, ciphertext);
		if (plaintext.byteLength === 0 || plaintext.byteLength > MAX_SECRET_UTF8_BYTES) return safeFailure();
		return fatalDecoder.decode(plaintext);
	} catch {
		return safeFailure();
	} finally {
		ciphertext?.fill(0);
		nonce?.fill(0);
		if (plaintext) new Uint8Array(plaintext).fill(0);
	}
}
