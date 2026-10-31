import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { SecretIntakeBroker, type SecretIntakeContext, type SecretIntakeOperation } from "../../src/secrets/intake-broker";
import { sealSecretSubmission } from "../../src/secrets/intake-crypto";

const context: SecretIntakeContext = { ownerSessionId: "session-a", projectId: "project-a", actorId: "actor-a" };
const operation: SecretIntakeOperation = { tool: "provider-login", purpose: "provider-auth" };
const databases: Database[] = [];

interface IntakeHarness {
	database: Database;
	broker: SecretIntakeBroker;
	vaultValues: Map<string, string>;
	calls: string[];
}

function setup(options: { now?: () => number; ttlMs?: number; save?: (value: string) => Promise<string>; read?: (value: string) => Promise<string> } = {}): IntakeHarness {
	const database = new Database(":memory:");
	databases.push(database);
	const vaultValues = new Map<string, string>();
	const calls: string[] = [];
	const vault = {
		async saveVerified(_identity: unknown, value: string) {
			calls.push("vault-save");
			const itemId = await (options.save?.(value) ?? Promise.resolve("item-1"));
			vaultValues.set(itemId, value);
			return { itemId };
		},
		async readVerified(_identity: unknown, itemId: string) {
			calls.push("vault-read");
			const value = vaultValues.get(itemId);
			if (value === undefined) throw new Error("missing synthetic item");
			return options.read ? options.read(value) : value;
		},
	};
	const protection = {
		async register(value: string) { calls.push(`register:${value}`); },
		async execute(value: string) { calls.push(`execute:${value}`); },
	};
	const broker = new SecretIntakeBroker({
		database, vault, protection, vaultCollection: "Shared", context,
		allowedOperations: [operation], now: options.now, ttlMs: options.ttlMs,
	});
	return { database, broker, vaultValues, calls };
}


async function createSaved(h: IntakeHarness, value = "canary ▰\r\n'\" $() ; && | < >") {
	const created = await h.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "synthetic-provider", label: "synthetic label" });
	const submission = await sealSecretSubmission(created.request, value);
	const saved = await h.broker.submit(context, submission);
	return { created, submission, saved, value };
}
describe("sealed intake ref authorization", () => {
	test("binds submission to actor, session, project and nonce before vault IO", async () => {
		const h = setup();
		const created = await h.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		const submission = await sealSecretSubmission(created.request, "synthetic value");
		for (const wrong of [
			{ ...context, actorId: "actor-b" }, { ...context, ownerSessionId: "session-b" }, { ...context, projectId: "project-b" },
		]) await expect(h.broker.submit(wrong, submission)).rejects.toThrow("Secret intake request refused");
		await expect(h.broker.submit(context, { ...submission, nonce: "A".repeat(43) })).rejects.toThrow();
		expect(h.calls).toEqual([]);
	});

	test("authenticates tampering and expires pending requests", async () => {
		let now = 1_800_000_000_000;
		const h = setup({ now: () => now, ttlMs: 10 });
		const created = await h.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		const submission = await sealSecretSubmission(created.request, "synthetic value");
		const raw = Uint8Array.from(atob(submission.ciphertext.replace(/-/g, "+").replace(/_/g, "/") + "=="), c => c.charCodeAt(0));
		raw[0] ^= 1;
		const tampered = { ...submission, ciphertext: btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") };
		await expect(h.broker.submit(context, tampered)).rejects.toThrow();
		expect(h.calls).toEqual([]);
		now += 11;
		expect(h.broker.get(context, created.request.requestId).request.status).toBe("expired");
	});

	test("saves Unicode bytes privately, registers before IO and executes exactly one approved operation", async () => {
		const h = setup();
		const { saved, value } = await createSaved(h, "🔒漢字\nline\r\nquote='\" ${x} ; | && < >");
		expect(saved.request.status).toBe("saved");
		expect(JSON.stringify(h.database.query("SELECT * FROM secret_intake_v1").all())).not.toContain(createHash("sha256").update(value).digest("hex"));
		expect(saved.secretRef).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(h.calls.slice(0, 3)).toEqual([`register:${value}`, "vault-save", "vault-read"]);
		expect(h.broker.get(context, saved.request.requestId)).toEqual({ request: saved.request, secretRef: saved.secretRef });
		await expect(h.broker.consume(context, saved.secretRef!, { ...operation, tool: "other-tool" })).rejects.toThrow("Secret intake request refused");
		await h.broker.consume(context, saved.secretRef!, operation);
		expect(h.calls.slice(-3)).toEqual(["vault-read", `register:${value}`, `execute:${value}`]);
		await expect(h.broker.consume(context, saved.secretRef!, operation)).rejects.toThrow("Secret intake request refused");
	});

	test("allows an identical submission replay but refuses changed replay", async () => {
		const h = setup();
		const { submission, saved } = await createSaved(h);
		await expect(h.broker.submit(context, submission)).resolves.toEqual({ request: saved.request, secretRef: saved.secretRef });
		await expect(h.broker.submit(context, { ...submission, ciphertext: `${submission.ciphertext.slice(0, -1)}A` })).rejects.toThrow();
		expect(h.calls.filter(call => call === "vault-save")).toHaveLength(1);
	});

	test("decline, cancel, restart and concurrent consume fail closed", async () => {
		const declined = setup();
		const pending = await declined.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		expect(declined.broker.decline(context, pending.request.requestId).request.status).toBe("declined");
		await expect(declined.broker.submit(context, await sealSecretSubmission(pending.request, "synthetic"))).rejects.toThrow();
		const cancelled = await declined.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		expect(declined.broker.cancel(context, cancelled.request.requestId).request.status).toBe("cancelled");
		const { saved } = await createSaved(declined);
		const restarted = new SecretIntakeBroker({ database: declined.database, vault: { saveVerified: async () => ({ itemId: "x" }), readVerified: async () => "synthetic" }, protection: { register: async () => {}, execute: async () => {} }, vaultCollection: "Shared", context, allowedOperations: [operation] });
		expect(restarted.get(context, saved.request.requestId).request.status).toBe("expired");
		await expect(restarted.consume(context, saved.secretRef!, operation)).rejects.toThrow();

		const h = setup();
		const { saved: concurrent } = await createSaved(h);
		const outcomes = await Promise.allSettled([
			h.broker.consume(context, concurrent.secretRef!, operation),
			h.broker.consume(context, concurrent.secretRef!, operation),
		]);
		expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
	});
	test("fences vault failures and keeps the canary out of public state", async () => {
		const canary = "canary-8f27 synthetic-private";
		const h = setup({ save: async () => { throw new Error(canary); } });
		const events: string[] = [];
		h.broker.subscribe(result => events.push(JSON.stringify(result)));
		const created = await h.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		const submission = await sealSecretSubmission(created.request, canary);
		await expect(h.broker.submit(context, submission)).rejects.toThrow("Secret intake vault verification failed");
		const persisted = JSON.stringify(h.database.query("SELECT * FROM secret_intake_v1").all());
		const exposed = [JSON.stringify(created), ...events, persisted].join("\n");
		expect(exposed).not.toContain(canary);
		expect(h.broker.get(context, created.request.requestId).request.status).toBe("failed");
		expect(h.calls).toEqual([`register:${canary}`, "vault-save"]);
		const verifyFailure = setup({ read: async () => "different synthetic value" });
		const verifyRequest = await verifyFailure.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		const verifySubmission = await sealSecretSubmission(verifyRequest.request, canary);
		await expect(verifyFailure.broker.submit(context, verifySubmission)).rejects.toThrow("Secret intake vault verification failed");
		expect(verifyFailure.broker.get(context, verifyRequest.request.requestId).request.status).toBe("failed");
	});

	test("accepts the maximum UTF-8 value and refuses one byte beyond it", async () => {
		const h = setup();
		const max = "🔑".repeat(2048);
		const created = await h.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		const envelope = await sealSecretSubmission(created.request, max);
		expect((await h.broker.submit(context, envelope)).request.status).toBe("saved");
		const next = await h.broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, provider: "p", label: "l" });
		await expect(sealSecretSubmission(next.request, `${max}x`)).rejects.toThrow();
	});
});
