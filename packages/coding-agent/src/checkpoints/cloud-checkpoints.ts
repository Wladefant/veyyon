import { createHash, randomUUID } from "node:crypto";
import { type } from "@veyyon/ai/utils/schema/arktype";
import type { NativeCheckpointBundle } from "./native-recovery";

export type CheckpointBundle = NativeCheckpointBundle;
const checkpointBundle = type({
	version: "1",
	native: { sessionId: "string", header: "Record<string, unknown>", sessionFile: "string", "forkedFrom?": "string" },
	journal: { path: "string", bytes: "string" },
	artifacts: "Record<string, string>",
	blobs: "Record<string, string>",
	workspace: { dirty: "string[]", files: [{ path: "string", bytes: "string" }, "[]"] },
	pins: { bun: "string", commit: "string", runtime: "string" },
});
export interface CheckpointLease {
	ownerNode: string;
	epoch: number;
	expiresAt: string;
	headSequence: number;
	manifestHash: string;
}
export interface CheckpointFile {
	path: string;
	content: Uint8Array;
}
const excluded =
	/(^|\/)(?:\.env(?:\..*)?|\.git|\.agents|shared-auth|credentials?|browser|node_modules|\.cache|\.next|\.turbo|\.venv|venv|__pycache__|\.pytest_cache|\.lock|.*\.lock)(\/|$)/i;
export function filterCheckpointFiles(files: CheckpointFile[]): CheckpointFile[] {
	return files.filter(
		file =>
			!file.path
				.replaceAll("\\", "/")
				.split("/")
				.some(part => part === ".env" || part.startsWith(".env.")) &&
			!excluded.test(file.path.replaceAll("\\", "/")),
	);
}
export async function encryptCheckpointBundle(
	bundle: CheckpointBundle,
	key: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
	if (key.byteLength !== 32) throw new Error("Checkpoint encryption key must be 32 bytes");
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
	const plain = new TextEncoder().encode(JSON.stringify(bundle));
	const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plain));
	const result = new Uint8Array(1 + iv.length + encrypted.length);
	result[0] = 1;
	result.set(iv, 1);
	result.set(encrypted, 13);
	return result;
}
export async function decryptCheckpointBundle(
	bytes: Uint8Array<ArrayBuffer>,
	key: Uint8Array<ArrayBuffer>,
): Promise<CheckpointBundle> {
	if (key.byteLength !== 32 || bytes.byteLength < 30 || bytes[0] !== 1) throw new Error("Invalid checkpoint envelope");
	const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: bytes.subarray(1, 13) },
		cryptoKey,
		bytes.subarray(13),
	);
	return checkpointBundle.assert(JSON.parse(new TextDecoder().decode(plain)));
}
export type CheckpointFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface CheckpointClientOptions {
	baseUrl: string;
	token: string;
	key: Uint8Array<ArrayBuffer>;
	fetch?: CheckpointFetch;
	timeoutMs?: number;
}
export class CheckpointClient {
	readonly enabled: boolean;
	#fetch: CheckpointFetch;
	#timeout: number;
	#leases = new Map<string, CheckpointLease>();
	#lost = new Set<string>();
	#pendingCommits = new Map<string, { ciphertext: Uint8Array; payloadHash: string; idempotencyKey: string }>();
	constructor(readonly options: CheckpointClientOptions) {
		this.enabled = Boolean(options.baseUrl && options.token && options.key?.byteLength === 32);
		this.#fetch = options.fetch ?? fetch;
		this.#timeout = options.timeoutMs ?? 10000;
	}
	static fromEnv(env: Record<string, string | undefined> = process.env): CheckpointClient {
		const raw = env.VEYYON_CHECKPOINT_KEY;
		let key = new Uint8Array();
		if (raw) {
			try {
				key = new Uint8Array(Buffer.from(raw, "base64"));
			} catch {
				/* invalid key remains disabled */
			}
		}
		return new CheckpointClient({
			baseUrl: env.VEYYON_CHECKPOINT_URL ?? "",
			token: env.VEYYON_CHECKPOINT_TOKEN ?? "",
			key,
		});
	}
	async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
		if (!this.enabled) throw new Error("Cloud checkpoints are disabled or not configured");
		const response = await this.#fetch(new URL(path, this.options.baseUrl), {
			...init,
			signal: AbortSignal.timeout(this.#timeout),
			headers: { authorization: `Bearer ${this.options.token}`, ...init.headers },
		});
		if (!response.ok) throw new Error(`Checkpoint service returned HTTP ${response.status}`);
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}
	async acquireLease(sessionId: string, ownerNode: string): Promise<CheckpointLease> {
		const lease = await this.#request<CheckpointLease>(`/v1/sessions/${encodeURIComponent(sessionId)}/lease`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ownerNode }),
		});
		this.#leases.set(sessionId, lease);
		this.#lost.delete(sessionId);
		return lease;
	}
	async head(sessionId: string): Promise<{
		sequence: number;
		manifestHash: string;
		manifest: { objects: { hash: string; size: number }[] };
	} | null> {
		return this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/head`);
	}
	async renewLease(sessionId: string): Promise<CheckpointLease> {
		const lease = this.#leases.get(sessionId);
		if (!lease || this.#lost.has(sessionId)) throw new Error("Checkpoint lease lost");
		try {
			const next = await this.#request<CheckpointLease>(`/v1/sessions/${encodeURIComponent(sessionId)}/renew`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ownerNode: lease.ownerNode, epoch: lease.epoch }),
			});
			this.#leases.set(sessionId, next);
			return next;
		} catch (error) {
			this.loseLease(sessionId);
			throw error;
		}
	}
	async releaseLease(sessionId: string): Promise<void> {
		const lease = this.#leases.get(sessionId);
		if (!lease) return;
		await this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/release`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ownerNode: lease.ownerNode, epoch: lease.epoch }),
		});
		this.#leases.delete(sessionId);
		this.#lost.add(sessionId);
	}
	loseLease(sessionId: string): void {
		this.#leases.delete(sessionId);
		this.#lost.add(sessionId);
	}
	async assertWritable(sessionId: string, epoch: number): Promise<void> {
		const lease = this.#leases.get(sessionId);
		if (!lease || this.#lost.has(sessionId) || lease.epoch !== epoch || Date.parse(lease.expiresAt) <= Date.now())
			throw new Error("Checkpoint lease lost; synchronized writes are fenced");
	}
	async commit(sessionId: string, bundle: CheckpointBundle, expectedHead: number): Promise<unknown> {
		const lease = this.#leases.get(sessionId);
		if (!lease) throw new Error("Checkpoint lease required");
		await this.assertWritable(sessionId, lease.epoch);
		const operation = `${sessionId}:${expectedHead}`;
		const payloadHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
		let pending = this.#pendingCommits.get(operation);
		if (pending && pending.payloadHash !== payloadHash) throw new Error("Pending checkpoint replay payload changed");
		if (!pending) {
			const ciphertext = await encryptCheckpointBundle(bundle, this.options.key);
			if (ciphertext.byteLength > 67108864) throw new Error("Checkpoint exceeds the 64 MiB cap");
			pending = { ciphertext, payloadHash, idempotencyKey: randomUUID() };
			this.#pendingCommits.set(operation, pending);
		}
		const objects: { hash: string; size: number }[] = [];
		for (let offset = 0; offset < pending.ciphertext.byteLength; offset += 8388608) {
			const chunk = pending.ciphertext.subarray(offset, Math.min(offset + 8388608, pending.ciphertext.byteLength));
			const hash = createHash("sha256").update(chunk).digest("hex");
			const put = await this.#fetch(new URL(`/v1/objects/${hash}`, this.options.baseUrl), {
				method: "PUT",
				signal: AbortSignal.timeout(this.#timeout),
				headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/octet-stream" },
				body: chunk,
			});
			if (!put.ok && put.status !== 409) throw new Error(`Checkpoint object upload returned HTTP ${put.status}`);
			objects.push({ hash, size: chunk.byteLength });
		}
		await this.assertWritable(sessionId, lease.epoch);
		const result = await this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				ownerNode: lease.ownerNode,
				epoch: lease.epoch,
				expectedHead,
				idempotencyKey: pending.idempotencyKey,
				manifest: { version: 1, sessionId, sequence: expectedHead + 1, objects },
			}),
		});
		this.#pendingCommits.delete(operation);
		return result;
	}
	async restore(sessionId: string): Promise<CheckpointBundle | null> {
		const head = await this.#request<{
			sequence: number;
			manifestHash: string;
			manifest: { objects: { hash: string; size: number }[] };
		} | null>(`/v1/sessions/${encodeURIComponent(sessionId)}/head`);
		if (!head) return null;
		if (createHash("sha256").update(JSON.stringify(head.manifest)).digest("hex") !== head.manifestHash)
			throw new Error("Manifest integrity failure");
		const size = head.manifest.objects.reduce((total, object) => {
			if (
				!Number.isSafeInteger(object.size) ||
				object.size < 1 ||
				object.size > 8388608 ||
				!/^[a-f0-9]{64}$/.test(object.hash)
			)
				throw new Error("Invalid checkpoint object reference");
			return total + object.size;
		}, 0);
		if (size < 1 || size > 67108864) throw new Error("Checkpoint size outside caps");
		const ciphertext = new Uint8Array(size);
		let offset = 0;
		for (const object of head.manifest.objects) {
			const response = await this.#fetch(new URL(`/v1/objects/${object.hash}`, this.options.baseUrl), {
				signal: AbortSignal.timeout(this.#timeout),
				headers: { authorization: `Bearer ${this.options.token}` },
			});
			if (!response.ok) throw new Error(`Checkpoint object unavailable: HTTP ${response.status}`);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const hash = createHash("sha256").update(bytes).digest("hex");
			if (hash !== object.hash || bytes.byteLength !== object.size)
				throw new Error("Checkpoint object integrity check failed");
			ciphertext.set(bytes, offset);
			offset += bytes.byteLength;
		}
		const bundle = await decryptCheckpointBundle(ciphertext, this.options.key);
		if (bundle.native.sessionId !== sessionId) throw new Error("Checkpoint session identity mismatch");
		return bundle;
	}
}
