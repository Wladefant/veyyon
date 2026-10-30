import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createProtectedCredentialReadPolicy } from "@veyyon/coding-agent/secrets/protected-resources";
import { ReadTool } from "@veyyon/coding-agent/tools/fs/read";
import { makeToolSession } from "../helpers/tool-session";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

test("ReadTool blocks protected credential files before any result sink while ordinary files remain readable", async () => {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "protected-read-"));
	directories.push(cwd);
	const credential = path.join(cwd, "workingcopy.json");
	const canary = "SYNTHETIC_CREDENTIAL_CANARY_73C01";
	const docs = path.join(cwd, "README.md");
	const source = path.join(cwd, "main.ts");
	const metadata = path.join(cwd, "credential-index.json");
	await fs.writeFile(credential, JSON.stringify({ token: canary }));
	await fs.writeFile(docs, "Synthetic documentation remains readable.\n");
	await fs.writeFile(source, "export const safe = true;\n");
	await fs.writeFile(
		metadata,
		JSON.stringify({ index_root: cwd, entries: [{ file: "workingcopy.json", classification: "credential" }] }),
	);

	const assertAllowed = await createProtectedCredentialReadPolicy([], [metadata]);
	const tool = new ReadTool(makeToolSession({ cwd, assertCredentialReadAllowed: assertAllowed }));
	// This separate unguarded production tool proves the same raw path leaks before the policy is wired.
	const unsafeTool = new ReadTool(makeToolSession({ cwd }));
	const unsafe = await unsafeTool.execute("unsafe-raw-control", { path: `${credential}:raw` });
	expect(JSON.stringify(unsafe)).toContain(canary);
	expect(JSON.stringify(unsafe.content)).toContain(canary);

	for (const [name, readPath] of [
		["plain", credential],
		["raw", `${credential}:raw`],
		["range", `${credential}:raw:1-1`],
	] as const) {
		let rejected: unknown;
		try {
			await tool.execute(`protected-${name}`, { path: readPath });
		} catch (error) {
			rejected = error;
		}
		expect(rejected, `${name} read must reject`).toBeDefined();
		expect(JSON.stringify(rejected)).not.toContain(canary);
	}

	const delimited = await tool.execute("protected-delimited", { path: `${docs};${credential}` });
	expect(JSON.stringify(delimited)).not.toContain(canary);
	expect(JSON.stringify(delimited)).toContain("protected credential");
	const docsResult = await tool.execute("read-docs", { path: docs });
	const sourceResult = await tool.execute("read-source", { path: source });
	const metadataResult = await tool.execute("read-metadata", { path: metadata });
	for (const result of [docsResult, sourceResult, metadataResult]) {
		expect(JSON.stringify(result)).not.toContain(canary);
	}
	expect(JSON.stringify(docsResult)).toContain("Synthetic documentation remains readable.");
	expect(JSON.stringify(sourceResult)).toContain("export const safe = true");
	expect(JSON.stringify(metadataResult)).toContain("workingcopy.json");

	// The guard applies only to ReadTool. A trusted direct consumer may still read the synthetic file.
	expect(JSON.parse(await fs.readFile(credential, "utf8")).token).toBe(canary);

	const alias = path.join(cwd, "credential-alias.json");
	try {
		await fs.symlink(credential, alias);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "ENOTSUP") return;
		throw error;
	}
	let aliasRejected: unknown;
	try {
		await tool.execute("protected-symlink", { path: alias });
	} catch (error) {
		aliasRejected = error;
	}
	expect(aliasRejected, "symlink alias read must reject").toBeDefined();
	expect(JSON.stringify(aliasRejected)).not.toContain(canary);
});
