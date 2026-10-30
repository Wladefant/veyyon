import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { BitwardenUsIntakeVault } from "../../src/secrets/intake-vault";

const roots: string[] = [];
const fixture = join(import.meta.dirname, "fixtures", "bitwarden-intake-child.mjs");
const identity = { projectId: "project-synthetic", purpose: "provider-auth", provider: "provider-synthetic", vaultCollection: "Synthetic collection", requestId: "request-synthetic" };
const value = "synthetic-canary-only";

async function setup(overrides: Record<string, unknown> = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "intake-vault-test-"));
	roots.push(cwd);
	await mkdir(join(cwd, "locks"));
	await writeFile(join(cwd, "state.json"), JSON.stringify({ items: [], ...overrides }));
	const vault = new BitwardenUsIntakeVault({
		executable: execPath,
		argsPrefix: [fixture],
		env: { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd },
		cwd,
		organizationId: "org-synthetic",
		projectCollections: { [identity.projectId]: "collection-synthetic" },
		lockDirectory: join(cwd, "locks"),
	});
	return { cwd, vault };
}

async function audit(cwd: string): Promise<Array<Record<string, unknown>>> {
	const content = await readFile(join(cwd, "audit.jsonl"), "utf8").catch(() => "");
	return content.trim() ? content.trim().split("\n").map(line => JSON.parse(line)) : [];
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Bitwarden US intake vault", () => {
	test("sends the create payload over stdin and returns a read-verified item", async () => {
		const { cwd, vault } = await setup();
		const saved = await vault.saveVerified(identity, value);
		expect(saved).toEqual({ itemId: "item-synthetic" });
		await expect(vault.readVerified(identity, saved.itemId)).resolves.toBe(value);
		const records = await audit(cwd);
		const create = records.find(record => record.command === "create");
		expect(create).toMatchObject({ argvHasPayload: false, hasManualVaultDirectory: false, hasManualSession: false });
		expect(create?.secretHash).toMatch(/^[a-f0-9]{64}$/);
		expect(create?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
	});

	test("reuses an exact identity only after the matching hash and fresh exact-ID read", async () => {
		const { cwd, vault } = await setup();
		const saved = await vault.saveVerified(identity, value);
		await expect(vault.saveVerified(identity, value)).resolves.toEqual(saved);
		expect((await audit(cwd)).filter(record => record.command === "create")).toHaveLength(1);
	});

	test("refuses duplicate identity matches instead of creating or choosing one", async () => {
		const { cwd, vault } = await setup();
		await vault.saveVerified(identity, value);
		const state = JSON.parse(await readFile(join(cwd, "state.json"), "utf8"));
		state.items.push({ ...state.items[0], id: "item-duplicate" });
		await writeFile(join(cwd, "state.json"), JSON.stringify(state));
		await expect(vault.saveVerified(identity, value)).rejects.toThrow("Bitwarden intake vault-identity-mismatch");
		expect((await audit(cwd)).filter(record => record.command === "create")).toHaveLength(1);
	});

	test("fails closed on a nonzero list result before create", async () => {
		const { cwd, vault } = await setup({ listFails: true });
		await expect(vault.saveVerified(identity, value)).rejects.toThrow("Bitwarden intake vault-unavailable");
		expect((await audit(cwd)).map(record => record.command)).toEqual(["list"]);
	});

	test("does not create a duplicate after a successful create loses its response", async () => {
		const { cwd, vault } = await setup({ loseCreateOutput: true });
		await expect(vault.saveVerified(identity, value)).rejects.toThrow("Bitwarden intake vault-invalid-response");
		const state = JSON.parse(await readFile(join(cwd, "state.json"), "utf8"));
		state.loseCreateOutput = false;
		await writeFile(join(cwd, "state.json"), JSON.stringify(state));
		await expect(vault.saveVerified(identity, value)).resolves.toEqual({ itemId: "item-synthetic" });
		expect((await audit(cwd)).filter(record => record.command === "create")).toHaveLength(1);
	});

	test("refuses command expansion in wrapper metadata before starting a child", async () => {
		const { cwd } = await setup();
		const vault = new BitwardenUsIntakeVault({
			executable: execPath,
			windowsUsWrapper: true,
			env: {},
			cwd,
			organizationId: "org-synthetic",
			projectCollections: { [identity.projectId]: "collection&unexpected" },
			lockDirectory: join(cwd, "locks"),
		});
		await expect(vault.saveVerified(identity, value)).rejects.toThrow("Bitwarden intake vault-identity-mismatch");
		expect(await audit(cwd)).toEqual([]);
	});

	test("rejects wrong collection and wrong fresh item ID without exposing the canary", async () => {
		const wrongCollection = await setup({ wrongCollection: true });
		await expect(wrongCollection.vault.saveVerified(identity, value)).rejects.toThrow("Bitwarden intake vault-identity-mismatch");
		const wrongId = await setup({ badReadId: true });
		const failure = await wrongId.vault.saveVerified(identity, value).catch(error => error);
		expect(String(failure)).toBe("Error: Bitwarden intake vault-identity-mismatch");
		expect(String(failure)).not.toContain(value);
		expect(JSON.stringify(await audit(wrongId.cwd))).not.toContain(value);
	});
});
