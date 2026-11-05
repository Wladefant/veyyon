/**
 * The first call to a project-aware language server waits for the server's project load, and for
 * nothing else.
 *
 * WHY. The wait ended only when the server's work-done progress ended, or after a 15s timeout. A
 * server that reports no progress (most of the defaults: JSON, YAML, Bash, Markdown, the fake below)
 * held its first diagnostics, hover, rename_file and post-write check for the whole 15s. tsserver
 * reports progress, but loads no project and so reports nothing until one of its files is open, and
 * two callers waited before opening one: the `diagnostics` action took 16s and `rename_file` took 15s
 * and then proposed no import edits, because tsserver still had no project to compute them from.
 *
 * The class closed is a project-load wait nothing but the timeout ends. Every surface that waits
 * (the `diagnostics` action, `rename_file`, `hover` for the preamble every project-indexed action
 * shares, and the post-write diagnostics) is driven against each kind of server: one that publishes
 * without reporting progress, one that does neither, one that creates its progress token inside the
 * 2s grace and begins reporting after it, and one that reports on a token it never created. The last
 * two load only once a file opens. Each case pins the server's answer and the time the first call
 * spent beyond a warm one, measured on a fake clock: under the publish for the first kind, under the
 * grace for the second, and the whole load, not less, for the loaders.
 *
 * WHAT THIS DOES NOT CATCH. A server that sends nothing about its load for more than the grace after
 * its first file opens is treated as loaded and asked early; nothing here models one. Surfaces are
 * listed by hand, so a new caller of `waitForProjectLoaded` arrives uncovered. rust-analyzer's
 * workspace wait is `lsp-regressions.test.ts`'s.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspTool } from "@veyyon/coding-agent/lsp";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { Diagnostic, LspParams, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { fileToUri } from "@veyyon/coding-agent/lsp/utils";
import { createLspWritethrough } from "@veyyon/coding-agent/lsp/writethrough";
import * as utils from "@veyyon/utils";
import { atomicWriteFileSync, TempDir } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "../../../utils/test/helpers/fake-time";
import { type FakeLspHandler, type FakeLspServer, installFakeLsp } from "../helpers/fake-lsp";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

const SERVER_NAME = "fake-ts";
const SERVER: ServerConfig = {
	command: SERVER_NAME,
	resolvedCommand: process.execPath,
	fileTypes: ["ts"],
	rootMarkers: [],
};

const SOURCE = "export function greet(name: string) {\n\treturn name;\n}\n";
const IMPORTER = 'import { greet } from "./app";\ngreet("a");\n';
const BAD: Diagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
	severity: 1,
	message: "bad value",
};

/** Every loader ends its load, and publishes, this long after its first file opens. */
const LOAD_MS = 4_000;

type ServerKind = "publishes" | "mute" | "createsTokenOnOpen" | "beginsOnOpen";
const SERVER_KINDS: Readonly<Record<ServerKind, string>> = {
	publishes: "publishes without reporting progress",
	mute: "neither publishes nor reports progress",
	createsTokenOnOpen: "creates its progress token once a file opens and begins reporting after the grace",
	beginsOnOpen: "reports progress on a token it never created once a file opens",
};

/** When, after its first file opens, each loader creates its progress token, if it does, and begins reporting. */
const LOADERS: Partial<Record<ServerKind, { readonly createAt?: number; readonly beginAt: number }>> = {
	createsTokenOnOpen: { createAt: 500, beginAt: 2_500 },
	beginsOnOpen: { beginAt: 500 },
};

interface Fixture {
	readonly dir: string;
	readonly file: string;
	readonly importer: string;
}

/**
 * A server of `kind`: `publishes` and `mute` have their project at once and report no progress, and
 * only `publishes` publishes diagnostics; a loader starts loading when its first file opens, and
 * answers nothing that needs the project until the load ends.
 */
function serverOf(kind: ServerKind, fixture: Fixture): FakeLspHandler {
	const loader = LOADERS[kind];
	let loaded = loader === undefined;
	let loading = false;
	const progress = (server: FakeLspServer, value: { kind: string }) =>
		server.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "load", value } });
	const publish = (server: FakeLspServer, uri: string) =>
		server.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [BAD] } });
	return (message, server) => {
		if (message.method === "exit") {
			server.exit(0);
			return;
		}
		if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
			const { uri } = (message.params as { textDocument: { uri: string } }).textDocument;
			if (kind === "mute") return;
			if (loaded) {
				publish(server, uri);
				return;
			}
			if (loading || !loader) return;
			loading = true;
			if (loader.createAt !== undefined) {
				setTimeout(() => {
					server.send({
						jsonrpc: "2.0",
						id: "load",
						method: "window/workDoneProgress/create",
						params: { token: "load" },
					});
				}, loader.createAt);
			}
			setTimeout(() => progress(server, { kind: "begin" }), loader.beginAt);
			setTimeout(() => {
				loaded = true;
				progress(server, { kind: "end" });
				publish(server, uri);
			}, LOAD_MS);
			return;
		}
		if (message.id === undefined || message.method === undefined) return;
		let result: unknown = null;
		if (message.method === "initialize") result = { capabilities: {} };
		else if (message.method === "textDocument/hover" && loaded) {
			result = { contents: { kind: "markdown", value: "function greet(name: string): string" } };
		} else if (message.method === "workspace/willRenameFiles" && loaded) {
			const importLine = { start: { line: 0, character: 22 }, end: { line: 0, character: 29 } };
			result = { changes: { [fileToUri(fixture.importer)]: [{ range: importLine, newText: '"./renamed"' }] } };
		}
		server.send({ jsonrpc: "2.0", id: message.id, result });
	};
}

/** A way into the project-load wait, run twice: the first call meets a cold server, the second a warm one. */
interface Surface {
	readonly name: string;
	call(fixture: Fixture, round: number): Promise<string>;
	/** What the call reports once the server has its project and has answered. */
	expected(kind: ServerKind): string;
}

function runTool(fixture: Fixture, params: LspParams): Promise<string> {
	return new LspTool(makeToolSession({ cwd: fixture.dir }))
		.execute(`lsp-${params.action}`, { ...params, timeout: 60 })
		.then(toolResultText);
}

const SURFACES: readonly Surface[] = [
	{
		name: "the diagnostics action",
		call: fixture => runTool(fixture, { action: "diagnostics", file: fixture.file }),
		expected: kind => (kind === "mute" ? "OK" : "1 error(s):\n# app.ts\n  1:1 [error] bad value"),
	},
	{
		name: "a rename_file preview",
		call: fixture =>
			runTool(fixture, { action: "rename_file", file: fixture.file, new_name: "renamed.ts", apply: false }),
		expected: () => `Rename preview: app.ts → renamed.ts\n  ${SERVER_NAME}:\n    main.ts: 1 edit`,
	},
	{
		name: "hover",
		call: fixture => runTool(fixture, { action: "hover", file: fixture.file, line: 1, symbol: "greet" }),
		expected: () => "function greet(name: string): string",
	},
	{
		name: "the diagnostics after a write",
		call: async (fixture, round) => {
			const write = createLspWritethrough(fixture.dir, { enableFormat: false, enableDiagnostics: true });
			const result = await write(fixture.file, `${SOURCE}// round ${round}\n`);
			const messages = result?.messages ?? [];
			return messages.length > 0 ? messages.join("\n") : "(none)";
		},
		expected: kind => (kind === "mute" ? "(none)" : "app.ts:1:1 [error] bad value"),
	},
];

/** The fake-clock milliseconds `work` took to settle, and what it settled to. */
async function timed(work: () => Promise<string>): Promise<{ ms: number; text: string }> {
	const start = performance.now();
	const text = await driveFakeTime(work());
	return { ms: performance.now() - start, text };
}

describe("a first lsp call", () => {
	const temps: TempDir[] = [];

	afterEach(async () => {
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		vi.useRealTimers();
		for (const temp of temps.splice(0)) temp.removeSync();
	});

	function fixture(): Fixture {
		const temp = TempDir.createSync("@veyyon-lsp-project-load-");
		temps.push(temp);
		const dir = temp.path();
		const file = path.join(dir, "app.ts");
		const importer = path.join(dir, "main.ts");
		fs.writeFileSync(file, SOURCE);
		fs.writeFileSync(importer, IMPORTER);
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { [SERVER_NAME]: SERVER },
			idleTimeoutMs: undefined,
			missingServers: [],
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([[SERVER_NAME, SERVER]]);
		// A blocking disk commit spends no fake time; an asynchronous one would spend the write's budget.
		vi.spyOn(utils, "atomicWriteFilePreservingMode").mockImplementation(async (filePath, data) =>
			atomicWriteFileSync(filePath, data, { fsync: false, mode: 0o644 }),
		);
		return { dir, file, importer };
	}

	for (const surface of SURFACES) {
		for (const [kind, described] of Object.entries(SERVER_KINDS) as Array<[ServerKind, string]>) {
			it(`through ${surface.name}, against a server that ${described}, waits for its load and no longer`, async () => {
				const target = fixture();
				installFakeLsp(serverOf(kind, target));
				installFakeTime();

				const cold = await timed(() => surface.call(target, 0));
				const warm = await timed(() => surface.call(target, 1));

				expect(cold.text).toBe(surface.expected(kind));
				expect(warm.text).toBe(surface.expected(kind));
				const spent = cold.ms - warm.ms;
				if (kind === "publishes") expect(spent).toBeLessThan(1_000);
				if (kind === "mute") expect(spent).toBeLessThan(3_000);
				if (LOADERS[kind]) {
					expect(spent).toBeGreaterThanOrEqual(LOAD_MS - 500);
					expect(spent).toBeLessThan(LOAD_MS + 1_500);
				}
			});
		}
	}
});
