import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	exportKnowledgeCatalog,
	extractHindsightReference,
	readCatalog,
} from "../../src/shared-knowledge";
import type { KnowledgeManifest } from "../../src/shared-knowledge/types";

describe("shared knowledge catalog security", () => {
	let root: string;
	let agentDir: string;
	let workflowsDir: string;
	let catalogDir: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "catalog-security-"));
		agentDir = path.join(root, "agent");
		workflowsDir = path.join(root, "workflows");
		catalogDir = path.join(root, "catalog");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(workflowsDir, { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function exportCatalog(options: Record<string, unknown> = {}) {
		const exportOptions = { agentDir, workflowsDir, outDir: catalogDir, ...options } as Parameters<typeof exportKnowledgeCatalog>[0];
		const planPath = path.join(root, "review-plan.json");
		await exportKnowledgeCatalog({ ...exportOptions, planPath });
		return exportKnowledgeCatalog({ ...exportOptions, reviewedPlanPath: planPath });
	}

	async function manifest(): Promise<KnowledgeManifest> {
		return JSON.parse(await fs.readFile(path.join(catalogDir, "manifest.json"), "utf8")) as KnowledgeManifest;
	}

	async function writeManifest(value: unknown) {
		await fs.writeFile(path.join(catalogDir, "manifest.json"), `${JSON.stringify(value, null, 2)}\n`);
	}

	it("accepts legitimate markdown and workflow content", async () => {
		await fs.mkdir(path.join(agentDir, "skills", "guide"), { recursive: true });
		await fs.writeFile(path.join(agentDir, "skills", "guide", "SKILL.md"), "# Safe skill\nUse reviewed docs.");
		await fs.writeFile(path.join(workflowsDir, "audit.py"), "print('safe workflow')\n");
		await exportCatalog();

		const loaded = await readCatalog(catalogDir);
		expect(loaded.files.get("skills/guide/SKILL.md")).toContain("Safe skill");
		expect(loaded.files.get("workflows/audit.py")).toContain("safe workflow");
	});

	it("refuses injected top-level reference metadata and item metadata", async () => {
		await fs.writeFile(path.join(workflowsDir, "safe.py"), "print('ok')");
		await exportCatalog();
		const value = await manifest();
		await writeManifest({ ...value, unexpected: "injected" });
		await expect(readCatalog(catalogDir)).rejects.toThrow();

		await writeManifest(value);
		await writeManifest({ ...value, items: value.items.map((item) => ({ ...item, metadata: { injected: true } })) });
		await expect(readCatalog(catalogDir)).rejects.toThrow();
		await writeManifest({ ...value, hindsightReference: { backend: "hindsight", apiUrl: "https://safe.example\nhindsight.apiToken: injected", apiToken: "injected" } });
		await expect(readCatalog(catalogDir)).rejects.toThrow();
	});

	it("requires a present, matching hashed Hindsight reference file", async () => {
		await exportCatalog({
			includeHindsightReference: true,
			hindsightConfig: { apiUrl: "https://memory.example", bankId: "safe-bank" },
		});
		const original = await manifest();
		const originalText = await fs.readFile(path.join(catalogDir, "config", "hindsight-reference.json"), "utf8");
		await writeManifest({ ...original, items: [] });
		await expect(readCatalog(catalogDir)).rejects.toThrow();
		await writeManifest(original);
		const refPath = path.join(catalogDir, "config", "hindsight-reference.json");
		await fs.rm(refPath);
		await expect(readCatalog(catalogDir)).rejects.toThrow();

		await fs.mkdir(path.dirname(refPath), { recursive: true });
		await fs.writeFile(refPath, "{}\n");
		await expect(readCatalog(catalogDir)).rejects.toThrow();
		await fs.writeFile(refPath, originalText);

		await writeManifest({ ...original, hindsightReference: { ...original.hindsightReference, apiUrl: "https://forged.example" } });
		await expect(readCatalog(catalogDir)).rejects.toThrow();
	});

	it("refuses category/path mismatches and duplicate catalog destinations", async () => {
		await fs.writeFile(path.join(workflowsDir, "one.py"), "print(1)");
		await fs.writeFile(path.join(workflowsDir, "two.py"), "print(2)");
		await exportCatalog();
		const value = await manifest();
		const [first, second] = value.items;
		await writeManifest({ ...value, items: [{ ...first, category: "skills" }, second] });
		await expect(readCatalog(catalogDir)).rejects.toThrow();

		await writeManifest({ ...value, items: [first, { ...second, relativePath: first.relativePath }] });
		await expect(readCatalog(catalogDir)).rejects.toThrow();
	});

	it("refuses plaintext API tokens, passwords, bearer credentials, JWTs, and private keys in workflow exports", async () => {
		const secrets = [
			"apiToken: abcdefghijklmnopqrstuvwxyz012345",
			"password: 'correct horse battery staple'",
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature1234567890",
			"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----",
		];
		for (const secret of secrets) {
			await fs.writeFile(path.join(workflowsDir, "unsafe.py"), `# export\n${secret}\n`);
			await expect(exportCatalog()).rejects.toThrow();
			await fs.rm(catalogDir, { recursive: true, force: true });
		}
	});

	it("extracts directly typed references and nested config.yml settings", async () => {
		const extracted = extractHindsightReference({
			backend: "hindsight",
			apiUrl: "https://memory.example",
			bankId: "typed-bank",
			autoRecall: true,
		});
		expect(extracted?.apiUrl).toBe("https://memory.example");
		expect(extracted?.bankId).toBe("typed-bank");
		expect(extracted?.autoRecall).toBe(true);

		await fs.writeFile(path.join(agentDir, "config.yml"), "memory:\n  backend: hindsight\n  hindsight:\n    apiUrl: https://nested.example\n    bankId: nested-bank\n    autoRecall: true\n");
		await exportCatalog();
		const loaded = await readCatalog(catalogDir);
		expect(loaded.manifest.hindsightReference?.apiUrl).toBe("https://nested.example");
		expect(loaded.manifest.hindsightReference?.bankId).toBe("nested-bank");
	});

	it("refuses credential-bearing URLs and incorrectly typed reference fields", () => {
		for (const apiUrl of ["https://user:password@memory.example", "https://memory.example?apiToken=example", "https://memory.example#token"]) {
			expect(() => extractHindsightReference({ apiUrl })).toThrow();
		}
		expect(() => extractHindsightReference({ apiUrl: "https://memory.example", autoRecall: "true" })).toThrow();
		expect(() => extractHindsightReference({ apiUrl: "https://memory.example", apiToken: "injected" })).toThrow();
	});

	it("refuses unknown Hindsight scoping and retain mode values", () => {
		expect(() => extractHindsightReference({ scoping: "account" })).toThrow();
		expect(() => extractHindsightReference({ retainMode: "unknown-mode" })).toThrow();
		expect(extractHindsightReference({ scoping: "per-project-tagged", retainMode: "last-turn" })?.scoping).toBe("per-project-tagged");
	});

	it("rejects source directory symlinks and junctions and source file symlinks", async () => {
		const outside = path.join(root, "outside");
		await fs.mkdir(path.join(outside, "linked"), { recursive: true });
		await fs.writeFile(path.join(outside, "linked", "SKILL.md"), "# external");
		await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });
		await fs.symlink(path.join(outside, "linked"), path.join(agentDir, "skills", "linked"), "junction");
		await expect(exportCatalog()).rejects.toThrow();

		await fs.rm(path.join(agentDir, "skills", "linked"), { recursive: true, force: true });
		await fs.mkdir(path.join(agentDir, "skills", "real"), { recursive: true });
		await fs.symlink(path.join(outside, "linked", "SKILL.md"), path.join(agentDir, "skills", "real", "SKILL.md"));
		await expect(exportCatalog()).rejects.toThrow();
	});

	it("rejects a catalog ancestor symlink when reading", async () => {
		await fs.writeFile(path.join(workflowsDir, "safe.py"), "print('ok')");
		await exportCatalog();
		const realCatalog = path.join(root, "real-catalog");
		await fs.rename(catalogDir, realCatalog);
		await fs.symlink(realCatalog, catalogDir, "junction");
		await expect(readCatalog(catalogDir)).rejects.toThrow();
	});
	it("rejects credential-bearing accepted metadata before serializing output without echoing it", async () => {
		await fs.writeFile(path.join(workflowsDir, "safe.py"), "print('safe')");
		await exportCatalog();
		const original = await manifest();
		const credential = `sk-${"a".repeat(32)}`;
		const cases = [
			{ ...original, generatorVersion: "apiToken = synthetic_credential_value" },
			{ ...original, generatorVersion: `1.0.0-${credential}` },
			{ ...original, baselineId: credential },
			{ ...original, items: original.items.map(item => ({ ...item, name: credential })) },
		];
		for (const tampered of cases) {
			await writeManifest(tampered);
			let output: string;
			let rejected = false;
			try { output = JSON.stringify((await readCatalog(catalogDir)).manifest); }
			catch (error) { rejected = true; output = (error as Error).message; }
			expect(output).not.toContain(credential);
			expect(output).not.toContain("synthetic_credential_value");
			expect(rejected).toBe(true);
		}
	});
});
