import { withFileLock } from "@veyyon/utils";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface IntakeVaultIdentity {
	projectId: string;
	purpose: string;
	provider: string;
	vaultCollection: string;
	requestId: string;
}

export interface VerifiedIntakeItem {
	itemId: string;
}

export interface IntakeVault {
	saveVerified(identity: IntakeVaultIdentity, value: string): Promise<VerifiedIntakeItem>;
	readVerified(identity: IntakeVaultIdentity, itemId: string): Promise<string>;
}

export interface BitwardenUsIntakeVaultConfig {
	executable: string;
	/** Production Windows calls the existing US wrapper through cmd, never bw.exe directly. */
	windowsUsWrapper?: boolean;
	argsPrefix?: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	organizationId: string;
	projectCollections: Readonly<Record<string, string>>;
	lockDirectory: string;
}

interface BitwardenField {
	name?: string;
	value?: string;
}

interface BitwardenItem {
	id?: string;
	name?: string;
	notes?: string | null;
	organizationId?: string | null;
	collectionIds?: string[] | null;
	fields?: BitwardenField[] | null;
}

const TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const ITEM_PREFIX = "Veyyon secure intake ";
const FIELD_PROJECT = "Veyyon intake project";
const FIELD_PURPOSE = "Veyyon intake purpose";
const FIELD_PROVIDER = "Veyyon intake provider";
const FIELD_REQUEST = "Veyyon intake request";
const FIELD_HASH = "Veyyon intake sha256";

function fail(code: "vault-unavailable" | "vault-invalid-response" | "vault-identity-mismatch"): never {
	throw new Error(`Bitwarden intake ${code}`);
}

function itemField(item: BitwardenItem, name: string): string | undefined {
	return item.fields?.find(field => field.name === name)?.value;
}

function identityName(identity: IntakeVaultIdentity): string {
	return `${ITEM_PREFIX}${createHash("sha256").update(JSON.stringify([identity.projectId, identity.purpose, identity.provider])).digest("hex")}`;
}

function identityMatches(item: BitwardenItem, identity: IntakeVaultIdentity): boolean {
	return itemField(item, FIELD_PROJECT) === identity.projectId
		&& itemField(item, FIELD_PURPOSE) === identity.purpose
		&& itemField(item, FIELD_PROVIDER) === identity.provider;
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export class BitwardenUsIntakeVault implements IntakeVault {
	readonly #config: BitwardenUsIntakeVaultConfig;

	constructor(config: BitwardenUsIntakeVaultConfig) {
		if (config.env.BW_SERVE?.toLowerCase() === "true") fail("vault-identity-mismatch");
		this.#config = {
			...config,
			argsPrefix: config.argsPrefix ? [...config.argsPrefix] : [],
			env: { ...config.env, BW_SERVE: "false" },
		};
	}

	async saveVerified(identity: IntakeVaultIdentity, value: string): Promise<VerifiedIntakeItem> {
		const name = identityName(identity);
		const lockName = "bitwarden-us.lock";
		return await withFileLock(join(this.#config.lockDirectory, lockName), async () => {
			const collectionId = await this.#resolveCollection(identity);
			const rawItems = await this.#run(["list", "items", "--search", name]);
			if (rawItems === undefined) fail("vault-invalid-response");
			const items = this.#parseItems(rawItems);
			const matches = items.filter(item => item.name === name
				&& identityMatches(item, identity)
				&& item.organizationId === this.#config.organizationId
				&& item.collectionIds?.includes(collectionId));
			if (matches.length > 1) fail("vault-identity-mismatch");
			if (matches.length === 1) {
				const existing = matches[0];
				if (typeof existing.id !== "string" || itemField(existing, FIELD_HASH) !== digest(value)) fail("vault-identity-mismatch");
				if (await this.#readItem(identity, existing.id) !== value) fail("vault-identity-mismatch");
				return { itemId: existing.id };
			}

			const payload = {
				object: "item",
				type: 2,
				name,
				notes: value,
				organizationId: this.#config.organizationId,
				collectionIds: [collectionId],
				secureNote: { type: 0 },
				fields: [
					{ name: FIELD_PROJECT, value: identity.projectId, type: 0 },
					{ name: FIELD_PURPOSE, value: identity.purpose, type: 0 },
					{ name: FIELD_PROVIDER, value: identity.provider, type: 0 },
					{ name: FIELD_REQUEST, value: identity.requestId, type: 0 },
					{ name: FIELD_HASH, value: digest(value), type: 0 },
				],
			};
			const createResult = await this.#run(
				["create", "item"],
				Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
			);
			if (createResult === undefined) fail("vault-invalid-response");
			const created = this.#parseItem(createResult);
			if (typeof created.id !== "string" || !created.id) fail("vault-invalid-response");
			if (await this.#readItem(identity, created.id) !== value) fail("vault-identity-mismatch");
			return { itemId: created.id };
		});
	}

	async readVerified(identity: IntakeVaultIdentity, itemId: string): Promise<string> {
		return await withFileLock(join(this.#config.lockDirectory, "bitwarden-us.lock"), async () => {
			await this.#resolveCollection(identity);
			return await this.#readItem(identity, itemId);
		});
	}

	async #resolveCollection(identity: IntakeVaultIdentity): Promise<string> {
		const collectionId = this.#config.projectCollections[identity.projectId];
		if (!collectionId) fail("vault-identity-mismatch");
		const raw = await this.#run(["get", "org-collection", collectionId]);
		if (raw === undefined) fail("vault-invalid-response");
		let collection: unknown;
		try {
			collection = JSON.parse(raw);
		} catch {
			fail("vault-invalid-response");
		}
		if (collection === null || typeof collection !== "object" || Array.isArray(collection)) fail("vault-invalid-response");
		const record = collection as { id?: string; name?: string; organizationId?: string };
		if (record.id !== collectionId || record.name !== identity.vaultCollection || record.organizationId !== this.#config.organizationId) {
			fail("vault-identity-mismatch");
		}
		return collectionId;
	}

	async #readItem(identity: IntakeVaultIdentity, itemId: string): Promise<string> {
		const raw = await this.#run(["get", "item", itemId]);
		if (raw === undefined) fail("vault-invalid-response");
		const item = this.#parseItem(raw);
		this.#validateItem(item, identity, itemId);
		if (typeof item.notes !== "string" || itemField(item, FIELD_HASH) !== digest(item.notes)) fail("vault-identity-mismatch");
		return item.notes;
	}

	#validateItem(item: BitwardenItem, identity: IntakeVaultIdentity, itemId: string): void {
		const collectionId = this.#config.projectCollections[identity.projectId];
		if (item.id !== itemId || item.organizationId !== this.#config.organizationId || !item.collectionIds?.includes(collectionId ?? "")
			|| !identityMatches(item, identity)) {
			fail("vault-identity-mismatch");
		}
	}

	#parseItem(raw: string): BitwardenItem {
		let item: unknown;
		try {
			item = JSON.parse(raw);
		} catch {
			fail("vault-invalid-response");
		}
		if (item === null || typeof item !== "object" || Array.isArray(item)) fail("vault-invalid-response");
		return item as BitwardenItem;
	}

	#parseItems(raw: string): BitwardenItem[] {
		let items: unknown;
		try {
			items = JSON.parse(raw);
		} catch {
			fail("vault-invalid-response");
		}
		if (!Array.isArray(items) || items.some(item => item === null || typeof item !== "object" || Array.isArray(item))) fail("vault-invalid-response");
		return items as BitwardenItem[];
	}

	async #run(args: string[], stdin?: string): Promise<string | undefined> {
		// Only metadata reaches cmd. Reject expansion and shell syntax before quoting each argument.
		if (this.#config.windowsUsWrapper && args.some(arg => !/^[A-Za-z0-9_. -]+$/.test(arg))) {
			fail("vault-identity-mismatch");
		}
		const commandArgs = this.#config.windowsUsWrapper
			? ["/d", "/s", "/c", `"bw-us ${args.map(arg => `"${arg}"`).join(" ")}"`]
			: [...(this.#config.argsPrefix ?? []), ...args];
		const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
		const child = spawn(this.#config.executable, commandArgs, {
			cwd: this.#config.cwd,
			env: this.#config.env,
			windowsHide: true,
			windowsVerbatimArguments: this.#config.windowsUsWrapper === true,
			stdio: ["pipe", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (error?: Error, output?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			for (const chunk of chunks) chunk.fill(0);
			if (error) reject(error);
			else resolve(output);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new Error("Bitwarden intake vault-unavailable"));
		}, TIMEOUT_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_STDOUT_BYTES) {
				child.kill();
				finish(new Error("Bitwarden intake vault-invalid-response"));
				return;
			}
			chunks.push(chunk);
		});
		child.stdin.on("error", () => finish(new Error("Bitwarden intake vault-unavailable")));
		child.on("error", () => finish(new Error("Bitwarden intake vault-unavailable")));
		child.on("close", code => {
			if (code !== 0) {
				finish(new Error("Bitwarden intake vault-unavailable"));
				return;
			}
			const outputBytes = Buffer.concat(chunks);
			const output = outputBytes.toString("utf8").trim();
			outputBytes.fill(0);
			if (output.length > MAX_STDOUT_BYTES) {
				finish(new Error("Bitwarden intake vault-invalid-response"));
				return;
			}
			finish(undefined, output || undefined);
		});
		child.stdin.end(stdin ?? "");
		return promise;
	}
}
