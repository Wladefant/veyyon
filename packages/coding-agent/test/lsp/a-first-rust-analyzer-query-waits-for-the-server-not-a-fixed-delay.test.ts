/**
 * A first query to rust-analyzer waits for the server to finish loading, and for nothing else.
 *
 * WHY. Before a project-indexed query (definition, references, hover, …) on a Cargo file, the client
 * waits for rust-analyzer's workspace. It polled `rust-analyzer/analyzerStatus` and returned only once
 * a workspace was listed AND 2 seconds had passed since the poll began, so every first query paid 2
 * seconds even when the server had finished loading long before (a server started by warmup), and a
 * query on a project whose cache priming outlasted the 2 seconds was answered `content modified`.
 * rust-analyzer reports when its background work ends: `experimental/serverStatus` with
 * `quiescent: true`, sent to a client that advertises `experimental.serverStatusNotification`. The
 * client advertises it and waits for it.
 *
 * The class closed is a readiness wait that ends at a fixed delay instead of the server's own signal.
 * Every state a reporting server can be in when the query arrives is swept: quiescent already, busy and
 * becoming quiescent later, busy past the wait's timeout, and the caller aborting while it is busy. A
 * server that reports no status keeps the `analyzerStatus` poll, which still settles for its window. An
 * abort inside either wait returns rather than throws, the contract `waitForProjectLoaded` keeps for
 * every server; before, an abort landing between two polls threw.
 *
 * WHAT THIS DOES NOT CATCH. Whether a real rust-analyzer's `quiescent: true` coincides with the
 * moment it answers correctly; that was measured against rust-analyzer 1.97 directly and is not
 * re-measured here. A request the server answers `content modified` after it became ready (an edit
 * arriving mid-query) is not retried.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LspTool } from "@veyyon/coding-agent/lsp";
import * as lspClient from "@veyyon/coding-agent/lsp/client";
import * as lspConfig from "@veyyon/coding-agent/lsp/config";
import type { LspParams, ServerConfig } from "@veyyon/coding-agent/lsp/types";
import { fileToUri } from "@veyyon/coding-agent/lsp/utils";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { TempDir } from "@veyyon/utils";
import { driveFakeTime, installFakeTime } from "../../../utils/test/helpers/fake-time";
import { type FakeLspHandler, type FakeLspServer, installFakeLsp, type RpcMessage } from "../helpers/fake-lsp";
import { toolResultText } from "../helpers/tool-result-text";
import { makeToolSession } from "../helpers/tool-session";

const READY_TIMEOUT_MS = 5_000;
const SETTLE_MS = 2_000;
const SERVER: ServerConfig = {
	command: "rust-analyzer",
	resolvedCommand: process.execPath,
	fileTypes: ["rs"],
	rootMarkers: [],
};
const FOUND = /^Found 1 definition\(s\):\n {2}src\/util\.rs:1:8\n/;

/**
 * `reports`: whether the server sends `experimental/serverStatus`. `quiescentAtOpen`: its state when the
 * query's file opens. `quiescentAfterMs`: how long after the open a busy server becomes quiescent; absent,
 * it never does.
 */
interface Busy {
	readonly reports: boolean;
	readonly quiescentAtOpen: boolean;
	readonly quiescentAfterMs?: number;
}

/**
 * A rust-analyzer that ends its project-load progress right after initializing, reports
 * `experimental/serverStatus` when `busy.reports` says so, and answers a definition request with the
 * helper's location only once quiescent, as the real server does: before that a request is held and
 * answered `content modified`. While busy after the open it reports a second, still busy status before
 * the quiescent one, as rust-analyzer does when its health changes mid-load.
 */
function rustAnalyzer(busy: Busy, dir: string): FakeLspHandler {
	let quiescent = busy.quiescentAtOpen;
	const status = (server: FakeLspServer, health = "ok") => {
		if (busy.reports)
			server.send({ jsonrpc: "2.0", method: "experimental/serverStatus", params: { health, quiescent } });
	};
	return (message, server) => {
		switch (message.method) {
			case "initialize":
				server.send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true } } });
				server.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "fetch", value: { kind: "begin" } } });
				server.send({ jsonrpc: "2.0", method: "$/progress", params: { token: "fetch", value: { kind: "end" } } });
				return;
			case "initialized":
				status(server);
				return;
			case "textDocument/didOpen":
				if (quiescent) return;
				setTimeout(() => status(server, "warning"), 100);
				if (busy.quiescentAfterMs !== undefined) {
					setTimeout(() => {
						quiescent = true;
						status(server);
					}, busy.quiescentAfterMs);
				}
				return;
			case "rust-analyzer/analyzerStatus":
				server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: "Workspaces:\nLoaded 1 package across 1 workspace.",
				});
				return;
			case "textDocument/definition":
				if (!quiescent) {
					server.send({ jsonrpc: "2.0", id: message.id, error: { code: -32801, message: "content modified" } });
					return;
				}
				server.send({
					jsonrpc: "2.0",
					id: message.id,
					result: [
						{
							uri: fileToUri(path.join(dir, "src", "util.rs")),
							range: { start: { line: 0, character: 7 }, end: { line: 0, character: 13 } },
						},
					],
				});
				return;
			case "shutdown":
				server.send({ jsonrpc: "2.0", id: message.id, result: null });
				return;
			case "exit":
				server.exit(0);
				return;
		}
	};
}

function isStatusPoll(message: RpcMessage): boolean {
	return message.method === "rust-analyzer/analyzerStatus";
}

describe("a first rust-analyzer query", () => {
	const temps: TempDir[] = [];

	beforeAll(() => initTheme());

	afterEach(async () => {
		vi.useRealTimers();
		await lspClient.shutdownAll();
		vi.restoreAllMocks();
		for (const temp of temps.splice(0)) temp.removeSync();
	});

	/** A Cargo crate whose `main.rs` calls `util::helper`, checked by `server` alone. */
	function crate(): string {
		const temp = TempDir.createSync("@veyyon-lsp-ra-ready-");
		temps.push(temp);
		const dir = temp.path();
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.0.0"\n');
		fs.writeFileSync(path.join(dir, "src", "util.rs"), "pub fn helper() {}\n");
		fs.writeFileSync(path.join(dir, "src", "main.rs"), "mod util;\nfn main() {\n    util::helper();\n}\n");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
			servers: { "rust-analyzer": SERVER },
			idleTimeoutMs: undefined,
			missingServers: [],
		});
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["rust-analyzer", SERVER]]);
		return dir;
	}

	function definition(dir: string, signal?: AbortSignal): Promise<string> {
		const params: LspParams = { action: "definition", file: "src/main.rs", line: 3, symbol: "helper", timeout: 30 };
		return new LspTool(makeToolSession({ cwd: dir })).execute("lsp-definition", params, signal).then(toolResultText);
	}

	it("advertises the server status notification", async () => {
		const dir = crate();
		const server = installFakeLsp(rustAnalyzer({ reports: true, quiescentAtOpen: true }, dir));

		await definition(dir);

		const initialize = server.received.find(message => message.method === "initialize");
		expect(initialize?.params).toMatchObject({ capabilities: { experimental: { serverStatusNotification: true } } });
	});

	const STATES: Array<{
		readonly name: string;
		readonly busy: Busy;
		readonly found: boolean;
		readonly minMs: number;
		readonly maxMs: number;
	}> = [
		{
			name: "already quiescent answers at once",
			busy: { reports: true, quiescentAtOpen: true },
			found: true,
			minMs: 0,
			maxMs: 100,
		},
		{
			name: "quiescent 700ms after the open answers then, not at a fixed delay",
			busy: { reports: true, quiescentAtOpen: false, quiescentAfterMs: 700 },
			found: true,
			minMs: 700,
			maxMs: 800,
		},
		{
			name: "quiescent 3s after the open answers then, past the old 2s settle",
			busy: { reports: true, quiescentAtOpen: false, quiescentAfterMs: 3_000 },
			found: true,
			minMs: 3_000,
			maxMs: 3_100,
		},
		{
			name: "never quiescent gives up at the wait's timeout",
			busy: { reports: true, quiescentAtOpen: false },
			found: false,
			minMs: READY_TIMEOUT_MS,
			maxMs: READY_TIMEOUT_MS + 100,
		},
	];

	for (const state of STATES) {
		it(`to a server that reports its status and is ${state.name}`, async () => {
			const dir = crate();
			const server = installFakeLsp(rustAnalyzer(state.busy, dir));
			installFakeTime();
			const started = performance.now();

			const report = await driveFakeTime(definition(dir));
			const elapsed = performance.now() - started;

			if (state.found) expect(report).toMatch(FOUND);
			else expect(report).toBe("LSP error: content modified");
			expect(elapsed).toBeGreaterThanOrEqual(state.minMs);
			expect(elapsed).toBeLessThanOrEqual(state.maxMs);
			expect(server.received.filter(isStatusPoll)).toEqual([]);
		});
	}

	it("waits again on the next query after a wait that timed out", async () => {
		const dir = crate();
		installFakeLsp(
			rustAnalyzer({ reports: true, quiescentAtOpen: false, quiescentAfterMs: READY_TIMEOUT_MS + 2_000 }, dir),
		);
		installFakeTime();

		expect(await driveFakeTime(definition(dir))).toBe("LSP error: content modified");
		const started = performance.now();
		expect(await driveFakeTime(definition(dir))).toMatch(FOUND);
		const elapsed = performance.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(1_900);
		expect(elapsed).toBeLessThanOrEqual(2_100);
	});

	it("stops waiting when the caller aborts", async () => {
		const dir = crate();
		installFakeLsp(rustAnalyzer({ reports: true, quiescentAtOpen: false }, dir));
		installFakeTime();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const started = performance.now();

		const outcome = await driveFakeTime(
			definition(dir, controller.signal).then(
				() => "answered",
				(error: unknown) => (error instanceof Error ? error.name : String(error)),
			),
		);
		const elapsed = performance.now() - started;

		expect(outcome).toBe("ToolAbortError");
		expect(elapsed).toBeLessThanOrEqual(400);
	});

	// `waitForProjectLoaded` returns on an abort for every server kind (see
	// `waiting-for-project-load-does-not-accumulate-abort-listeners.test.ts`). These hold the
	// rust-analyzer wait to the same contract once it is entered, on both of its paths: the poll
	// spends most of its time sleeping between requests, so an abort lands in the sleep.
	for (const reports of [true, false]) {
		it(`returns rather than throws when the caller aborts inside the workspace wait of a server that ${reports ? "reports" : "reports no"} status`, async () => {
			const dir = crate();
			installFakeLsp(rustAnalyzer({ reports, quiescentAtOpen: false }, dir));
			installFakeTime();

			const { outcome, elapsed } = await driveFakeTime(
				(async () => {
					const client = await lspClient.getOrCreateClient(SERVER, dir);
					await lspClient.ensureFileOpen(client, path.join(dir, "src", "main.rs"));
					const controller = new AbortController();
					setTimeout(() => controller.abort(), 350);
					const started = performance.now();
					const outcome = await lspClient.waitForProjectLoaded(client, controller.signal).then(
						() => "returned",
						(error: unknown) => `threw ${error instanceof Error ? error.name : String(error)}`,
					);
					return { outcome, elapsed: performance.now() - started };
				})(),
			);

			expect(outcome).toBe("returned");
			expect(elapsed).toBeGreaterThanOrEqual(350);
			expect(elapsed).toBeLessThanOrEqual(450);
		});
	}

	it("to a server that reports no status still polls until a workspace is listed and the settle window passes", async () => {
		const dir = crate();
		const server = installFakeLsp(rustAnalyzer({ reports: false, quiescentAtOpen: true }, dir));
		installFakeTime();
		const started = performance.now();

		const report = await driveFakeTime(definition(dir));
		const elapsed = performance.now() - started;

		expect(report).toMatch(FOUND);
		expect(elapsed).toBeGreaterThanOrEqual(SETTLE_MS);
		expect(elapsed).toBeLessThanOrEqual(SETTLE_MS + 200);
		expect(server.received.filter(isStatusPoll).length).toBeGreaterThan(0);
	});
});
