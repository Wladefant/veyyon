import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { FileDiagnosticsResult } from "@veyyon/coding-agent/lsp/diagnostics";
import type { Diagnostic, LspClient, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { fileToUri } from "@veyyon/coding-agent/lsp/utils";
import { createLspWritethrough } from "@veyyon/coding-agent/lsp/writethrough";
import type { DeferredDiagnosticsEntry, ToolSession } from "@veyyon/coding-agent/tools";
import { WriteTool } from "@veyyon/coding-agent/tools/fs/write";
import { type ptree, TempDir } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "../helpers/fake-time";

const TEST_SERVER: ServerConfig = {
	command: "test-lsp",
	fileTypes: ["ts"],
	rootMarkers: [],
};

function createDiagnostic(message: string): Diagnostic {
	return {
		message,
		severity: 1,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
	};
}

function createClient(cwd: string, config: ServerConfig): LspClient {
	return {
		name: "test-lsp",
		cwd,
		config,
		proc: {} as ptree.ChildProcess<"pipe">,
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

function publishDiagnostics(client: LspClient, uri: string, diagnostics: Diagnostic[], version: number | null): void {
	client.diagnostics.set(uri, { diagnostics, version });
	client.diagnosticsVersion += 1;
}

describe("LSP diagnostics freshness", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-lsp-freshness-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		tempDir.removeSync();
	});

	it("announces watched-file creates even when no server owns the file type", async () => {
		const filePath = path.join(tempDir.path(), "probe.module.scss");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const notify = vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: false,
		});
		const result = await writethrough(filePath, ".section {}\n");

		expect(result).toBeUndefined();
		expect(await Bun.file(filePath).text()).toBe(".section {}\n");
		expect(notify).toHaveBeenCalledWith(
			tempDir.path(),
			[{ filePath, type: lspClient.FileChangeType.Created }],
			undefined,
		);
	});

	it("does not start an LSP server just to notify existing clients when write-time features are disabled", async () => {
		const filePath = path.join(tempDir.path(), "plain.ts");
		const loadConfig = vi
			.spyOn(lspConfig, "loadConfig")
			.mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		const getServers = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		const getOrCreate = vi
			.spyOn(lspClient, "getOrCreateClient")
			.mockRejectedValue(new Error("disabled write-time LSP features must not start a server"));
		const notify = vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: false,
		});
		const result = await writethrough(filePath, "export const value = 1;\n");

		expect(result).toBeUndefined();
		expect(await Bun.file(filePath).text()).toBe("export const value = 1;\n");
		expect(notify).toHaveBeenCalledWith(
			tempDir.path(),
			[{ filePath, type: lspClient.FileChangeType.Created }],
			undefined,
		);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(getServers).not.toHaveBeenCalled();
		expect(getOrCreate).not.toHaveBeenCalled();
	});

	it("announces batched sibling writes before syncing the diagnostic target", async () => {
		const stylesPath = path.join(tempDir.path(), "probe.module.scss");
		const tsPath = path.join(tempDir.path(), "probe.tsx");
		const tsUri = fileToUri(tsPath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		const events: string[] = [];
		const notifySignals: Array<AbortSignal | undefined> = [];

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockImplementation((_config, filePath) =>
			filePath.endsWith(".module.scss") ? [] : [["test-lsp", TEST_SERVER]],
		);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockImplementation(async (_cwd, changes, notifySignal) => {
			notifySignals.push(notifySignal);
			for (const change of changes) {
				events.push(`watched:${path.basename(change.filePath)}:${change.type}`);
			}
		});
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			events.push(`sync:${path.basename(syncedFilePath)}`);
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
			publishDiagnostics(mockClient, tsUri, [], mockClient.openFiles.get(tsUri)?.version ?? null);
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		await writethrough(stylesPath, ".section {}\n", undefined, undefined, { id: "batch", flush: false });
		const result = await writethrough(tsPath, 'import styles from "./probe.module.scss";\n', undefined, undefined, {
			id: "batch",
			flush: true,
		});

		expect(result?.summary).toBe("no issues");
		expect(events[0]).toBe(`watched:probe.module.scss:${lspClient.FileChangeType.Created}`);
		expect(notifySignals.some(signal => signal instanceof AbortSignal)).toBe(true);
		expect(events).toContain("sync:probe.tsx");
	});

	it("suppresses stale write diagnostics until the matching document version arrives", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		installFakeTime();

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			}
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("stale error")], null);
			}, 10);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [], mockClient.openFiles.get(savedUri)?.version ?? null);
			}, 150);
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		const result = await driveFakeTime(writethrough(filePath, "export const value = 2;\n"));

		expect(result).toBeDefined();
		expect(result?.messages).toEqual([]);
		expect(result?.summary).toBe("OK");
		expect(result?.errored).toBe(false);
		expect(await Bun.file(filePath).text()).toBe("export const value = 2;\n");
	});

	it("settles on the latest unversioned publish when the server never echoes a version", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		installFakeTime();

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			}
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("stale error")], null);
			}, 10);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("real error")], null);
			}, 150);
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		const result = await driveFakeTime(writethrough(filePath, "export const value: number = 'x';\n"));

		expect(result).toBeDefined();
		expect(result?.errored).toBe(true);
		expect(result?.messages.some(m => m.includes("real error"))).toBe(true);
		expect(result?.messages.some(m => m.includes("stale error"))).toBe(false);
	});

	it("returns promptly and delivers diagnostics via the deferred channel when the server is slow", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		installFakeTime();

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			}
		});
		// Publish far past the 500ms inline budget (INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS)
		// so the writethrough deterministically defers; fake time keeps it instant.
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("deferred error")], null);
			}, 2000);
		});

		const late = Promise.withResolvers<FileDiagnosticsResult>();
		const handle = {
			onDeferredDiagnostics: (d: FileDiagnosticsResult) => late.resolve(d),
			signal: new AbortController().signal,
			finalize: () => {},
		};

		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
		const inline = await driveFakeTime(
			writethrough(filePath, "export const value: number = 'x';\n", undefined, undefined, undefined, () => handle),
		);

		// Inline returns undefined: the writethrough deferred rather than blocking on
		// the slow publish. A result fresh within the inline budget would be returned
		// inline, so `undefined` is proof it returned promptly via the deferred path.
		expect(inline).toBeUndefined();

		// ...and the diagnostics arrive afterwards via the deferred channel.
		const lateResult = await driveFakeTime(late.promise);
		expect(lateResult.errored).toBe(true);
		expect(lateResult.messages.some(m => m.includes("deferred error"))).toBe(true);

		// The edit still landed on disk regardless of diagnostics timing.
		expect(await Bun.file(filePath).text()).toBe("export const value: number = 'x';\n");
	});

	// The inline budget used to be `Bun.sleep(500)` raced against the fetch: when the server answered
	// first, the sleep stayed armed for the rest of the budget and held the event loop open after the
	// edit returned. Pending fake timers count that sleep (Bun.sleep is routed onto a fake setTimeout).
	it("leaves no timer armed when the server answers inside the inline budget", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		installFakeTime();

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) openFile.version += 1;
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			setTimeout(() => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("fast error")], null);
			}, 20);
		});
		const handle = {
			onDeferredDiagnostics: () => {},
			signal: new AbortController().signal,
			finalize: () => {},
		};

		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
		const inline = await driveFakeTime(
			writethrough(filePath, "export const value: number = 'x';\n", undefined, undefined, undefined, () => handle),
		);

		expect(inline?.messages.some(m => m.includes("fast error"))).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns the write tool result before slow diagnostics and queues them for the agent", async () => {
		const filePath = path.join(tempDir.path(), "write-tool.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		installFakeTime();

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
			setTimeout(() => {
				publishDiagnostics(mockClient, uri, [createDiagnostic("write tool deferred error")], null);
			}, 2000);
		});

		const queued = Promise.withResolvers<DeferredDiagnosticsEntry>();
		const mutationVersions = new Map<string, number>();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"lsp.enabled": true,
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": true,
				"lsp.diagnosticsDeduplicate": true,
			}),
			enableLsp: true,
			queueDeferredDiagnostics: entry => queued.resolve(entry),
			bumpFileMutationVersion: target => {
				const version = (mutationVersions.get(target) ?? 0) + 1;
				mutationVersions.set(target, version);
				return version;
			},
			getFileMutationVersion: target => mutationVersions.get(target) ?? 0,
		};

		const result = await driveFakeTime(
			new WriteTool(session).execute("write-deferred", {
				path: filePath,
				content: "export const value: number = 'x';\n",
			}),
		);

		expect(result.details?.diagnostics).toBeUndefined();
		const late = await driveFakeTime(queued.promise);
		expect(late.isStale()).toBe(false);
		expect(late.errored).toBe(true);
		expect(late.messages.some(message => message.includes("write tool deferred error"))).toBe(true);
		expect(await Bun.file(filePath).text()).toBe("export const value: number = 'x';\n");
	});

	it("suppresses TypeScript project diagnostics for orphan files but keeps syntax errors", async () => {
		const server: ServerConfig = {
			...TEST_SERVER,
			rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
		};
		const orphanDir = TempDir.createSync("@veyyon-lsp-orphan-");
		try {
			const filePath = path.join(orphanDir.path(), "scratch.ts");
			const uri = fileToUri(filePath);
			const client = createClient(tempDir.path(), server);
			client.openFiles.set(uri, { version: 1, languageId: "typescript" });

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "typescript-language-server": server },
				idleTimeoutMs: undefined,
				missingServers: [],
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["typescript-language-server", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
				const syncedUri = fileToUri(syncedFilePath);
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			});
			vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
				const moduleDiagnostic = createDiagnostic(
					"Cannot find module 'bun:sqlite' or its corresponding type declarations.",
				);
				moduleDiagnostic.code = 2307;
				const bunDiagnostic = createDiagnostic(
					"Cannot find name 'Bun'. Do you need to install type definitions for Bun?",
				);
				bunDiagnostic.code = 2867;
				const syntaxDiagnostic = createDiagnostic("';' expected.");
				syntaxDiagnostic.code = 1005;
				mockClient.diagnostics.set(uri, {
					version: 1,
					diagnostics: [moduleDiagnostic, bunDiagnostic, syntaxDiagnostic],
				});
				mockClient.diagnosticsVersion += 1;
			});

			const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
			const result = await writethrough(filePath, 'import { Database } from "bun:sqlite";\nawait Bun.sleep(1)\n');

			expect(result).toBeDefined();
			expect(result?.errored).toBe(true);
			expect(result?.messages.some(message => message.includes("bun:sqlite"))).toBe(false);
			expect(result?.messages.some(message => message.includes("Cannot find name 'Bun'"))).toBe(false);
			expect(result?.messages.some(message => message.includes("';' expected."))).toBe(true);
			expect(await Bun.file(filePath).text()).toBe('import { Database } from "bun:sqlite";\nawait Bun.sleep(1)\n');
		} finally {
			orphanDir.removeSync();
		}
	});
});
