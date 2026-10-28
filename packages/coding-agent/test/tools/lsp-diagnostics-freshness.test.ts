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
import * as utils from "@veyyon/utils";
import { atomicWriteFileSync, type ptree, TempDir } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "../../../utils/test/helpers/fake-time";

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

/**
 * Fake time for a write driven by `driveFakeTime`, with the writethrough's disk commit run through the
 * blocking atomic writer.
 *
 * `driveFakeTime` advances fake time while the event loop waits, and the writethrough arms its 5000ms
 * operation budget before it commits to disk. An asynchronous commit that took a few hundred real
 * milliseconds spent that budget: the sync and the diagnostics wait were skipped and the write returned
 * undefined. A blocking commit holds the event loop, so it spends no fake time.
 */
function installFakeClock(): void {
	installFakeTime();
	vi.spyOn(utils, "atomicWriteFilePreservingMode").mockImplementation(async (filePath, data) =>
		atomicWriteFileSync(filePath, data, { fsync: false, mode: 0o644 }),
	);
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
		await writethrough(stylesPath, ".section {}\n", undefined, { id: "batch", flush: false });
		const result = await writethrough(tsPath, 'import styles from "./probe.module.scss";\n', undefined, {
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
		installFakeClock();

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
		installFakeClock();

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
		installFakeClock();

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
			writethrough(filePath, "export const value: number = 'x';\n", undefined, undefined, () => handle),
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
		installFakeClock();

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
			writethrough(filePath, "export const value: number = 'x';\n", undefined, undefined, () => handle),
		);

		expect(inline?.messages.some(m => m.includes("fast error"))).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("returns the write tool result before slow diagnostics and queues them for the agent", async () => {
		const filePath = path.join(tempDir.path(), "write-tool.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		installFakeClock();

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

/**
 * A server that offers `textDocument/diagnostic` and never publishes (tsgo) gave every write the whole
 * publish wait and then reported no diagnostics, so a write that broke the types read as clean. These
 * tests drive the write path against such a server and pin: the pulled report for the written version is
 * returned without the wait, a pull the server asks to have sent again is sent again, a pull that yields
 * no full report falls back to publishes after one request, and a pull that never answers ends at the
 * wait budget with no timer left armed. They do not cover a server that splits one file's diagnostics
 * between pulls and publishes: the first full report or version-matched publish wins.
 */
describe("LSP diagnostics from a server that answers pulls", () => {
	let tempDir: TempDir;
	let filePath: string;
	let uri: string;

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-lsp-pull-");
		filePath = path.join(tempDir.path(), "example.ts");
		uri = fileToUri(filePath);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		tempDir.removeSync();
	});

	function after<T>(ms: number, value: T): Promise<T> {
		const { promise, resolve } = Promise.withResolvers<T>();
		setTimeout(() => resolve(value), ms);
		return promise;
	}

	function failAfter(ms: number, error: Error): Promise<never> {
		const { promise, reject } = Promise.withResolvers<never>();
		setTimeout(() => reject(error), ms);
		return promise;
	}

	function fullReport(version: number): { kind: "full"; items: Diagnostic[] } {
		return { kind: "full", items: [createDiagnostic(`pulled error in version ${version}`)] };
	}

	/**
	 * Installs one server offering pulls. `answer` receives the document version the write synced and the
	 * zero-based attempt; `publish` runs when the file is saved. `pulls` counts the pulls sent and
	 * `firstPullAt` is the fake time of the first one: the write's real file I/O also advances fake time,
	 * so a wait is measured from the first pull, which is sent when the wait starts.
	 */
	function installPullServer(
		answer: (version: number, attempt: number) => Promise<unknown>,
		publish?: (client: LspClient) => void,
	): { client: LspClient; pulls: () => number; firstPullAt: () => number | undefined } {
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.serverCapabilities = { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } };
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		installFakeClock();
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined, missingServers: [] });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) openFile.version += 1;
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
			publish?.(mockClient);
		});
		let attempts = 0;
		let firstPullAt: number | undefined;
		vi.spyOn(lspClient, "sendRequest").mockImplementation(async (mockClient, method, params) => {
			if (method !== "textDocument/diagnostic") throw new Error(`unexpected request ${method}`);
			expect(params).toEqual({ textDocument: { uri } });
			firstPullAt ??= Date.now();
			return answer(mockClient.openFiles.get(uri)?.version ?? 0, attempts++);
		});
		return { client, pulls: () => attempts, firstPullAt: () => firstPullAt };
	}

	function write(content = "export const value: number = 'x';\n"): Promise<FileDiagnosticsResult | undefined> {
		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
		return driveFakeTime(writethrough(filePath, content));
	}

	it("returns the pulled report for the written version without waiting out the publish wait", async () => {
		const { client, firstPullAt } = installPullServer(version => after(30, fullReport(version)));
		const result = await write();

		// The publish path waited 3000ms and returned nothing; a report answered at 30ms is returned before
		// the 100ms poll interval ends.
		expect(Date.now() - (firstPullAt() ?? Number.NEGATIVE_INFINITY)).toBeLessThan(100);
		expect(result?.errored).toBe(true);
		expect(result?.messages.some(m => m.includes("pulled error in version 2"))).toBe(true);
		// Code actions read this cache for their diagnostic context.
		expect(client.diagnostics.get(uri)).toEqual({ diagnostics: fullReport(2).items, version: 2 });
		// The poll that the pull cut short leaves no timer behind to hold the event loop open.
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		[-32802, "ServerCancelled"],
		[-32801, "ContentModified"],
	])("sends the pull again when the server answers %p (%s)", async code => {
		const { pulls } = installPullServer((version, attempt) =>
			attempt === 0
				? failAfter(10, new lspClient.LspResponseError(code, "retrigger"))
				: after(10, fullReport(version)),
		);
		const result = await write();

		expect(result?.messages.some(m => m.includes("pulled error in version 2"))).toBe(true);
		expect(pulls()).toBe(2);
	});

	it.each([
		["a MethodNotFound error", () => failAfter(10, new lspClient.LspResponseError(-32601, "no such method"))],
		["a transport error", () => failAfter(10, new Error("LSP request textDocument/diagnostic timed out"))],
		["an unchanged report", () => after(10, { kind: "unchanged", resultId: "1" })],
		["a null answer", () => after(10, null)],
	])("falls back to publishes after one pull that yields %s", async (_label, answer) => {
		// The publish lands several poll intervals after the failed pull, so a pull sent again in between
		// is counted.
		const { pulls } = installPullServer(answer, client => {
			setTimeout(() => {
				publishDiagnostics(
					client,
					uri,
					[createDiagnostic("published error")],
					client.openFiles.get(uri)?.version ?? null,
				);
			}, 400);
		});
		const result = await write();

		expect(result?.messages.some(m => m.includes("published error"))).toBe(true);
		expect(pulls()).toBe(1);
	});

	it("ends at the wait budget with no timer armed when the pull never answers", async () => {
		const { firstPullAt } = installPullServer(() => Promise.withResolvers<never>().promise);
		const result = await write();
		const elapsed = Date.now() - (firstPullAt() ?? Number.NEGATIVE_INFINITY);

		expect(elapsed).toBeGreaterThanOrEqual(3000);
		expect(elapsed).toBeLessThan(3200);
		expect(result?.messages).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
