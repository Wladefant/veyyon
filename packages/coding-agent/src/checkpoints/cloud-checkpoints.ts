import { isCheckpointNodeLabel } from "@veyyon/session/checkpoint-ownership";
import { createHash, randomUUID } from "node:crypto";
import { raceWithTimeout, withScopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
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
	/(^|\/)(?:\.env(?:\..*)?|\.git|\.agents|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.terraform(?:\.d)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.gitconfig|shared-auth|credentials?|browser|node_modules|\.cache|\.next|\.turbo|\.venv|venv|__pycache__|\.pytest_cache|\.lock|.*\.lock)(\/|$)/i;
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
	// Admission tokens fence out-of-order authority replies on a shared client.
	#leaseAdmissions = new Map<string, symbol>();
	// A one-use transfer capability must not be spent concurrently by two guards.
	#transferClaimsInFlight = new Set<string>();
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
			const response = await raceWithTimeout(
				this.#fetch(new URL(path, this.options.baseUrl), {
					...init,
					signal,
					headers: { authorization: `Bearer ${this.options.token}`, ...init.headers },
				}),
				this.#timeout,
				() => new Error("Checkpoint authority response headers timed out"),
				{ signal },
			);
			if (!response.ok) throw new Error(`Checkpoint service returned HTTP ${response.status}`);
			if (response.status === 204) return undefined as T;
			// Keep JSON control-plane responses inside the same timeout AND byte cap.
			// Binary checkpoint objects have their own bounded reader below.
			if (!response.body) throw new Error("Checkpoint authority returned no JSON body");
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			const maxResponseBytes = 256 * 1024;
			let received = 0;
			let complete = false;
			try {
				while (true) {
					const part = await raceWithTimeout(
						reader.read(),
						this.#timeout,
						() => new Error("Checkpoint response body timed out"),
						{ signal },
					);
					if (part.done) {
						complete = true;
						break;
					}
					if (part.value.byteLength > maxResponseBytes - received)
						throw new Error("Checkpoint authority JSON exceeds 256 KiB");
					chunks.push(part.value);
					received += part.value.byteLength;
				}
			} finally {
				if (!complete) void reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, received))) as T;
		});
	}
	#beginLeaseAdmission(sessionId: string): symbol {
		const attempt = Symbol("checkpoint lease admission");
		this.#leaseAdmissions.set(sessionId, attempt);
		return attempt;
	}
	#assertLeaseAdmissionCurrent(sessionId: string, attempt: symbol): void {
		if (this.#leaseAdmissions.get(sessionId) !== attempt)
			throw new Error("Checkpoint lease admission superseded");
	}
	#finishLeaseAdmission(sessionId: string, attempt: symbol): void {
		if (this.#leaseAdmissions.get(sessionId) === attempt)
			this.#leaseAdmissions.delete(sessionId);
	}
	async acquireLease(sessionId: string, ownerNode: string): Promise<CheckpointLease> {
		if (!isCheckpointNodeLabel(ownerNode)) throw new Error("A valid checkpoint owner label is required");
		if (this.#transferClaimsInFlight.has(sessionId))
			throw new Error("Checkpoint transfer admission already in flight");
		const attempt = this.#beginLeaseAdmission(sessionId);
		try {
			const lease = await this.#request<CheckpointLease>(`/v1/sessions/${encodeURIComponent(sessionId)}/lease`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ownerNode }),
			});
			// A later admission/claim (or explicit lease loss) wins even if this
			// older request reports a nominally valid or invalid authority grant.
			this.#assertLeaseAdmissionCurrent(sessionId, attempt);
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
		} finally {
			this.#finishLeaseAdmission(sessionId, attempt);
		}
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
		// Reject another claim/resume before sending a one-use capability, and
		// do not let an ordinary lease admission supersede its unresolved receipt.
		if (this.#transferClaimsInFlight.has(sessionId))
			throw new Error("Checkpoint transfer admission already in flight");
		this.#transferClaimsInFlight.add(sessionId);
		const attempt = this.#beginLeaseAdmission(sessionId);
		try {
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
			this.#assertLeaseAdmissionCurrent(sessionId, attempt);
			if (!result || result.ownerNode !== runtimeOwner) {
				this.loseLease(sessionId);
				throw new Error("Checkpoint authority lease owner mismatch");
			}
			// Bind the one-use grant to the transfer named in the request before
			// publishing its lease as locally writable. The authority echoes both.
			if (result.targetNode !== targetNode || result.transferId !== transferId) {
				this.loseLease(sessionId);
				throw new Error("Checkpoint authority transfer grant identity mismatch");
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
				// A target reservation at transferEpoch is not a redeemed runtime lease.
				result.epoch <= transferEpoch ||
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
		} finally {
			this.#finishLeaseAdmission(sessionId, attempt);
			this.#transferClaimsInFlight.delete(sessionId);
		}
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
		const confirmation = await this.#request<{ ok?: unknown }>(`/v1/sessions/${encodeURIComponent(sessionId)}/finalize`, {
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
		// The pinned authority returns {ok:true} only after persisting the
		// rotated resume capability. A 2xx status alone is not confirmation.
		if (!confirmation || confirmation.ok !== true)
			throw new Error("Checkpoint authority finalization receipt mismatch");
	}
	async transferLease(
		sessionId: string,
		targetNode: string,
		claimToken: string,
		transferId: string,
		source?: { ownerNode: string; epoch: number },
	): Promise<CheckpointLease> {
		if (this.#transferClaimsInFlight.has(sessionId))
			throw new Error("Checkpoint transfer admission already in flight");
		const lease = this.#leases.get(sessionId);
		const active = lease && !this.#lost.has(sessionId) ? lease : undefined;
		// A recovery caller may carry an older source fence. Never silently
		// substitute a newer shared-client owner's lease for that caller.
		if (source && active && (active.ownerNode !== source.ownerNode || active.epoch !== source.epoch))
			throw new Error("Checkpoint source lease changed before transfer");
		if (!active && !source) throw new Error("Checkpoint lease required for transfer");
		const ownerNode = active ? active.ownerNode : source!.ownerNode;
		const epoch = active ? active.epoch : source!.epoch;
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
			next.targetNode !== targetNode ||
			next.transferId !== transferId ||
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
	async renewLease(
		sessionId: string,
		expected?: Pick<CheckpointLease, "ownerNode" | "epoch">,
	): Promise<CheckpointLease> {
		const lease = this.#leases.get(sessionId);
		if (
			!lease ||
			this.#lost.has(sessionId) ||
			(expected && (lease.ownerNode !== expected.ownerNode || lease.epoch !== expected.epoch))
		) throw new Error("Checkpoint lease lost");
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
			// A late reply from a previous owner must not overwrite the lease
			// a second guard acquired while the renewal was in flight.
			const current = this.#leases.get(sessionId);
			if (
				this.#lost.has(sessionId) ||
				current?.ownerNode !== lease.ownerNode ||
				current?.epoch !== lease.epoch
			) throw new Error("Checkpoint lease changed during renewal");
			this.#leases.set(sessionId, next);
			return next;
		} catch (error) {
			// Revoke only our original fence. Another owner may have acquired a
			// later one while this authority response was pending.
			const current = this.#leases.get(sessionId);
			if (current?.ownerNode === lease.ownerNode && current.epoch === lease.epoch)
				this.loseLease(sessionId);
			throw error;
		}
	}
	async releaseLease(
		sessionId: string,
		expected?: Pick<CheckpointLease, "ownerNode" | "epoch">,
	): Promise<CheckpointLease | undefined> {
		const lease = this.#leases.get(sessionId);
		// A guard that held an earlier fence must never release a newer owner
		// through this client's session-keyed lease cache.
		if (
			!lease ||
			(expected && (lease.ownerNode !== expected.ownerNode || lease.epoch !== expected.epoch))
		) return undefined;
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
			// An ambiguous/invalid response invalidates ONLY the fence sent with
			// this release. A fresh guard can acquire a later epoch while a
			// successful/failed older release response is still in flight.
			const active = this.#leases.get(sessionId);
			if (active?.ownerNode === lease.ownerNode && active.epoch === lease.epoch)
				this.loseLease(sessionId);
		}
	}
	loseLease(sessionId: string): void {
		// Explicit revocation also invalidates replies that are still in flight.
		this.#leaseAdmissions.delete(sessionId);
		this.#leases.delete(sessionId);
		this.#lost.add(sessionId);
	}
	async assertWritable(sessionId: string, epoch: number, expectedOwner?: string): Promise<void> {
		const lease = this.#leases.get(sessionId);
		if (
			!hasLiveLeaseFence(lease) ||
			this.#lost.has(sessionId) ||
			lease.epoch !== epoch ||
			(expectedOwner !== undefined && lease.ownerNode !== expectedOwner)
		)
			throw new Error("Checkpoint lease lost; synchronized writes are fenced");
	}
	async commit(sessionId: string, bundle: CheckpointBundle, expectedHead: number): Promise<unknown> {
		// Reject impossible cloud writes before allocating encrypted ciphertext
		// or uploading immutable objects. These mirror the pinned authority caps.
		if (!this.enabled) throw new Error("Cloud checkpoints are disabled or not configured");
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid checkpoint session identity");
		if (!Number.isSafeInteger(expectedHead) || expectedHead < 0 || expectedHead >= 100)
			throw new Error("Invalid checkpoint expected head");
		// The Worker cannot inspect encrypted native bytes. Never commit a
		// differently identified source beneath this session's authority head.
		if (
			bundle.native.sessionId !== sessionId ||
			bundle.native.header.type !== "session" ||
			bundle.native.header.id !== sessionId
		)
			throw new Error("Checkpoint bundle session identity mismatch");
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
				raceWithTimeout(
					this.#fetch(new URL(`/v1/objects/${hash}`, this.options.baseUrl), {
						method: "PUT",
						signal,
						headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/octet-stream" },
						body: chunk,
					}),
					this.#timeout,
					() => new Error("Checkpoint object upload timed out"),
					{ signal },
				),
			);
			if (!put.ok && put.status !== 409) throw new Error(`Checkpoint object upload returned HTTP ${put.status}`);
			objects.push({ hash, size: chunk.byteLength });
		}
		await this.assertWritable(sessionId, lease.epoch);
		const manifest = { version: 1 as const, sessionId, sequence: expectedHead + 1, objects };
		const expectedManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
		const result = await this.#request<unknown>(`/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				ownerNode: lease.ownerNode,
				epoch: lease.epoch,
				expectedHead,
				idempotencyKey: pending.idempotencyKey,
				manifest,
			}),
		});
		// A 2xx response alone cannot prove that the requested journal was committed.
		// Preserve the original idempotency key on a malformed/uncertain receipt.
		if (
			!result ||
			typeof result !== "object" ||
			!("sequence" in result) ||
			!("manifestHash" in result) ||
			!("manifest" in result) ||
			result.sequence !== manifest.sequence ||
			result.manifestHash !== expectedManifestHash ||
			JSON.stringify(result.manifest) !== JSON.stringify(manifest)
		)
			throw new Error("Checkpoint authority commit receipt mismatch");
		this.#pendingCommits.delete(operation);
		return result;
	}
	async restore(sessionId: string): Promise<CheckpointBundle | null> {
		const head = await this.#request<{
			sequence: number;
			manifestHash: string;
			manifest: {
				version: number;
				sessionId: string;
				sequence: number;
				objects: { hash: string; size: number }[];
			};
		} | null>(`/v1/sessions/${encodeURIComponent(sessionId)}/head`);
		if (!head) return null;
		// The pinned authority only persists bounded, same-session version-1
		// manifests. Check that envelope before any encrypted-object GETs: a
		// corrupt head must not multiply requests or fetch another session's data.
		const manifest = head.manifest;
		if (
			!manifest ||
			manifest.version !== 1 ||
			manifest.sessionId !== sessionId ||
			!Number.isSafeInteger(manifest.sequence) ||
			manifest.sequence < 1 ||
			manifest.sequence > 100 ||
			head.sequence !== manifest.sequence ||
			!Array.isArray(manifest.objects) ||
			manifest.objects.length < 1 ||
			manifest.objects.length > 1024
		)
			throw new Error("Invalid checkpoint head");
		if (createHash("sha256").update(JSON.stringify(manifest)).digest("hex") !== head.manifestHash)
			throw new Error("Manifest integrity failure");
		const size = head.manifest.objects.reduce((total, object) => {
			if (
				!object ||
				typeof object !== "object" ||
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
				const response = await raceWithTimeout(
					this.#fetch(new URL(`/v1/objects/${object.hash}`, this.options.baseUrl), {
						signal,
						headers: { authorization: `Bearer ${this.options.token}` },
					}),
					this.#timeout,
					() => new Error("Checkpoint object response headers timed out"),
					{ signal },
				);
				if (!response.ok) throw new Error(`Checkpoint object unavailable: HTTP ${response.status}`);
				if (!response.body) throw new Error("Checkpoint object integrity check failed");
				const result = new Uint8Array(object.size);
				const reader = response.body.getReader();
				let received = 0;
				let complete = false;
				try {
					while (true) {
						const part = await raceWithTimeout(
							reader.read(),
							this.#timeout,
							() => new Error("Checkpoint response body timed out"),
							{ signal },
						);
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
