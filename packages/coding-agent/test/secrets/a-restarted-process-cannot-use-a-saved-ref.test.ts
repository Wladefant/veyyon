import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretIntakeBroker, type SecretIntakeContext, type SecretIntakeOperation } from "../../src/secrets/intake-broker";
import { sealSecretSubmission } from "../../src/secrets/intake-crypto";

const context: SecretIntakeContext = { ownerSessionId: "session-restart", projectId: "project-restart", actorId: "actor-restart" };
const operation: SecretIntakeOperation = { tool: "synthetic-tool", purpose: "synthetic-purpose" };
const directories: string[] = [];
const databases: Database[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) database.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("secret intake restart fence", () => {
	test("a fresh process expires a saved request and invalidates its ref for the original process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "intake-restart-fence-"));
		directories.push(directory);
		const databasePath = join(directory, "metadata.sqlite");
		const database = new Database(databasePath);
		databases.push(database);
		const vaultValues = new Map<string, string>();
		const broker = new SecretIntakeBroker({
			database,
			vaultCollection: "synthetic-collection",
			context,
			allowedOperations: [operation],
			vault: {
				async saveVerified(_identity, value) { const itemId = "synthetic-item"; vaultValues.set(itemId, value); return { itemId }; },
				async readVerified(_identity, itemId) { const value = vaultValues.get(itemId); if (!value) throw new Error("missing synthetic item"); return value; },
			},
			protection: { async register() {}, async execute() {} },
		});
		const created = await broker.create(context, { purpose: operation.purpose, approvedTool: operation.tool, label: "synthetic label", provider: "synthetic-provider" });
		const saved = await broker.submit(context, await sealSecretSubmission(created.request, "synthetic-only-value"));
		expect(saved.secretRef).toBeDefined();
		const child = await runRestartChild(databasePath, created.request.requestId, saved.secretRef!);
		expect(child).toEqual({ status: "expired", consumeRefused: true });
		expect(broker.get(context, created.request.requestId).request.status).toBe("expired");
		await expect(broker.consume(context, saved.secretRef!, operation)).rejects.toThrow("Secret intake request refused");
	});
});

async function runRestartChild(databasePath: string, requestId: string, secretRef: string): Promise<{ status: string; consumeRefused: boolean }> {
	const childPath = fileURLToPath(new URL("./fixtures/intake-restart-child.ts", import.meta.url));
	const { promise, resolve, reject } = Promise.withResolvers<{ status: string; consumeRefused: boolean }>();
	const child = spawn(process.execPath, [childPath, databasePath, requestId, secretRef], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	let stdout = "";
	child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
	child.once("close", code => {
		if (code !== 0) { reject(new Error("restart child failed")); return; }
		try { resolve(JSON.parse(stdout) as { status: string; consumeRefused: boolean }); }
		catch { reject(new Error("restart child returned invalid status")); }
	});
	return await promise;
}
