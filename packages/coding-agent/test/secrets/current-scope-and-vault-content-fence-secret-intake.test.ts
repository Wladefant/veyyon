import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { SecretIntakeBroker, type SecretIntakeContext, type SecretIntakeOperation } from "../../src/secrets/intake-broker";
import { sealSecretSubmission } from "../../src/secrets/intake-crypto";

const context: SecretIntakeContext = { ownerSessionId: "session-synthetic", projectId: "project-synthetic", actorId: "actor-synthetic" };
const operation: SecretIntakeOperation = { tool: "synthetic-provider-login", purpose: "synthetic-auth" };
const databases: Database[] = [];

interface Harness {
	broker: SecretIntakeBroker;
	values: Map<string, string>;
	privateOperations: string[];
}

function setup(options: {
	isCurrentScope?: () => boolean;
	now?: () => number;
	save?: (value: string) => Promise<void>;
	read?: (value: string) => string;
} = {}): Harness {
	const database = new Database(":memory:");
	databases.push(database);
	const values = new Map<string, string>();
	const privateOperations: string[] = [];
	const vault = {
		async saveVerified(_identity: unknown, value: string) {
			await options.save?.(value);
			const itemId = "synthetic-item-id";
			values.set(itemId, value);
			return { itemId };
		},
		async readVerified(_identity: unknown, itemId: string) {
			const value = values.get(itemId);
			if (value === undefined) throw new Error("missing synthetic item");
			return options.read?.(value) ?? value;
		},
	};
	const protection = {
		async register(_value: string, _resource: string) {},
		async execute(_value: string) { privateOperations.push("execute"); },
	};
	const broker = new SecretIntakeBroker({
		database,
		vault,
		protection,
		vaultCollection: "synthetic-collection",
		context,
		allowedOperations: [operation],
		now: options.now,
		isCurrentScope: options.isCurrentScope,
	});
	return { broker, values, privateOperations };
}

async function pending(h: Harness, value: string) {
	const created = await h.broker.create(context, {
		purpose: operation.purpose,
		approvedTool: operation.tool,
		provider: "synthetic-provider",
		label: "synthetic label",
	});
	const submission = await sealSecretSubmission(created.request, value);
	return { created, submission };
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

describe("secret intake current-scope and vault-content fences", () => {
	test("rejects every request and private operation after the current scope changes", async () => {
		let current = true;
		const h = setup({ isCurrentScope: () => current });
		const { created, submission } = await pending(h, "synthetic-value-scope");
		current = false;
		expect(() => h.broker.get(context, created.request.requestId)).toThrow("Secret intake request refused");
		await expect(h.broker.submit(context, submission)).rejects.toThrow("Secret intake request refused");
		await expect(h.broker.consume(context, "A".repeat(43), operation)).rejects.toThrow("Secret intake request refused");
		expect(h.privateOperations).toEqual([]);
	});

	test("stops submission when current scope changes across the vault-save await", async () => {
		let current = true;
		let releaseSave!: () => void;
		const saveSuspended = new Promise<void>(resolve => { releaseSave = resolve; });
		const h = setup({ isCurrentScope: () => current, save: () => saveSuspended });
		const { submission } = await pending(h, "synthetic-await-boundary-value");
		const submitting = h.broker.submit(context, submission);
		await new Promise<void>(resolve => setImmediate(resolve));
		current = false;
		releaseSave();
		await expect(submitting).rejects.toThrow("Secret intake vault verification failed");
		expect(h.privateOperations).toEqual([]);
	});


	test("refuses saved item content swapped after save despite unchanged identity", async () => {
		const h = setup();
		const { submission } = await pending(h, "synthetic-original-value");
		const saved = await h.broker.submit(context, submission);
		expect(saved.secretRef).toBeDefined();
		h.values.set("synthetic-item-id", "synthetic-substituted-value");
		await expect(h.broker.consume(context, saved.secretRef!, operation)).rejects.toThrow("Secret intake private operation failed");
		expect(h.privateOperations).toEqual([]);
	});

	test("does not issue a usable reference when the request expires during suspended vault save", async () => {
		let now = 1_000;
		let releaseSave!: () => void;
		const saveSuspended = new Promise<void>(resolve => { releaseSave = resolve; });
		const h = setup({ now: () => now, save: () => saveSuspended });
		const { created, submission } = await pending(h, "synthetic-expiring-value");
		const submitting = h.broker.submit(context, submission);
		await new Promise<void>(resolve => setImmediate(resolve));
		now = Date.parse(created.request.expiresAt) + 1;
		releaseSave();
		await expect(submitting).rejects.toThrow("Secret intake vault verification failed");
		expect(() => h.broker.get(context, created.request.requestId)).not.toThrow();
		expect(h.broker.get(context, created.request.requestId).request.status).toBe("expired");
		expect(h.privateOperations).toEqual([]);
	});
	test("cancellation during suspended vault save prevents a reference and consume", async () => {
		const saveStarted = Promise.withResolvers<void>();
		const saveSuspended = Promise.withResolvers<void>();
		const h = setup({ save: async () => { saveStarted.resolve(); await saveSuspended.promise; } });
		const { created, submission } = await pending(h, "synthetic-cancelled-save-value");
		const submitting = h.broker.submit(context, submission);
		await saveStarted.promise;
		const cancelled = h.broker.cancel(context, created.request.requestId);
		expect(cancelled.request.status).toBe("cancelled");
		saveSuspended.resolve();
		await expect(submitting).rejects.toThrow("Secret intake vault verification failed");
		const current = h.broker.get(context, created.request.requestId);
		expect(current.request.status).toBe("cancelled");
		expect(current.secretRef).toBeUndefined();
		await expect(h.broker.consume(context, "A".repeat(43), operation)).rejects.toThrow("Secret intake request refused");
		expect(h.privateOperations).toEqual([]);
	});

});
