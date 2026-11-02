import { isCheckpointNodeLabel } from "@veyyon/session/checkpoint-ownership";
import { createHash, randomUUID } from "node:crypto";
import { withScopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
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
	"handoff?": { targetNode: "string", claimToken: "string", transferId: "string", epoch: "number" },
});
export interface CheckpointLease {
	ownerNode: string;
	epoch: number;
	expiresAt: string;
	headSequence: number;
	manifestHash: string;
	targetNode?: string;
	transferId?: string;
}
function hasLiveLeaseFence(lease: CheckpointLease | null | undefined): lease is CheckpointLease {
	if (!lease || !Number.isSafeInteger(lease.epoch) || lease.epoch < 0) return false;
	const expiresAt = typeof lease.expiresAt === "string" ? Date.parse(lease.expiresAt) : Number.NaN;
	return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
export interface CheckpointClaim {
	lease: CheckpointLease;
	resumeToken: string;
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
	#activeCommits = new Map<string, { payloadHash: string; ownerNode: string; epoch: number; promise: Promise<unknown> }>();
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
		return withScopedTimeoutSignal(this.#timeout, async signal => {
			const response = await this.#fetch(new URL(path, this.options.baseUrl), {
				...init,
				signal,
				headers: { authorization: `Bearer ${this.options.token}`, ...init.headers },
			});
			if (!response.ok) throw new Error(`Checkpoint service returned HTTP ${response.status}`);
			if (response.status === 204) return undefined as T;
			// The response body is part of the same bounded authority request.
			return (await response.json()) as T;
		});
	}
	async acquireLease(sessionId: string, ownerNode: string): Promise<CheckpointLease> {
		if (!isCheckpointNodeLabel(ownerNode)) throw new Error("A valid checkpoint owner label is required");
		const lease = await this.#request<CheckpointLease>(`/v1/sessions/${encodeURIComponent(sessionId)}/lease`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ownerNode }),
		});
		if (!lease || lease.ownerNode !== ownerNode) {
			this.loseLease(sessionId);
			throw new Error("Checkpoint authority lease owner mismatch");
		}
		if (!hasLiveLeaseFence(lease)) {
			this.loseLease(sessionId);
			throw new Error("Checkpoint authority lease fence invalid");
		}
		this.#leases.set(sessionId, lease);
		this.#lost.delete(sessionId);
		return lease;
	}
	async #redeemTransfer(
		sessionId: string,
		targetNode: string,
		transferId: string,
		credential: { claimToken: string } | { resumeToken: string },
		transferEpoch: number,
		runtimeOwner: string,
	): Promise<CheckpointClaim> {
		if (!isCheckpointNodeLabel(targetNode) || !isCheckpointNodeLabel(runtimeOwner))
			throw new Error("A valid checkpoint node label is required");
		// Match the authority's transfer-identity grammar before sending a
		// potentially one-use claim or resume capability over the network.
		if (
			!Number.isSafeInteger(transferEpoch) ||
			transferEpoch < 1 ||
			!/^[A-Za-z0-9_-]{1,128}$/.test(transferId)
		)
			throw new Error("Invalid checkpoint transfer identity");
		const capability = "claimToken" in credential ? credential.claimToken : credential.resumeToken;
		if (typeof capability !== "string" || capability.length < 16 || capability.length > 128)
			throw new Error("Invalid checkpoint transfer capability");
		const result = await this.#request<CheckpointLease & { resumeToken: string }>(
			`/v1/sessions/${encodeURIComponent(sessionId)}/claim`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					targetNode,
					transferId,
					...credential,
					epoch: transferEpoch,
					ownerNode: runtimeOwner,
				}),
			},
		);
		if (!result || result.ownerNode !== runtimeOwner) {
			this.loseLease(sessionId);
			throw new Error("Checkpoint authority lease owner mismatch");
		}
		if (
			typeof result.resumeToken !== "string" ||
			result.resumeToken.length < 16 ||
			result.resumeToken.length > 128
		) {
			this.loseLease(sessionId);
			throw new Error("Checkpoint authority did not issue a valid resume capability");
		}
		// A transfer grant is written to durable ownership metadata before the
		// first ordinary admission check. Refuse an expired/invalid authority
		// fence here, before a one-time claim is replaced by a resume marker.
		const expiresAt = typeof result.expiresAt === "string" ? Date.parse(result.expiresAt) : Number.NaN;
		if (
			!Number.isSafeInteger(result.epoch) ||
			result.epoch < transferEpoch ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= Date.now()
		) {
			this.loseLease(sessionId);
			throw new Error("Checkpoint authority transfer grant has invalid lease fence");
		}
		const { resumeToken, ...lease } = result;
		this.#leases.set(sessionId, lease);
		this.#lost.delete(sessionId);
		return { lease, resumeToken };
	}
	async claimTransfer(
		sessionId: string,
		targetNode: string,
		transferId: string,
		claimToken: string,
		transferEpoch: number,
		runtimeOwner: string,
	): Promise<CheckpointClaim> {
		return this.#redeemTransfer(sessionId, targetNode, transferId, { claimToken }, transferEpoch, runtimeOwner);
	}
	async resumeTransfer(
		sessionId: string,
		targetNode: string,
		transferId: string,
		resumeToken: string,
		transferEpoch: number,
		runtimeOwner: string,
	): Promise<CheckpointClaim> {
		return this.#redeemTransfer(sessionId, targetNode, transferId, { resumeToken }, transferEpoch, runtimeOwner);
	}
	async finalizeTransfer(
		sessionId: string,
		targetNode: string,
		transferId: string,
		transferEpoch: number,
		leaseEpoch: number,
		resumeToken: string,
	): Promise<void> {
		const lease = this.#leases.get(sessionId);
		if (!lease || this.#lost.has(sessionId) || lease.epoch !== leaseEpoch)
			throw new Error("Checkpoint lease required to finalize resume capability");
		await this.#request(`/v1/sessions/${encodeURIComponent(sessionId)}/finalize`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				ownerNode: lease.ownerNode,
				targetNode,
				transferId,
				epoch: transferEpoch,
				leaseEpoch,
				resumeToken,
			}),
		});
	}
	async transferLease(
		sessionId: string,
		targetNode: string,
		claimToken: string,
		transferId: string,
		source?: { ownerNode: string; epoch: number },
	): Promise<CheckpointLease> {
		const lease = this.#leases.get(sessionId);
		if ((!lease || this.#lost.has(sessionId)) && !source) throw new Error("Checkpoint lease required for transfer");
		const ownerNode = lease && !this.#lost.has(sessionId) ? lease.ownerNode : source!.ownerNode;
		const epoch = lease && !this.#lost.has(sessionId) ? lease.epoch : source!.epoch;
		if (!isCheckpointNodeLabel(targetNode)) throw new Error("A valid target node is required");
		if (!claimToken || claimToken.length < 16 || claimToken.length > 128) throw new Error("A valid transfer claim token is required");
		if (!isCheckpointNodeLabel(ownerNode)) throw new Error("A valid source node is required");
		const path = `/v1/sessions/${encodeURIComponent(sessionId)}/transfer`;
		const init: RequestInit = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				ownerNode,
				epoch,
				targetNode,
				claimToken,
				transferId,
			}),
		};
		// Once a handoff has been sent, its outcome may be uncertain even when
		// the transport fails. Fence the old source lease before sending so no
		// local prompt or checkpoint write can proceed under a possibly-spent
		// epoch while the authority response (or its one retry) is outstanding.
		this.loseLease(sessionId);
		let next: CheckpointLease;
		try {
			next = await this.#request<CheckpointLease>(path, init);
		} catch (firstError) {
			// An explicit 4xx refusal (except 408/429) is not an uncertain
			// transport result. Never replay a one-use transfer after a known 409.
			const status = firstError instanceof Error
				? /^Checkpoint service returned HTTP (\d{3})$/.exec(firstError.message)
				: null;
			if (status && Number(status[1]) < 500 && status[1] !== "408" && status[1] !== "429")
				throw firstError;
			try {
				next = await this.#request<CheckpointLease>(path, init);
			} catch {
				throw firstError;
			}
		}
		const expiresAt = next && typeof next.expiresAt === "string" ? Date.parse(next.expiresAt) : Number.NaN;
		if (
			!next ||
			next.ownerNode !== targetNode ||
			!Number.isSafeInteger(next.epoch) ||
			next.epoch !== epoch + 1 ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= Date.now()
		)
			throw new Error("Checkpoint authority transfer receipt mismatch");
		return next;
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
			if (!next || next.ownerNode !== lease.ownerNode)
				throw new Error("Checkpoint authority lease owner mismatch");
			// Renewing an existing lease cannot invent or jump a fencing epoch.
			if (!Number.isSafeInteger(next.epoch) || next.epoch !== lease.epoch)
				throw new Error("Checkpoint authority lease epoch mismatch");
			if (!hasLiveLeaseFence(next)) throw new Error("Checkpoint authority lease fence invalid");
			this.#leases.set(sessionId, next);
			return next;
		} catch (error) {
			this.loseLease(sessionId);
			throw error;
		}
	}
	async releaseLease(sessionId: string): Promise<CheckpointLease | undefined> {
		const lease = this.#leases.get(sessionId);
		if (!lease) return undefined;
		try {
			const released = await this.#request<CheckpointLease>(`/v1/sessions/${encodeURIComponent(sessionId)}/release`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ownerNode: lease.ownerNode, epoch: lease.epoch }),
			});
			// A successful HTTP status cannot authorize an unverified resume-marker
			// epoch. The authority contract releases the same owner at epoch + 1.
			if (
				!released ||
				released.ownerNode !== lease.ownerNode ||
				!Number.isSafeInteger(released.epoch) ||
				released.epoch !== lease.epoch + 1
			)
				throw new Error("Checkpoint authority release fence mismatch");
			return released;
		} finally {
			// An ambiguous/invalid release response must not leave this client
			// locally writable or silently reissue the external release.
			this.loseLease(sessionId);
		}
	}
	loseLease(sessionId: string): void {
		this.#leases.delete(sessionId);
		this.#lost.add(sessionId);
	}
	async assertWritable(sessionId: string, epoch: number): Promise<void> {
		const lease = this.#leases.get(sessionId);
		if (
			!hasLiveLeaseFence(lease) ||
			this.#lost.has(sessionId) ||
			lease.epoch !== epoch
		)
			throw new Error("Checkpoint lease lost; synchronized writes are fenced");
	}
	async commit(sessionId: string, bundle: CheckpointBundle, expectedHead: number): Promise<unknown> {
		const lease = this.#leases.get(sessionId);
		if (!lease) throw new Error("Checkpoint lease required");
		await this.assertWritable(sessionId, lease.epoch);
		const operation = `${sessionId}:${expectedHead}`;
		const payloadHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
		const active = this.#activeCommits.get(operation);
		if (active) {
			if (active.payloadHash !== payloadHash) throw new Error("Pending checkpoint replay payload changed");
			if (active.ownerNode !== lease.ownerNode || active.epoch !== lease.epoch)
				throw new Error("Checkpoint lease changed during concurrent commit");
			return await active.promise;
		}
		// Reserve the operation before the first awaited encryption step; otherwise
		// two callers create different ciphertext/idempotency keys for one head.
		const promise = this.#commitOnce(sessionId, bundle, expectedHead, lease, operation, payloadHash);
		this.#activeCommits.set(operation, { payloadHash, ownerNode: lease.ownerNode, epoch: lease.epoch, promise });
		try {
			return await promise;
		} finally {
			if (this.#activeCommits.get(operation)?.promise === promise) this.#activeCommits.delete(operation);
		}
	}
	async #commitOnce(
		sessionId: string,
		bundle: CheckpointBundle,
		expectedHead: number,
		lease: CheckpointLease,
		operation: string,
		payloadHash: string,
	): Promise<unknown> {
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
			const put = await withScopedTimeoutSignal(this.#timeout, async signal =>
				this.#fetch(new URL(`/v1/objects/${hash}`, this.options.baseUrl), {
					method: "PUT",
					signal,
					headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/octet-stream" },
					body: chunk,
				}),
			);
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
			const bytes = await withScopedTimeoutSignal(this.#timeout, async signal => {
				const response = await this.#fetch(new URL(`/v1/objects/${object.hash}`, this.options.baseUrl), {
					signal,
					headers: { authorization: `Bearer ${this.options.token}` },
				});
				if (!response.ok) throw new Error(`Checkpoint object unavailable: HTTP ${response.status}`);
				if (!response.body) throw new Error("Checkpoint object integrity check failed");
				const result = new Uint8Array(object.size);
				const reader = response.body.getReader();
				let received = 0;
				let complete = false;
				try {
					while (true) {
						const part = await reader.read();
						if (part.done) {
							complete = true;
							break;
						}
						// Refuse an oversized body before buffering another chunk into the result.
						if (part.value.byteLength > object.size - received)
							throw new Error("Checkpoint object integrity check failed");
						result.set(part.value, received);
						received += part.value.byteLength;
					}
				} finally {
					if (!complete) void reader.cancel().catch(() => {});
					reader.releaseLock();
				}
				if (received !== object.size) throw new Error("Checkpoint object integrity check failed");
				return result;
			});
			const hash = createHash("sha256").update(bytes).digest("hex");
			if (hash !== object.hash) throw new Error("Checkpoint object integrity check failed");
			ciphertext.set(bytes, offset);
			offset += bytes.byteLength;
		}
		const bundle = await decryptCheckpointBundle(ciphertext, this.options.key);
		if (bundle.native.sessionId !== sessionId) throw new Error("Checkpoint session identity mismatch");
		return bundle;
	}
}
