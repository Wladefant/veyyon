/**
 * Contract: a write to a file whose server is a custom linter (a `createClient`
 * factory, as Biome and SwiftLint are configured) formats and lints through that
 * factory and never spawns the server's `command` as a language server, with
 * write-time formatting on or off. The didOpen/didChange sync and the didSave
 * notice go to LSP servers only.
 *
 * The server's command is a script that records being started, so a sync or
 * save notice that reached the linter's config shows up as a marker file.
 *
 * Gap: an LSP server sharing the file with the linter is not exercised here;
 * the freshness suite covers the LSP half of the write path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearLinterClientCache } from "@veyyon/coding-agent/lsp/clients";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { LinterClient, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { createLspWritethrough } from "@veyyon/coding-agent/lsp/writethrough";
import { TempDir } from "@veyyon/utils";

const FORMATTED_PREFIX = "// formatted\n";

const formattingLinter: LinterClient = {
	format: async (_filePath, content) => `${FORMATTED_PREFIX}${content}`,
	lint: async () => [],
};

describe("a write to a custom-linter file", () => {
	let tempDir: TempDir;
	let marker: string;
	const markerWritten = () =>
		fs.stat(marker).then(
			() => true,
			() => false,
		);

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-linter-not-lsp-");
		marker = path.join(tempDir.path(), "linter-started-as-lsp");
		const command = path.join(tempDir.path(), "fake-linter.sh");
		await fs.writeFile(command, `#!/bin/sh\necho started > '${marker}'\n`);
		await fs.chmod(command, 0o755);
		const linter: ServerConfig = {
			command,
			fileTypes: ["ts"],
			rootMarkers: [],
			createClient: () => formattingLinter,
		};
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["fake-linter", linter]]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearLinterClientCache();
		tempDir.removeSync();
	});

	it("formats through the linter and starts no language server when formatting is on", async () => {
		const filePath = path.join(tempDir.path(), "formatted.ts");
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: true, enableDiagnostics: true });

		await writethrough(filePath, "export const value = 1;\n");

		expect(await fs.readFile(filePath, "utf8")).toBe(`${FORMATTED_PREFIX}export const value = 1;\n`);
		expect(await markerWritten()).toBe(false);
	});

	it("writes the content as given and starts no language server when formatting is off", async () => {
		const filePath = path.join(tempDir.path(), "plain.ts");
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });

		await writethrough(filePath, "export const value = 2;\n");

		expect(await fs.readFile(filePath, "utf8")).toBe("export const value = 2;\n");
		expect(await markerWritten()).toBe(false);
	});
});
