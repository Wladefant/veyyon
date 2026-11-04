import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createSecretIntakeKeyPair, openSecretSubmission } from "./intake-crypto";
import { parseSecretRequestMetadata, parseSecretSubmission, type SecretRequestMetadata, type SecretSubmission } from "./intake-wire";
import type { IntakeVault, IntakeVaultIdentity } from "./intake-vault";

/** Identity supplied by the authenticated native host, never by a tool argument. */
export interface SecretIntakeContext {
	ownerSessionId: string;
	projectId: string;
	actorId: string;
}
export interface SecretIntakeCreateInput {
	purpose: string;
	label: string;
	provider: string;
	approvedTool: string;
}
export interface SecretIntakeResult {
	request: SecretRequestMetadata;
	secretRef?: string;
}
export interface SecretIntakeOperation {
	tool: string;
	purpose: string;
}
export interface SecretIntakeProtection {
	/** Register before vault IO or consumer output can escape the private boundary. */
	register(value: string, resource: string): Promise<void>;
	/** Runs only an operator-approved operation, with value held in private execution memory. */
	execute(value: string, operation: SecretIntakeOperation): Promise<void>;
}
export interface SecretIntakeBrokerOptions {
	/** Opened by the host in its existing protected configuration directory. Contains metadata only. */
	database: Database;
	vault: IntakeVault;
	protection: SecretIntakeProtection;
	vaultCollection: string;
	context: SecretIntakeContext;
	allowedOperations: readonly SecretIntakeOperation[];
	ttlMs?: number;
	now?: () => number;
	isCurrentScope?: () => boolean;
}
interface StoredRequest {
	request_id: string;
	epoch: string;
	actor_id: string;
	metadata: string;
	approved_tool: string;
	submission_hash: string | null;
	item_id: string | null;
	ref_hash: string | null;
}
function fail(): never { throw new Error("Secret intake request refused"); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sameContext(left: SecretIntakeContext, right: SecretIntakeContext): boolean {
	return left.ownerSessionId === right.ownerSessionId && left.projectId === right.projectId && left.actorId === right.actorId;
}

/** One native session owns ephemeral keys; durable SQL compare-and-swap fences every state change. */
export class SecretIntakeBroker {
	readonly #options: SecretIntakeBrokerOptions;
	readonly #epoch = randomUUID();
	readonly #keys = new Map<string, CryptoKey>();
	readonly #refs = new Map<string, string>();
	readonly #valueHashes = new Map<string, string>();
	readonly #listeners = new Set<(result: SecretIntakeResult) => void>();
	#closed = false;

	constructor(options: SecretIntakeBrokerOptions) {
		this.#options = options;
		if (!options.context.actorId || !options.context.ownerSessionId || !options.context.projectId || !options.vaultCollection) fail();
		options.database.exec(`CREATE TABLE IF NOT EXISTS secret_intake_v1 (
			request_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, actor_id TEXT NOT NULL,
			metadata TEXT NOT NULL, approved_tool TEXT NOT NULL, submission_hash TEXT,
			item_id TEXT, ref_hash TEXT UNIQUE
		)`);
	}

	subscribe(listener: (result: SecretIntakeResult) => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	async create(context: SecretIntakeContext, input: SecretIntakeCreateInput): Promise<SecretIntakeResult> {
		this.#authorize(context);
		if (!this.#options.allowedOperations.some(operation => operation.tool === input.approvedTool && operation.purpose === input.purpose)) fail();
		const keys = await createSecretIntakeKeyPair();
		const request = parseSecretRequestMetadata({
			version: 1, requestId: randomBytes(32).toString("base64url"),
			ownerSessionId: context.ownerSessionId, projectId: context.projectId,
			purpose: input.purpose, label: input.label, provider: input.provider,
			vaultCollection: this.#options.vaultCollection, deliveryPolicy: "private-operation",
			expiresAt: new Date(this.#now() + Math.min(Math.max(this.#options.ttlMs ?? 300_000, 1), 900_000)).toISOString(),
			nonce: randomBytes(32).toString("base64url"),
			serverPublicKeyJwk: await globalThis.crypto.subtle.exportKey("jwk", keys.publicKey), status: "pending",
		});
		this.#options.database.query("INSERT INTO secret_intake_v1(request_id,epoch,actor_id,metadata,approved_tool) VALUES(?,?,?,?,?)")
			.run(request.requestId, this.#epoch, context.actorId, JSON.stringify(request), input.approvedTool);
		this.#keys.set(request.requestId, keys.privateKey);
		return this.#publish({ request });
	}

	listPending(context: SecretIntakeContext): SecretIntakeResult[] {
		this.#authorize(context);
		const rows = this.#options.database.query<StoredRequest, [string, string]>(
			"SELECT * FROM secret_intake_v1 WHERE epoch=? AND actor_id=?",
		).all(this.#epoch, context.actorId);
		const pending: SecretIntakeResult[] = [];
		for (const row of rows) {
			const result = this.get(context, row.request_id);
			if (result.request.status === "pending" || result.request.status === "saved") pending.push(result);
		}
		return pending;
	}

	get(context: SecretIntakeContext, requestId: string): SecretIntakeResult {
		const row = this.#load(context, requestId);
		const request = this.#metadata(row);
		const secretRef = request.status === "saved" ? this.#refs.get(requestId) : undefined;
		return secretRef ? { request, secretRef } : { request };
	}

	async submit(context: SecretIntakeContext, submissionValue: SecretSubmission): Promise<SecretIntakeResult> {
		this.#authorize(context);
		const submission = parseSecretSubmission(submissionValue);
		const row = this.#load(context, submission.requestId);
		const request = this.#metadata(row);
		if (submission.nonce !== request.nonce) fail();
		const fingerprint = digest(JSON.stringify(submission));
		if (row.submission_hash !== null) {
			if (row.submission_hash !== fingerprint) fail();
			return this.get(context, submission.requestId);
		}
		if (request.status !== "pending") fail();
		const key = this.#keys.get(request.requestId);
		if (!key) fail();
		// Authenticate first. An invalid envelope cannot consume the legitimate request's nonce.
		let value = await openSecretSubmission(request, submission, key);
		const saving: SecretRequestMetadata = { ...request, status: "saving" };
		const changed = this.#options.database.query("UPDATE secret_intake_v1 SET metadata=?,submission_hash=? WHERE request_id=? AND epoch=? AND submission_hash IS NULL AND metadata=?")
			.run(JSON.stringify(saving), fingerprint, request.requestId, this.#epoch, row.metadata);
		if (changed.changes !== 1) { value = ""; fail(); }
		try {
			await this.#options.protection.register(value, `secret-intake:${request.requestId}`);
			const identity = this.#identity(request);
			const item = await this.#options.vault.saveVerified(identity, value);
			const verified = await this.#options.vault.readVerified(identity, item.itemId);
			if (digest(verified) !== digest(value)) fail();
			await this.#options.protection.register(verified, `bitwarden-us:${item.itemId}`);
			this.#authorize(context);
			if (Date.parse(request.expiresAt) <= this.#now()) {
				this.#load(context, request.requestId);
				fail();
			}
			const ref = randomBytes(32).toString("base64url");
			const saved: SecretRequestMetadata = { ...request, status: "saved" };
			const committed = this.#options.database.query("UPDATE secret_intake_v1 SET metadata=?,item_id=?,ref_hash=? WHERE request_id=? AND epoch=? AND metadata=?")
				.run(JSON.stringify(saved), item.itemId, digest(ref), request.requestId, this.#epoch, JSON.stringify(saving));
			if (committed.changes !== 1) fail();
			this.#refs.set(request.requestId, ref);
			this.#valueHashes.set(request.requestId, digest(verified));
			return this.#publish({ request: saved, secretRef: ref });
		} catch {
			const failed: SecretRequestMetadata = { ...request, status: "failed" };
			const failure = this.#options.database.query("UPDATE secret_intake_v1 SET metadata=? WHERE request_id=? AND epoch=? AND metadata=?")
				.run(JSON.stringify(failed), request.requestId, this.#epoch, JSON.stringify(saving));
			if (failure.changes === 1) this.#publish({ request: failed });
			throw new Error("Secret intake vault verification failed");
		} finally {
			value = "";
			this.#keys.delete(request.requestId);
		}
	}

	decline(context: SecretIntakeContext, requestId: string): SecretIntakeResult { return this.#end(context, requestId, "declined"); }
	cancel(context: SecretIntakeContext, requestId: string): SecretIntakeResult { return this.#end(context, requestId, "cancelled"); }

	async consume(context: SecretIntakeContext, secretRef: string, operation: SecretIntakeOperation): Promise<SecretIntakeResult> {
		this.#authorize(context);
		if (!/^[A-Za-z0-9_-]{43}$/.test(secretRef)) fail();
		const found = this.#options.database.query<StoredRequest, [string]>("SELECT * FROM secret_intake_v1 WHERE ref_hash=?").get(digest(secretRef));
		if (!found) fail();
		const row = this.#load(context, found.request_id);
		const request = this.#metadata(row);
		if (request.status !== "saved" || !row.item_id || operation.tool !== row.approved_tool || operation.purpose !== request.purpose) fail();
		const consumed: SecretRequestMetadata = { ...request, status: "consumed" };
		const change = this.#options.database.query("UPDATE secret_intake_v1 SET metadata=?,ref_hash=NULL WHERE request_id=? AND epoch=? AND ref_hash=? AND metadata=?")
			.run(JSON.stringify(consumed), row.request_id, this.#epoch, digest(secretRef), row.metadata);
		if (change.changes !== 1) fail();
		this.#refs.delete(row.request_id);
		const expectedDigest = this.#valueHashes.get(row.request_id);
		this.#valueHashes.delete(row.request_id);
		let value = "";
		try {
			value = await this.#options.vault.readVerified(this.#identity(request), row.item_id);
			if (!expectedDigest || digest(value) !== expectedDigest) fail();
			await this.#options.protection.register(value, `bitwarden-us:${row.item_id}`);
			this.#authorize(context);
			if (Date.parse(request.expiresAt) <= this.#now()) fail();
			await this.#options.protection.execute(value, operation);
			return this.#publish({ request: consumed });
		} catch { throw new Error("Secret intake private operation failed"); }
		finally { value = ""; }
	}

	close(): void { this.#closed = true; this.#keys.clear(); this.#refs.clear(); this.#valueHashes.clear(); this.#listeners.clear(); }
	#now(): number { return this.#options.now?.() ?? Date.now(); }
	#authorize(context: SecretIntakeContext): void {
		if (this.#closed || !sameContext(context, this.#options.context) || this.#options.isCurrentScope?.() === false) fail();
	}
	#identity(request: SecretRequestMetadata): IntakeVaultIdentity {
		return { projectId: request.projectId, purpose: request.purpose, provider: request.provider, vaultCollection: request.vaultCollection, requestId: request.requestId };
	}
	#metadata(row: StoredRequest): SecretRequestMetadata { return parseSecretRequestMetadata(JSON.parse(row.metadata)); }
	#load(context: SecretIntakeContext, requestId: string): StoredRequest {
		this.#authorize(context);
		if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(requestId)) fail();
		const row = this.#options.database.query<StoredRequest, [string]>("SELECT * FROM secret_intake_v1 WHERE request_id=?").get(requestId);
		if (!row || row.actor_id !== context.actorId) fail();
		const metadata = this.#metadata(row);
		if (metadata.ownerSessionId !== context.ownerSessionId || metadata.projectId !== context.projectId) fail();
		if ((row.epoch !== this.#epoch || Date.parse(metadata.expiresAt) <= this.#now()) && ["pending", "saving", "saved"].includes(metadata.status)) {
			row.metadata = JSON.stringify({ ...metadata, status: "expired" });
			this.#options.database.query("UPDATE secret_intake_v1 SET metadata=?,ref_hash=NULL WHERE request_id=?").run(row.metadata, requestId);
			this.#keys.delete(requestId); this.#refs.delete(requestId); this.#valueHashes.delete(requestId);
		}
		return row;
	}
	#end(context: SecretIntakeContext, requestId: string, status: "declined" | "cancelled"): SecretIntakeResult {
		const row = this.#load(context, requestId);
		const request = this.#metadata(row);
		if (!["pending", "saving", "saved"].includes(request.status)) fail();
		const ended: SecretRequestMetadata = { ...request, status };
		const change = this.#options.database.query("UPDATE secret_intake_v1 SET metadata=?,ref_hash=NULL WHERE request_id=? AND metadata=? AND epoch=?")
			.run(JSON.stringify(ended), requestId, row.metadata, this.#epoch);
		if (change.changes !== 1) fail();
		this.#keys.delete(requestId); this.#refs.delete(requestId); this.#valueHashes.delete(requestId);
		return this.#publish({ request: ended });
	}
	#publish(result: SecretIntakeResult): SecretIntakeResult {
		for (const listener of this.#listeners) { try { listener(result); } catch { /* Notifications cannot change committed authority. */ } }
		return result;
	}
}
