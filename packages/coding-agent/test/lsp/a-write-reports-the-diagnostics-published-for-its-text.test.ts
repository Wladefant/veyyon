/**
 * A write reports the diagnostics its server published for the text it wrote.
 *
 * WHY. A write syncs its text to the server, commits it to disk, then announces the disk change with
 * `workspace/didChangeWatchedFiles`, and that announcement dropped the cached diagnostics of every file
 * it named. A server that published for the synced text before the announcement had its answer
 * discarded: the write waited out its whole diagnostics budget and reported the file clean, or, with a
 * deferred channel, reported nothing for 12s. An open document's diagnostics follow the text synced to
 * the server, which a change on disk does not touch, so the announcement now keeps them and drops only
 * those of files the server does not have open.
 *
 * The class closed is a disk-change announcement discarding diagnostics for synced text. The
 * announcement is the one place the cache is dropped for a change on disk, so it is pinned there for
 * every `FileChangeType`, open and closed, and once end to end through a write that opens its file and
 * writes that change it, against a server that publishes the moment it receives the text.
 *
 * WHAT THIS DOES NOT CATCH. A server that republishes only on save is not modelled, and neither is a
 * caller that announces a change to an open document whose new text it never synced; that document's
 * diagnostics describe the text the server holds, and are kept.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { Diagnostic, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { fileToUri } from "@veyyon/coding-agent/lsp/utils";
import { createLspWritethrough } from "@veyyon/coding-agent/lsp/writethrough";
import * as utils from "@veyyon/utils";
import { atomicWriteFileSync, TempDir } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "../../../utils/test/helpers/fake-time";
import { type FakeLspServer, installFakeLsp } from "../helpers/fake-lsp";

const SERVER_NAME = "fake-ts";
const SERVER: ServerConfig = {
	command: SERVER_NAME,
	resolvedCommand: process.execPath,
	fileTypes: ["ts"],
	rootMarkers: [],
};

const BAD: Diagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	severity: 1,
	message: "bad value",
};

/**
 * A server with its project at once that, when `publishes`, publishes as it receives each text: `BAD` for a
 * text containing "bad", nothing for any other.
 */
function installServer(publishes: boolean): FakeLspServer {
	return installFakeLsp((message, server) => {
		if (message.method === "exit") {
			server.exit(0);
			return;
		}
		if (publishes && (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange")) {
			const params = message.params as {
				textDocument: { uri: string; text?: string };
				contentChanges?: Array<{ text: string }>;
			};
			const text = params.textDocument.text ?? params.contentChanges?.[0]?.text ?? "";
			server.send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: { uri: params.textDocument.uri, diagnostics: text.includes("bad") ? [BAD] : [] },
			});
			return;
		}
		if (message.id === undefined || message.method === undefined) return;
		server.send({
			jsonrpc: "2.0",
			id: message.id,
			result: message.method === "initialize" ? { capabilities: {} } : null,
		});
	});
}

describe("a write's diagnostics", () => {
	const temps: TempDir[] = [];

	afterEach(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		vi.useRealTimers();
		for (const temp of temps.splice(0)) temp.removeSync();
	});

	function workspace(): string {
		const temp = TempDir.createSync("@veyyon-lsp-write-diagnostics-");
		temps.push(temp);
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { [SERVER_NAME]: SERVER },
			idleTimeoutMs: undefined,
			missingServers: [],
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([[SERVER_NAME, SERVER]]);
		return temp.path();
	}

	it("are what the server published for the written text, on the write that opens the file and on each after", async () => {
		const dir = workspace();
		const file = path.join(dir, "app.ts");
		fs.writeFileSync(file, "export const value = 0;\n");
		installServer(true);
		installFakeTime();
		// A blocking disk commit spends no fake time; an asynchronous one would spend the write's budget.
		vi.spyOn(utils, "atomicWriteFilePreservingMode").mockImplementation(async (filePath, data) =>
			atomicWriteFileSync(filePath, data, { fsync: false, mode: 0o644 }),
		);
		const write = createLspWritethrough(dir, { enableFormat: false, enableDiagnostics: true });

		const reports: string[] = [];
		for (const text of ["export const value = bad;\n", "export const value = 1;\n", "export const value = bad;\n"]) {
			const result = await driveFakeTime(write(file, text));
			reports.push([result?.summary, ...(result?.messages ?? [])].join("\n"));
		}

		expect(reports).toEqual([
			"1 error(s)\napp.ts:1:1 [error] bad value",
			"OK",
			"1 error(s)\napp.ts:1:1 [error] bad value",
		]);
	});

	for (const type of Object.values(lspClient.FileChangeType).filter(value => typeof value === "number")) {
		it(`survive an announcement that the open file was ${lspClient.FileChangeType[type]}, and a closed file's do not`, async () => {
			const dir = workspace();
			const open = path.join(dir, "open.ts");
			const closed = path.join(dir, "closed.ts");
			const server = installServer(false);
			const client = await lspClient.getOrCreateClient(SERVER, dir);
			await lspClient.syncContent(client, open, "export const value = bad;\n");
			await server.waitFor(message => message.method === "textDocument/didOpen");
			const published = { diagnostics: [BAD], version: null };
			lspClient.recordPublishedDiagnostics(client, fileToUri(open), published);
			lspClient.recordPublishedDiagnostics(client, fileToUri(closed), published);

			await lspClient.notifyWorkspaceWatchedFiles(dir, [
				{ filePath: open, type },
				{ filePath: closed, type },
			]);

			expect(client.diagnostics.get(fileToUri(open))).toBe(published);
			expect(client.diagnostics.has(fileToUri(closed))).toBe(false);
			const announced = await server.waitFor(message => message.method === "workspace/didChangeWatchedFiles");
			expect(announced.params).toEqual({
				changes: [
					{ uri: fileToUri(open), type },
					{ uri: fileToUri(closed), type },
				],
			});
		});
	}
});
